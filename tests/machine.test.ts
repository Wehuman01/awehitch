import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  addWorkspaceRoot,
  isWorkspaceRegistered,
  loadRegisteredWorkspaces,
  readRegistryRoots,
  registryFile,
  writeRegistry,
} from "../src/workspace/registry.js";
import { migrateLegacyStateToMachine } from "../src/config/migrate.js";
import { readTunnelState, isNamedTunnelReady, type TunnelState } from "../src/tunnel/state.js";
import { AuthStore } from "../src/auth/store.js";
import {
  readSession,
  readTaskSession,
  taskSessionFile,
  writeSession,
  writeTaskSession,
} from "../src/session/state.js";
import { cleanup, makeTmpDir, isolateStateDir, write } from "./helpers.js";

describe("machine workspace registry", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.AWEHITCH_STATE_DIR;
  });

  it("registers roots idempotently and dedupes case-insensitively", () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("registry-a");
    dirs.push(root);
    write(root, "a.txt", "a");

    expect(addWorkspaceRoot(root)).toMatchObject({ added: true });
    expect(addWorkspaceRoot(root)).toMatchObject({ added: false });
    expect(isWorkspaceRegistered(root)).toBe(true);
    expect(readRegistryRoots()).toHaveLength(1);
  });

  it("loads registered workspaces and prunes vanished directories", () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("registry-live");
    dirs.push(root);
    write(root, "a.txt", "a");
    const ghost = makeTmpDir("registry-ghost");
    write(ghost, "gone.txt", "gone");
    writeRegistry([root, ghost]);
    // The ghost directory actually vanishes before the load.
    cleanup(ghost);

    const workspaces = loadRegisteredWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].root).toBe(root);
    // The vanished root was dropped from the persisted list.
    expect(readRegistryRoots()).toEqual([root]);
  });

  it("rejects invalid roots", () => {
    dirs.push(isolateStateDir());
    expect(() => addWorkspaceRoot("/definitely/not/a/workspace")).toThrow();
    expect(registryFile()).toContain(path.join("workspaces.json"));
  });
});

