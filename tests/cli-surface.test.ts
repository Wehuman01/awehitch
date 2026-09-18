import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectHarnesses } from "../src/adapters/detect.js";
import { AuthStore } from "../src/auth/store.js";
import { connectorAction, readLastEndpoint, writeLastEndpoint } from "../src/config/endpoint.js";
import { revokeConnectorAccess } from "../src/cli/index.js";
import { cleanup, makeTmpDir, isolateStateDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env,
  });
}

const HARNESS_ENV_KEYS = ["CODEX_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "ZCODE_HOME"] as const;

/** Point the harness homes at controlled paths for the duration of `run`. */
function withHarnessHomes(homes: Partial<Record<(typeof HARNESS_ENV_KEYS)[number], string>>, run: () => void): void {
  const previous = HARNESS_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of HARNESS_ENV_KEYS) delete process.env[key];
  for (const [key, dir] of Object.entries(homes)) process.env[key] = dir;
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("detectHarnesses", () => {
  it("returns nothing when no harness homes exist", () => {
    const tmp = makeTmpDir("detect-none");
    try {
      withHarnessHomes(
        {
          CODEX_HOME: path.join(tmp, "no-codex"),
          OPENCODE_CONFIG_DIR: path.join(tmp, "no-opencode"),
          ZCODE_HOME: path.join(tmp, "no-zcode"),
        },
        () => expect(detectHarnesses()).toEqual([])
      );
    } finally {
      cleanup(tmp);
    }
  });

  it("returns existing homes in canonical order", () => {
    const tmp = makeTmpDir("detect-some");
    try {
      fs.mkdirSync(path.join(tmp, "zcode"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "codex"), { recursive: true });
      withHarnessHomes(
        {
          CODEX_HOME: path.join(tmp, "codex"),
          OPENCODE_CONFIG_DIR: path.join(tmp, "no-opencode"),
          ZCODE_HOME: path.join(tmp, "zcode"),
        },
        () => expect(detectHarnesses()).toEqual(["codex", "zcode"])
      );
    } finally {
      cleanup(tmp);
    }
  });
});

describe("revokeConnectorAccess", () => {
  it("revokes persisted tokens when no bridge is running", async () => {
    const stateDir = makeTmpDir("revoke-state");
    const previousStateDir = process.env.AWEHITCH_STATE_DIR;
    process.env.AWEHITCH_STATE_DIR = stateDir;
    try {
      const workspaceId = "cli_surface_ws";
      const store = new AuthStore(workspaceId);
      const client = store.registerClient({ redirectUris: ["https://chatgpt.com"] });
      store.issueTokens({ clientId: client.clientId, scopes: ["workspace.read", "offline_access"] });
      expect(store.tokenCount()).toBe(2);

      await revokeConnectorAccess(workspaceId);

      expect(new AuthStore(workspaceId).tokenCount()).toBe(0);
    } finally {
      if (previousStateDir === undefined) delete process.env.AWEHITCH_STATE_DIR;
      else process.env.AWEHITCH_STATE_DIR = previousStateDir;
      cleanup(stateDir);
    }
  });
});

describe("endpoint change detection", () => {
  // The default command must snapshot the previous endpoint BEFORE
  // persisting the new address (doctor does the same). Reading after the
  // persist hides the rotation and the connector is never rebuilt.
  it("detects a rotated address only from the pre-persist snapshot", () => {
    const stateDir = makeTmpDir("endpoint-state");
    const previousStateDir = process.env.AWEHITCH_STATE_DIR;
    process.env.AWEHITCH_STATE_DIR = stateDir;
    try {
      const workspaceId = "endpoint_ws";
      writeLastEndpoint({
        workspaceId,
        port: 4100,
        publicUrl: "https://old.example.com",
        mcpUrl: "https://old.example.com/mcp",
      });
      const snapshot = readLastEndpoint(workspaceId);
      const rotated = "https://new.example.com/mcp";
      writeLastEndpoint({ workspaceId, port: 4100, publicUrl: "https://new.example.com", mcpUrl: rotated });

      expect(connectorAction(snapshot?.mcpUrl, rotated)).toBe("update");
      // The trap this test pins down: reading after the persist loses the change.
      expect(connectorAction(readLastEndpoint(workspaceId)?.mcpUrl, rotated)).toBe("none");
    } finally {
      if (previousStateDir === undefined) delete process.env.AWEHITCH_STATE_DIR;
      else process.env.AWEHITCH_STATE_DIR = previousStateDir;
      cleanup(stateDir);
    }
  });
});

describe("command surface", () => {
  it("lists exactly up, off, doctor, tunnel as user-facing commands", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    const help = result.stdout;
    for (const visible of ["up", "off", "doctor", "tunnel"]) {
      expect(help).toMatch(new RegExp(`^\\s{2}${visible} `, "m"));
    }
    for (const hidden of [
      "setup",
      "connector-setup",
      "login",
      "pair",
      "unpair",
      "session",
      "record",
      "prefs",
      "stop",
      "restart",
      "logs",
      "sandbox-allow",
      "serve",
      "control-plane",
      // removed commands must not come back
      "start",
      "status",
      "workspace",
      "update-check",
    ]) {
      expect(help).not.toMatch(new RegExp(`^\\s{2}${hidden} `, "m"));
    }
  });

  it("keeps hidden commands callable for already-installed skills", () => {
    for (const command of ["setup", "connector-setup", "logs"]) {
      const result = runCli([command, "--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage:");
    }
  });

  it("routes options to the default command and reports a bad workspace as JSON", () => {
    const result = runCli(["--workspace", "/definitely/not/a/workspace", "--json"]);
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: false, error: { code: "BAD_WORKSPACE" } });
  });

  it("rejects negative --timeout with a clear commander error", () => {
    const result = runCli(["up", "--workspace", projectRoot, "--timeout", "-1", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("timeout");
  });

  it("rejects non-integer --iteration for session set", () => {
    const stateDir = isolateStateDir();
    try {
      const result = runCli(["session", "set", "--workspace", projectRoot, "--iteration", "abc"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("must be an integer");
    } finally {
      cleanup(stateDir);
      delete process.env.AWEHITCH_STATE_DIR;
    }
  });

  it("rejects negative -n for logs", () => {
    const result = runCli(["logs", "--workspace", projectRoot, "-n", "-5"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lines");
  });

  it("rejects invalid --exit-status for record", () => {
    const result = runCli(["record", "--workspace", projectRoot, "--task", "t1", "--iteration", "0", "--exit-status", "maybe"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exit-status");
  });

  it("doctor --no-fix does not mutate the endpoint file", () => {
    const stateDir = isolateStateDir();
    try {
      const endpointFile = path.join(stateDir, "endpoints", "doc-ws.json");
      fs.mkdirSync(path.dirname(endpointFile), { recursive: true });
      fs.writeFileSync(endpointFile, JSON.stringify({ workspaceId: "doc-ws", port: 1, publicUrl: null, mcpUrl: null, savedAt: new Date().toISOString() }));
      const before = fs.readFileSync(endpointFile, "utf8");
      const result = runCli(["doctor", "--workspace", projectRoot, "--no-fix", "--json"]);
      expect(result.status).toBe(0);
      const after = fs.readFileSync(endpointFile, "utf8");
      expect(after).toBe(before);
    } finally {
      cleanup(stateDir);
      delete process.env.AWEHITCH_STATE_DIR;
    }
  });
});
