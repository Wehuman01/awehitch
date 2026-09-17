import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, makeTmpDir, write } from "./helpers.js";
import { renderSkill } from "../src/adapters/skill-template.js";

/**
 * Adapter tests run against ISOLATED harness homes (CODEX_HOME /
 * OPENCODE_CONFIG_DIR / ~/.zcode/cli override). They never touch the real
 * ~/.codex, ~/.config/opencode or ~/.zcode.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Strip // line comments so commented configs can be JSON.parsed in tests. */
function stripLineComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, "");
}

let home: string;
let workDir: string;
let stateDir: string;
let previousEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = makeTmpDir("adapter-home");
  workDir = makeTmpDir("adapter-workspace");
  write(workDir, "hello.txt", "hello\n");
  stateDir = makeTmpDir("adapter-state");
  previousEnv = {
    CODEX_HOME: process.env.CODEX_HOME,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    AWEHITCH_STATE_DIR: process.env.AWEHITCH_STATE_DIR,
    ZCODE_HOME: process.env.ZCODE_HOME,
  };
  process.env.CODEX_HOME = path.join(home, "codex");
  process.env.OPENCODE_CONFIG_DIR = path.join(home, "opencode");
  delete process.env.OPENCODE_CONFIG; // file-path variable; must not be used as a directory
  delete process.env.XDG_CONFIG_HOME;
  process.env.ZCODE_HOME = path.join(home, "zcode");
  process.env.AWEHITCH_STATE_DIR = stateDir;
});

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanup(home);
  cleanup(workDir);
  cleanup(stateDir);
});

const cliEntry = { cmd: process.execPath, args: ["/opt/awehitch/dist/cli/index.js", "control-plane"] };

describe("skill template", () => {
  it("fills harness and connector name", () => {
    const skill = renderSkill({ harness: "ZCode", connectorName: "awehitch · Demo" });
    expect(skill).toContain("ZCode works.");
    expect(skill).toContain('named "awehitch · Demo" in ChatGPT');
    expect(skill).not.toContain("{{HARNESS}}");
    expect(skill).not.toContain("{{CONNECTOR_NAME}}");
  });
});