describe("legacy state migration", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.AWEHITCH_STATE_DIR;
  });

  it("adopts the newest legacy auth store and the single named tunnel, then stops", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    // Legacy auth stores (pre-0.2.6 layout): the one holding credentials wins.
    const authDir = path.join(stateDir, "auth");
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const oldStore = new AuthStore("oldws00000001", { file: path.join(authDir, "oldws00000001.json") });
    oldStore.registerClient({ redirectUris: ["https://chatgpt.com"] });
    fs.utimesSync(path.join(authDir, "oldws00000001.json"), new Date(), new Date(Date.now() - 60_000));
    const newStore = new AuthStore("newws00000001", { file: path.join(authDir, "newws00000001.json") });
    const client = newStore.registerClient({ redirectUris: ["https://chatgpt.com"] });
    newStore.issueTokens({ clientId: client.clientId, scopes: ["workspace.read", "offline_access"] });
    expect(newStore.tokenCount()).toBe(2);

    // Exactly one legacy named tunnel binding, in the pre-0.2.6 layout.
    const named: TunnelState = {
      preference: "named",
      provider: "cloudflare-named",
      tunnelName: "c2c-oldws00000001",
      tunnelId: "11111111-1111-1111-1111-111111111111",
      hostname: "c2c-old.example.com",
      zone: "example.com",
    };
    const tunnelDir = path.join(stateDir, "tunnels");
    fs.mkdirSync(tunnelDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(tunnelDir, "oldws00000001.json"),
      JSON.stringify({ workspaceId: "oldws00000001", ...named })
    );

    const first = migrateLegacyStateToMachine();
    expect(first.adoptedAuth).toBe(true);
    expect(first.adoptedTunnel).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "auth", "machine.json"))).toBe(true);
    expect(new AuthStore().tokenCount()).toBe(2);
    expect(isNamedTunnelReady(readTunnelState())).toBe(true);
    expect(readTunnelState().hostname).toBe("c2c-old.example.com");

    // Idempotent: a second run changes nothing, and machine files are never
    // overwritten by leftovers.
    fs.writeFileSync(
      path.join(stateDir, "tunnels", "otherws0000001.json"),
      JSON.stringify({ workspaceId: "otherws0000001", ...named })
    );
    const second = migrateLegacyStateToMachine();
    expect(second.adoptedAuth).toBe(false);
    expect(second.adoptedTunnel).toBe(false);
    expect(readTunnelState().hostname).toBe("c2c-old.example.com");
  });

  it("prefers a credential-holding store over a newer empty one", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);

    // The real 0.2.5→0.2.6 trap: every bridge start writes an auth store, so
    // workspaces that never paired leave empty files newer than the store
    // that actually holds the ChatGPT connector's credentials.
    const authDir = path.join(stateDir, "auth");
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const pairedStore = new AuthStore("pairedws000001", { file: path.join(authDir, "pairedws000001.json") });
    const client = pairedStore.registerClient({ redirectUris: ["https://chatgpt.com"] });
    pairedStore.issueTokens({ clientId: client.clientId, scopes: ["workspace.read", "offline_access"] });
    expect(pairedStore.tokenCount()).toBe(2);
    fs.utimesSync(path.join(authDir, "pairedws000001.json"), new Date(), new Date(Date.now() - 60_000));
    fs.writeFileSync(
      path.join(authDir, "freshws000001.json"),
      JSON.stringify({ clients: [], tokens: [] })
    );

    const result = migrateLegacyStateToMachine();
    expect(result.adoptedAuth).toBe(true);
    expect(new AuthStore().tokenCount()).toBe(2);
  });

  it("does not adopt a tunnel when several legacy workspaces had named bindings", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const tunnelDir = path.join(stateDir, "tunnels");
    fs.mkdirSync(tunnelDir, { recursive: true, mode: 0o700 });
    for (const id of ["aaaa00000001", "bbbb00000001"]) {
      fs.writeFileSync(
        path.join(tunnelDir, `${id}.json`),
        JSON.stringify({
          workspaceId: id,
          preference: "named",
          provider: "cloudflare-named",
          tunnelName: `c2c-${id}`,
          hostname: `${id.slice(0, 6)}.example.com`,
          zone: "example.com",
        })
      );
    }
    const result = migrateLegacyStateToMachine();
    expect(result.adoptedTunnel).toBe(false);
    expect(readTunnelState().preference).toBe("unset");
  });
});

describe("per-task session slots", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.AWEHITCH_STATE_DIR;
  });

  it("keeps two tasks of the same harness in separate files", () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("task-slots");
    dirs.push(root);
    write(root, "a.txt", "a");

    writeTaskSession(root, "task-1", {
      taskId: "task-1",
      checkpoint: {
        taskId: "task-1",
        iteration: 1,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        updatedAt: new Date().toISOString(),
      },
      savedAt: new Date().toISOString(),
    }, "zcode");
    writeTaskSession(root, "task-2", {
      taskId: "task-2",
      checkpoint: {
        taskId: "task-2",
        iteration: 3,
        protocolState: "PLAN_RECEIVED",
        waitingFor: "none",
        updatedAt: new Date().toISOString(),
      },
      savedAt: new Date().toISOString(),
    }, "zcode");

    expect(readTaskSession(root, "task-1", "zcode")?.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(readTaskSession(root, "task-2", "zcode")?.checkpoint?.iteration).toBe(3);
    // The workspace-level slot stays untouched by task writes.
    expect(readSession(root, "zcode")).toBeNull();
    expect(taskSessionFile(root, "task-1", "zcode")).not.toBe(taskSessionFile(root, "task-2", "zcode"));
    // Unsafe task ids get slugged, never used raw in paths.
    expect(taskSessionFile(root, "../evil", "zcode")).not.toContain("../evil");
  });

  it("writes the workspace-level slot independently", () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("ws-slot");
    dirs.push(root);
    write(root, "a.txt", "a");
    writeSession(root, { url: "https://chatgpt.com/c/abc", savedAt: new Date().toISOString() });
    expect(readSession(root)?.url).toBe("https://chatgpt.com/c/abc");
    expect(readTaskSession(root, "task-1")).toBeNull();
  });
});
