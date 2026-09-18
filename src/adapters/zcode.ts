import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fs/atomic.js";
import { harnessHome } from "./paths.js";
import { renderSkill } from "./skill-template.js";

/**
 * zcode adapter.
 *
 * 1. MCP registration: `mcp.servers.awehitch` stdio entry in
 *    <zcode home>/cli/config.json (zcode reads the nested `mcp.servers` key;
 *    our legacy top-level `mcpServers` entry is ignored and removed on setup)
 * 2. Instructions: <zcode home>/skills/awehitch/SKILL.md — zcode discovers
 *    user-scope skills in ~/.zcode/skills, NOT in ~/.zcode/cli/skills
 * 3. Sandbox: none needed (zcode has hooks, no writable_roots equivalent)
 */

export function setupZcodeAdapter(opts: {
  workspaceRoot: string;
  cliEntry: { cmd: string; args: string[] };
  connectorName: string;
}): { skillPath: string; configPath: string } {
  const home = harnessHome("zcode");

  // 1. Skill (instructions) — zcode's user-scope skills directory
  const skillDir = path.join(home, "skills", "awehitch");
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  writeFileAtomic(skillPath, renderSkill({ harness: "ZCode", harnessId: "zcode", connectorName: opts.connectorName }), {
    mode: 0o644,
  });

  // 2. MCP entry — nested `mcp.servers` key (idempotent merge that preserves
  //    every other key); migrate away our ignored top-level `mcpServers` entry.
  const configPath = path.join(home, "cli", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const config = readJson(configPath);
  config.mcp ??= {};
  config.mcp.servers ??= {};
  config.mcp.servers.awehitch = {
    command: opts.cliEntry.cmd,
    args: [...opts.cliEntry.args, "--workspace", opts.workspaceRoot, "--harness", "zcode"],
    env: { AWEHITCH_CONTROL_PLANE: "1" },
  };
  if (config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)) {
    delete config.mcpServers.awehitch;
    if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  }
  writeJson(configPath, config);

  return { skillPath, configPath };
}

export function zcodeAdapterStatus(): {
  skillInstalled: boolean;
  mcpRegistered: boolean;
  configPath: string;
} {
  const home = harnessHome("zcode");
  const skillPath = path.join(home, "skills", "awehitch", "SKILL.md");
  const configPath = path.join(home, "cli", "config.json");
  let mcpRegistered = false;
  try {
    const config = readJson(configPath);
    mcpRegistered = Boolean(config.mcp?.servers?.awehitch);
  } catch {
    // missing or unparsable -> false
  }
  return { skillInstalled: fs.existsSync(skillPath), mcpRegistered, configPath };
}

function readJson(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, any>;
}

function writeJson(file: string, data: unknown): void {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}
