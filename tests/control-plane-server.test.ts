import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlaneBrowser } from "../src/control-plane/browser.js";
import { createControlPlaneServer } from "../src/control-plane/server.js";
import { writeSession } from "../src/session/state.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

/**
 * End-to-end: spawn `awehitch control-plane --workspace <tmp>` as a real
 * stdio MCP server and talk MCP to it. The browser is only launched lazily
 * (open/send), which these tests avoid — they verify the protocol surface:
 * tool list, [C2C] validation, and JSON error shapes.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let workDir: string;
let stateDir: string;
let client: Client | null = null;
let transport: StdioClientTransport | null = null;

beforeEach(() => {
  workDir = makeTmpDir("cp-server-workspace");
  write(workDir, "hello.txt", "hello\n");
  stateDir = makeTmpDir("cp-server-state");
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = null;
  transport = null;
  cleanup(workDir);
  cleanup(stateDir);
});

async function connect(): Promise<Client> {
  const entry = path.join(projectRoot, "src", "control-plane", "entry-for-tests.ts");
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", entry, "--workspace", workDir],
    env: { ...process.env, AWEHITCH_STATE_DIR: stateDir },
  });
  client = new Client({ name: "cp-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

describe("control-plane MCP server (stdio)", () => {
  it("lists the five semantic tools", async () => {
    const c = await connect();
    const tools = await c.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "awehitch_open_chat",
        "awehitch_send_state",
        "awehitch_send_handoff",
        "awehitch_wait_reply",
        "awehitch_read_reply",
        "awehitch_chat_info",
      ])
    );
  });

  it("rejects messages that are not [C2C] control messages", async () => {
    const c = await connect();
    const result = await c.callTool({ name: "awehitch_send_state", arguments: { message: "hello there" } });
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    expect(payload.error).toBe("INVALID_MESSAGE");
  });

  it("rejects oversized control messages", async () => {
    const c = await connect();
    const result = await c.callTool({
      name: "awehitch_send_state",
      arguments: { message: `[C2C]\nSTATE: INIT\n${"x".repeat(3000)}` },
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    expect(payload.error).toBe("INVALID_MESSAGE");
  });

  it("rejects control messages over 1 KB (1024 bytes)", async () => {
    const c = await connect();
    const base = "[C2C]\nSTATE: INIT\n";
    const message = base + "x".repeat(1025 - Buffer.byteLength(base));
    expect(Buffer.byteLength(message)).toBe(1025);
    // Rejected by validation, before any browser is launched.
    const result = await c.callTool({ name: "awehitch_send_state", arguments: { message } });
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    expect(payload.error).toBe("INVALID_MESSAGE");
  });

  it("answers chat_info with the saved binding (null when unset)", async () => {
    const c = await connect();
    const result = await c.callTool({ name: "awehitch_chat_info", arguments: {} });
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    expect(payload.chatUrl).toBeNull();
  });

  it("refuses send_handoff without a checkpoint (nothing to resume)", async () => {
    const c = await connect();
    const result = await c.callTool({ name: "awehitch_send_handoff", arguments: {} });
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    expect(payload.error).toBe("NO_CHECKPOINT");
  });
});

/**
 * In-process suite with a recording driver: verifies tool wiring without
 * launching a browser.
 */
class RecordingDriver extends ControlPlaneBrowser {
  opened: { chatUrl?: string; opts: { taskId?: string; fresh?: boolean } }[] = [];
  sent: string[] = [];

  constructor() {
    super("fake-ws", {});
  }

  override async openConversation(
    chatUrl?: string,
    opts: { taskId?: string; fresh?: boolean } = {}
  ): Promise<string> {
    this.opened.push({ chatUrl, opts });
    return chatUrl ?? "https://chatgpt.com/";
  }

  override async sendMessage(text: string): Promise<{ sent: boolean; url: string }> {
    this.sent.push(text);
    return { sent: true, url: "https://chatgpt.com/c/fake" };
  }

  override async readReply() {
    return { status: "replied" as const, text: null, isControlMessage: false, state: null };
  }

  override async waitReply() {
    return this.readReply();
  }
}

describe("control-plane MCP server (in-process, fake driver)", () => {
  let fakeStateDir: string;

  beforeEach(() => {
    fakeStateDir = makeTmpDir("cp-server-fake-state");
    process.env.AWEHITCH_STATE_DIR = fakeStateDir;
  });

  afterEach(() => {
    cleanup(fakeStateDir);
    delete process.env.AWEHITCH_STATE_DIR;
  });

  async function connectFake(driver: RecordingDriver): Promise<Client> {
    const server = await createControlPlaneServer({
      workspaceRoot: workDir,
      workspaceId: "fake-ws",
      driver,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "cp-test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  it("forwards task_id and fresh to the driver", async () => {
    const driver = new RecordingDriver();
    const c = await connectFake(driver);
    const result = await c.callTool({
      name: "awehitch_open_chat",
      arguments: { task_id: "c2c_t9", fresh: true },
    });
    expect(result.isError).toBeFalsy();
    expect(driver.opened).toEqual([{ chatUrl: undefined, opts: { taskId: "c2c_t9", fresh: true } }]);
    await c.close().catch(() => undefined);
  });

  it("send_handoff composes the brief from the checkpoint and sends it", async () => {
    writeSession("fake-ws", {
      savedAt: "2026-01-01T00:00:00.000Z",
      checkpoint: {
        taskId: "c2c_t12",
        iteration: 3,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        originalGoal: "Implement dark mode.",
        knownIssues: "Toggle flashes on load.",
        nextExpectedStep: "Review iteration 3 via git_diff.",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const driver = new RecordingDriver();
    const c = await connectFake(driver);
    const result = await c.callTool({ name: "awehitch_send_handoff", arguments: {} });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.taskId).toBe("c2c_t12");
    expect(payload.message).toContain("STATE: HANDOFF");
    expect(payload.message).toContain("ORIGINAL_GOAL:\nImplement dark mode.");
    expect(driver.sent).toEqual([payload.message]);
    await c.close().catch(() => undefined);
  });
});
