import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fs/atomic.js";
import { harnessHome } from "./paths.js";
import { renderSkill } from "./skill-template.js";

/**
 * zcode adapter.
 *
 * 1. MCP registration: `"mcpServers": { "awehitch": { …stdio… } }` in
 *    ~/.zcode/cli/config.json (idempotent merge that preserves all other keys)
 * 2. Instructions: `~/.zcode/agents/awehitch.md` (agent file with YAML
 *    frontmatter; zcode loads agents from this directory)
 * 3. Sandbox: none needed (zcode has hooks, no writable_roots equivalent)
 */

const AGENT_BODY = `You can delegate planning and review to ChatGPT with awehitch.

When the user says "use ChatGPT to plan" / "用 ChatGPT 帮我规划", follow the
awehitch skill (installed at ~/.zcode/skills or referenced by the awehitch CLI):
exchange [C2C] control messages through the awehitch MCP tools, execute plans
yourself, and let ChatGPT review the real diff via the read-only connector.
`;

export function setupZcodeAdapter(opts: {
  workspaceRoot: string;
  cliEntry: { cmd: string; args: string[] };
  connectorName: string;
}): { skillPath: string; configPath: string } {
  const home = harnessHome("zcode");

  // 1. Skill (instructions) — zcode plugin-style skills dir
  const skillDir = path.join(home, "skills", "awehitch");
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  writeFileAtomic(skillPath, renderSkill({ harness: "ZCode", connectorName: opts.connectorName }), {
    mode: 0o644,
  });

  // 2. MCP entry — idempotent merge into config.json (preserve every other key)
  const configPath = path.join(home, "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const config = readJson(configPath);
  config.mcpServers ??= {};
  config.mcpServers.awehitch = {
    command: opts.cliEntry.cmd,
    args: [...opts.cliEntry.args, "--workspace", opts.workspaceRoot],
    env: { AWEHITCH_CONTROL_PLANE: "1" },
  };
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
  const configPath = path.join(home, "config.json");
  let mcpRegistered = false;
  try {
    const config = readJson(configPath);
    mcpRegistered = Boolean(config.mcpServers?.awehitch);
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