describe("codex adapter", () => {
  it("installs the skill, registers MCP, and reports status", async () => {
    const { setupCodexAdapter, codexAdapterStatus } = await import("../src/adapters/codex.js");
    const result = setupCodexAdapter({
      workspaceRoot: workDir,
      cliEntry,
      connectorName: "awehitch · Demo",
    });
    expect(fs.existsSync(result.skillPath)).toBe(true);
    expect(result.configPath).toBe(path.join(home, "codex", "config.toml"));
    const config = fs.readFileSync(result.configPath, "utf8");
    expect(config).toContain("[mcp_servers.awehitch]");
    expect(config).toContain('type = "stdio"');
    expect(config).toContain(workDir);
    // sandbox: state dir was added to writable_roots
    expect(result.sandbox.ok).toBe(true);

    const status = codexAdapterStatus();
    expect(status.skillInstalled).toBe(true);
    expect(status.mcpRegistered).toBe(true);
    expect(status.sandboxAllowed).toBe(true);
  });

  it("is idempotent and never duplicates the MCP table", async () => {
    const { setupCodexAdapter } = await import("../src/adapters/codex.js");
    setupCodexAdapter({ workspaceRoot: workDir, cliEntry, connectorName: "awehitch" });
    setupCodexAdapter({ workspaceRoot: workDir, cliEntry, connectorName: "awehitch" });
    const config = fs.readFileSync(path.join(home, "codex", "config.toml"), "utf8");
    expect(config.match(/\[mcp_servers\.awehitch\]/g)?.length).toBe(1);
  });

  it("preserves unrelated config content", async () => {
    const configPath = path.join(home, "codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `model = "gpt-5"\n\n[mcp_servers.fetch]\ntype = "stdio"\ncommand = "uvx"\n`);
    const { setupCodexAdapter } = await import("../src/adapters/codex.js");
    setupCodexAdapter({ workspaceRoot: workDir, cliEntry, connectorName: "awehitch" });
    const config = fs.readFileSync(configPath, "utf8");
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain("[mcp_servers.fetch]");
    expect(config).toContain("[mcp_servers.awehitch]");
  });
});

describe("opencode config home", () => {
  it("prefers OPENCODE_CONFIG_DIR and ignores the file-path OPENCODE_CONFIG variable", async () => {
    const { harnessHome } = await import("../src/adapters/paths.js");
    process.env.OPENCODE_CONFIG_DIR = path.join(home, "oc-dir");
    process.env.OPENCODE_CONFIG = path.join(home, "opencode.json"); // a FILE, not a dir
    expect(harnessHome("opencode")).toBe(path.join(home, "oc-dir"));
  });

  it("falls back to XDG_CONFIG_HOME/opencode, then ~/.config/opencode", async () => {
    const { harnessHome } = await import("../src/adapters/paths.js");
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = path.join(home, "xdg");
    expect(harnessHome("opencode")).toBe(path.join(home, "xdg", "opencode"));
    delete process.env.XDG_CONFIG_HOME;
    expect(harnessHome("opencode")).toBe(path.join(os.homedir(), ".config", "opencode"));
  });
});

describe("awehitchCliEntry", () => {
  it("always resolves an absolute entry and keeps the control-plane subcommand", async () => {
    const { awehitchCliEntry } = await import("../src/adapters/paths.js");
    const entry = awehitchCliEntry();
    expect(entry.cmd).toBe(process.execPath);
    expect(path.isAbsolute(entry.args[0])).toBe(true);
    expect(entry.args.at(-1)).toBe("control-plane");
    const distEntry = path.join(projectRoot, "dist", "cli", "index.js");
    if (fs.existsSync(distEntry)) {
      expect(entry.args[0]).toBe(distEntry);
    } else {
      expect(entry.args).toContain("tsx/esm"); // dev fallback on a fresh checkout
    }
  });
});

describe("opencode adapter", () => {
  it("installs the skill and registers the local MCP entry", async () => {
    const { setupOpencodeAdapter, opencodeAdapterStatus } = await import("../src/adapters/opencode.js");
    const result = setupOpencodeAdapter({
      workspaceRoot: workDir,
      cliEntry,
      connectorName: "awehitch · Demo",
    });
    expect(fs.existsSync(result.skillPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(result.configPath, "utf8"));
    expect(config.mcp.awehitch.type).toBe("local");
    expect(config.mcp.awehitch.command).toContain(workDir);

    const status = opencodeAdapterStatus();
    expect(status.skillInstalled).toBe(true);
    expect(status.mcpRegistered).toBe(true);
  });

  it("preserves comments and unrelated keys in an existing JSONC config", async () => {
    const configPath = path.join(home, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      `{\n  // my prefs\n  "theme": "dark",\n  "mcp": { "other": { "type": "remote", "url": "https://x.example/mcp" } }\n}\n`
    );
    const { setupOpencodeAdapter } = await import("../src/adapters/opencode.js");
    setupOpencodeAdapter({ workspaceRoot: workDir, cliEntry, connectorName: "awehitch" });
    const raw = fs.readFileSync(configPath, "utf8");
    // the comment must survive the upsert, not be stripped by a round-trip
    expect(raw).toContain("// my prefs");
    const config = JSON.parse(stripLineComments(raw));
    expect(config.theme).toBe("dark");
    expect(config.mcp.other.url).toBe("https://x.example/mcp");
    expect(config.mcp.awehitch.type).toBe("local");
  });

  it("inserts mcp.awehitch into a commented config that has no mcp key", async () => {
    const configPath = path.join(home, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `{\n  // theme comment\n  "theme": "dark"\n}\n`);
    const { setupOpencodeAdapter } = await import("../src/adapters/opencode.js");
    setupOpencodeAdapter({ workspaceRoot: workDir, cliEntry, connectorName: "awehitch" });
    const raw = fs.readFileSync(configPath, "utf8");
    expect(raw).toContain("// theme comment");
    const config = JSON.parse(stripLineComments(raw));
    expect(config.theme).toBe("dark");
    expect(config.mcp.awehitch.type).toBe("local");
  });

  it("is idempotent on commented configs (second run writes nothing)", async () => {
    const configPath = path.join(home, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `{\n  // keep me\n  "mcp": { "awehitch": { "type": "local", "command": ["old"], "enabled": false } }\n}\n`);
    const { setupOpencodeAdapter } = await import("../src/adapters/opencode.js");
    setupOpencodeAdapter({ workspaceRoot: workDir, cliEntry, connectorName: "awehitch" });
    const first = fs.readFileSync(configPath, "utf8");
    setupOpencodeAdapter({ workspaceRoot: workDir, cliEntry, connectorName: "awehitch" });
    expect(fs.readFileSync(configPath, "utf8")).toBe(first);
    expect(first).toContain("// keep me");
    expect(JSON.parse(stripLineComments(first)).mcp.awehitch.enabled).toBe(true);
  });

  it("refuses to touch a broken config instead of clobbering it", async () => {
    const configPath = path.join(home, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const broken = `{"theme": "dark"  // trailing comment then garbage`;
    fs.writeFileSync(configPath, broken);
    const { setupOpencodeAdapter } = await import("../src/adapters/opencode.js");
    expect(() => setupOpencodeAdapter({ workspaceRoot: workDir, cliEntry, connectorName: "awehitch" })).toThrow(
      /Cannot update/
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe(broken);
  });
});

describe("zcode adapter", () => {
  it("installs the skill and merges mcpServers into config.json", async () => {
    const { setupZcodeAdapter, zcodeAdapterStatus } = await import("../src/adapters/zcode.js");
    const configPath = path.join(home, "zcode", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // existing config with unrelated keys must survive untouched
    fs.writeFileSync(configPath, JSON.stringify({ hooks: { enabled: true }, mcpServers: {} }, null, 2));

    const result = setupZcodeAdapter({
      workspaceRoot: workDir,
      cliEntry,
      connectorName: "awehitch · Demo",
    });
    expect(fs.existsSync(result.skillPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.hooks.enabled).toBe(true);
    expect(config.mcpServers.awehitch.command).toBe(process.execPath);
    expect(config.mcpServers.awehitch.args).toContain(workDir);

    const status = zcodeAdapterStatus();
    expect(status.skillInstalled).toBe(true);
    expect(status.mcpRegistered).toBe(true);
  });

  it("is idempotent (no duplicate awehitch entry)", async () => {
    const { setupZcodeAdapter } = await import("../src/adapters/zcode.js");
    setupZcodeAdapter({ workspaceRoot: workDir, cliEntry, connectorName: "awehitch" });
    setupZcodeAdapter({ workspaceRoot: workDir, cliEntry, connectorName: "awehitch" });
    const configPath = path.join(home, "zcode", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(Object.keys(config.mcpServers).filter((name) => name === "awehitch").length).toBe(1);
  });
});
