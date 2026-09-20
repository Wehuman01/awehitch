import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

let writeRoot: string;
let execRoot: string;
let bridge: Bridge;
let client: Client;
let writeWs: { name: string; id: string };
let execWs: { name: string; id: string };

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

function call(name: string, arguments_: Record<string, unknown>): Promise<{ isError?: boolean; content?: unknown }> {
  return client.callTool({ name, arguments: arguments_ }) as Promise<{ isError?: boolean; content?: unknown }>;
}

beforeAll(async () => {
  isolateStateDir();
  writeRoot = makeTmpDir("mode-write");
  write(writeRoot, ".c2c.json", JSON.stringify({ name: "write-ws", chatgptMode: "write" }));
  write(writeRoot, "src/index.ts", "export const answer = 42;\n");
  execRoot = makeTmpDir("mode-exec");
  write(execRoot, ".c2c.json", JSON.stringify({ name: "exec-ws", chatgptMode: "write-exec" }));
  write(execRoot, "src/index.ts", "export const answer = 42;\n");

  bridge = await startBridge({
    workspaceRoots: [writeRoot, execRoot],
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
  });
  writeWs = { name: "write-ws", id: bridge.workspaces[0].id };
  execWs = { name: "exec-ws", id: bridge.workspaces[1].id };

  const tokens = bridge.authStore.issueTokens({
    clientId: "mode-client",
    scopes: ["workspace.read", "workspace.write", "exec.run"],
  });
  client = new Client({ name: "mode-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  cleanup(writeRoot);
  cleanup(execRoot);
});

describe("chatgptMode write tools", () => {
  it("advertises apply_patch and run_command when a workspace enables them", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("apply_patch");
    expect(names).toContain("run_command");
  });

  it("apply_patch creates, updates and deletes atomically", async () => {
    const created = jsonOf<{ applied: { path: string }[] }>(
      await call("apply_patch", {
        workspace: writeWs.name,
        edits: [{ path: "docs/new.md", action: "create", newText: "# hello\n" }],
      })
    );
    expect(created.applied[0].path).toBe("docs/new.md");
    expect(fs.readFileSync(path.join(writeRoot, "docs/new.md"), "utf8")).toBe("# hello\n");

    const updated = jsonOf<{ applied: { action: string }[] }>(
      await call("apply_patch", {
        workspace: writeWs.name,
        edits: [{ path: "src/index.ts", action: "update", oldText: "42", newText: "43" }],
      })
    );
    expect(updated.applied[0].action).toBe("update");
    expect(fs.readFileSync(path.join(writeRoot, "src/index.ts"), "utf8")).toBe("export const answer = 43;\n");

    const deleted = jsonOf<{ applied: { action: string }[] }>(
      await call("apply_patch", {
        workspace: writeWs.name,
        edits: [{ path: "docs/new.md", action: "delete" }],
      })
    );
    expect(deleted.applied[0].action).toBe("delete");
    expect(fs.existsSync(path.join(writeRoot, "docs/new.md"))).toBe(false);
  });

  it("apply_patch refuses stale edits and rolls the whole patch back", async () => {
    write(writeRoot, "other.txt", "current content\n");
    const before = fs.readFileSync(path.join(writeRoot, "src/index.ts"), "utf8");
    const result = await call("apply_patch", {
      workspace: writeWs.name,
      edits: [
        { path: "src/index.ts", action: "update", oldText: "43", newText: "44" },
        { path: "other.txt", action: "update", oldText: "stale baseline", newText: "x" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("BASELINE_MISMATCH");
    // nothing from the patch landed
    expect(fs.readFileSync(path.join(writeRoot, "src/index.ts"), "utf8")).toBe(before);
    expect(fs.readFileSync(path.join(writeRoot, "other.txt"), "utf8")).toBe("current content\n");
  });

  it("apply_patch denies sensitive files for writes too", async () => {
    const result = await call("apply_patch", {
      workspace: writeWs.name,
      edits: [{ path: ".env", action: "create", newText: "LEAKED=1\n" }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ACCESS_DENIED_SENSITIVE_FILE");
  });

  it("apply_patch requires an ambiguous-free baseline", async () => {
    write(writeRoot, "dup.txt", "same\nsame\n");
    const result = await call("apply_patch", {
      workspace: writeWs.name,
      edits: [{ path: "dup.txt", action: "update", oldText: "same", newText: "other" }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("BASELINE_MISMATCH");
  });

  it("run_command is denied on a write-only workspace (MODE_DISABLED)", async () => {
    const result = await call("run_command", {
      workspace: writeWs.name,
      command: ["cat", "src/index.ts"],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("MODE_DISABLED");
  });

  it("run_command runs argv without a shell on the write-exec workspace", async () => {
    const result = jsonOf<{ exitCode: number | null; stdout: string }>(
      await call("run_command", {
        workspace: execWs.name,
        command: ["node", "-e", "console.log('direct')"],
      })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("direct");
  });

  it("run_command denies network and privilege clients", async () => {
    for (const command of [["curl", "http://example.com"], ["sudo", "rm", "-rf", "/"]]) {
      const result = await call("run_command", { workspace: execWs.name, command });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("COMMAND_DENIED");
    }
  });

  it("run_command denies git's network subcommands", async () => {
    const result = await call("run_command", { workspace: execWs.name, command: ["git", "push"] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMMAND_DENIED");
  });

  it("run_command leaks no environment secrets", async () => {
    process.env.C2C_TEST_SECRET = "supersecret-value";
    try {
      const result = jsonOf<{ stdout: string; exitCode: number | null }>(
        await call("run_command", {
          workspace: execWs.name,
          command: ["node", "-e", "console.log(process.env.C2C_TEST_SECRET ?? 'clean')"],
        })
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("clean");
    } finally {
      delete process.env.C2C_TEST_SECRET;
    }
  });
});

describe("chatgptMode default (direct mode)", () => {
  it("a workspace with no chatgptMode gets the write-exec default", async () => {
    const defaultRoot = makeTmpDir("mode-default");
    write(defaultRoot, ".c2c.json", JSON.stringify({ name: "def-ws" }));
    const defBridge = await startBridge({
      workspaceRoots: [defaultRoot],
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth-def"), "store.json"),
    });
    const tokens = defBridge.authStore.issueTokens({ clientId: "def-client", scopes: ["workspace.read", "workspace.write", "exec.run"] });
    const defClient = new Client({ name: "def-test-client", version: "1.0.0" });
    await defClient.connect(
      new StreamableHTTPClientTransport(new URL(`${defBridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
      })
    );
    try {
      const { tools } = await defClient.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("apply_patch");
      expect(names).toContain("run_command");
      const listed = JSON.parse(
        (await defClient.callTool({ name: "list_workspaces", arguments: {} })).content?.[0]?.text ?? "{}"
      ) as { workspaces: { chatgptMode: string }[] };
      expect(listed.workspaces[0].chatgptMode).toBe("write-exec");
    } finally {
      await defClient.close();
      await defBridge.close();
      cleanup(defaultRoot);
    }
  });

  it("an explicit readonly opts out; a scope grant alone still writes nothing", async () => {
    const readonlyRoot = makeTmpDir("mode-readonly");
    write(readonlyRoot, ".c2c.json", JSON.stringify({ name: "ro-ws", chatgptMode: "readonly" }));
    const roBridge = await startBridge({
      workspaceRoots: [readonlyRoot],
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth-ro"), "store.json"),
    });
    const tokens = roBridge.authStore.issueTokens({ clientId: "ro-client", scopes: ["workspace.read", "workspace.write", "exec.run"] });
    const roClient = new Client({ name: "ro-test-client", version: "1.0.0" });
    await roClient.connect(
      new StreamableHTTPClientTransport(new URL(`${roBridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
      })
    );
    try {
      const { tools } = await roClient.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).not.toContain("apply_patch");
      expect(names).not.toContain("run_command");
    } finally {
      await roClient.close();
      await roBridge.close();
      cleanup(readonlyRoot);
    }
  });
});

describe("chatgptMode global fallback (~/.c2c.json)", () => {
  const realEnv = process.env.AWEHITCH_GLOBAL_CONFIG;
  afterEach(() => {
    if (realEnv === undefined) delete process.env.AWEHITCH_GLOBAL_CONFIG;
    else process.env.AWEHITCH_GLOBAL_CONFIG = realEnv;
  });

  async function bridgeFor(root: string): Promise<{ bridge: Bridge; token: string }> {
    const bridge = await startBridge({
      workspaceRoots: [root],
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth-g"), "store.json"),
    });
    const tokens = bridge.authStore.issueTokens({ clientId: "g-client", scopes: ["workspace.read", "workspace.write", "exec.run"] });
    return { bridge, token: tokens.accessToken };
  }

  async function toolNames(bridge: Bridge, token: string): Promise<string[]> {
    const c = new Client({ name: "g-test", version: "1.0.0" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      })
    );
    try {
      return (await c.listTools()).tools.map((t) => t.name);
    } finally {
      await c.close();
    }
  }

  it("global write applies to workspaces without their own chatgptMode", async () => {
    const globalFile = path.join(makeTmpDir("global"), "c2c.json");
    fs.writeFileSync(globalFile, JSON.stringify({ chatgptMode: "write" }));
    process.env.AWEHITCH_GLOBAL_CONFIG = globalFile;
    const root = makeTmpDir("global-ws");
    write(root, ".c2c.json", JSON.stringify({ name: "no-mode" }));
    const { bridge, token } = await bridgeFor(root);
    try {
      const names = await toolNames(bridge, token);
      expect(names).toContain("apply_patch");
      expect(names).not.toContain("run_command");
    } finally {
      await bridge.close();
      cleanup(root);
    }
  });

  it("the workspace's own chatgptMode overrides the global one", async () => {
    const globalFile = path.join(makeTmpDir("global2"), "c2c.json");
    fs.writeFileSync(globalFile, JSON.stringify({ chatgptMode: "write-exec" }));
    process.env.AWEHITCH_GLOBAL_CONFIG = globalFile;
    const root = makeTmpDir("global-ws-strict");
    write(root, ".c2c.json", JSON.stringify({ chatgptMode: "readonly" }));
    const { bridge, token } = await bridgeFor(root);
    try {
      const names = await toolNames(bridge, token);
      expect(names).not.toContain("apply_patch");
      expect(names).not.toContain("run_command");
    } finally {
      await bridge.close();
      cleanup(root);
    }
  });

  it("an invalid global value is ignored (write-exec default applies)", async () => {
    const globalFile = path.join(makeTmpDir("global3"), "c2c.json");
    fs.writeFileSync(globalFile, JSON.stringify({ chatgptMode: "yolo" }));
    process.env.AWEHITCH_GLOBAL_CONFIG = globalFile;
    const root = makeTmpDir("global-ws-bad");
    const { bridge, token } = await bridgeFor(root);
    try {
      const names = await toolNames(bridge, token);
      expect(names).toContain("apply_patch");
      expect(names).toContain("run_command");
    } finally {
      await bridge.close();
      cleanup(root);
    }
  });
});
