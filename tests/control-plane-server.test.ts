import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, makeTmpDir, write } from "./helpers.js";

/**
 * End-to-end: spawn `awemind control-plane --workspace <tmp>` as a real
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
    env: { ...process.env, AWEMIND_STATE_DIR: stateDir },
  });
  client = new Client({ name: "cp-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

describe("control-plane MCP server (stdio)", () => {
  it("lists the four semantic tools", async () => {
    const c = await connect();
    const tools = await c.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "awemind_open_chat",
        "awemind_send_state",
        "awemind_wait_reply",
        "awemind_read_reply",
        "awemind_chat_info",
      ])
    );
  });

  it("rejects messages that are not [C2C] control messages", async () => {
    const c = await connect();
    const result = await c.callTool({ name: "awemind_send_state", arguments: { message: "hello there" } });
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    expect(payload.error).toBe("INVALID_MESSAGE");
  });

  it("rejects oversized control messages", async () => {
    const c = await connect();
    const result = await c.callTool({
      name: "awemind_send_state",
      arguments: { message: `[C2C]\nSTATE: INIT\n${"x".repeat(3000)}` },
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    expect(payload.error).toBe("INVALID_MESSAGE");
  });

  it("answers chat_info with the saved binding (null when unset)", async () => {
    const c = await connect();
    const result = await c.callTool({ name: "awemind_chat_info", arguments: {} });
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    expect(payload.chatUrl).toBeNull();
  });
});
