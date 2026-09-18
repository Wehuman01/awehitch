import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fs/atomic.js";
import { HarnessId, harnessHome } from "./paths.js";
import { ensureSandboxAllowlist, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import { getStateDir } from "../config/paths.js";
import { getCodexConfigPath, findTableToml } from "./toml.js";
import { renderSkill } from "./skill-template.js";

/**
 * codex adapter.
 *
 * 1. MCP registration: `[mcp_servers.awehitch]` stdio entry in config.toml
 * 2. Instructions: `~/.codex/skills/awehitch/SKILL.md`
 * 3. Sandbox: awehitch state dir into `[sandbox_workspace_write].writable_roots`
 */

export function setupCodexAdapter(opts: {
  workspaceRoot: string;
  cliEntry: { cmd: string; args: string[] };
  connectorName: string;
}): { skillPath: string; configPath: string; sandbox: { ok: boolean; added: boolean; alreadyAllowed: boolean } } {
  const home = harnessHome("codex");

  // 1. Skill (instructions)
  const skillDir = path.join(home, "skills", "awehitch");
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  writeFileAtomic(skillPath, renderSkill({ harness: "Codex", connectorName: opts.connectorName }), {
    mode: 0o644,
  });

  // 2. MCP entry (idempotent TOML upsert; the awehitch entry is ours alone)
  const configPath = getCodexConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const next = upsertCodexMcpEntry(previous, opts.cliEntry, opts.workspaceRoot);
  if (next !== previous) {
    writeFileAtomic(configPath, next, { mode: 0o600 });
  }

  // 3. Sandbox writable_roots (state dir; code copied from the reference impl)
  let sandbox: { ok: boolean; added: boolean; alreadyAllowed: boolean };
  try {
    const result = ensureSandboxAllowlist();
    sandbox = { ok: true, added: result.added, alreadyAllowed: result.alreadyAllowed };
  } catch (error) {
    sandbox = { ok: false, added: false, alreadyAllowed: false };
    void error;
  }

  return { skillPath, configPath, sandbox };
}

export function codexAdapterStatus(): {
  skillInstalled: boolean;
  mcpRegistered: boolean;
  sandboxAllowed: boolean;
  configPath: string;
} {
  const home = harnessHome("codex");
  const skillPath = path.join(home, "skills", "awehitch", "SKILL.md");
  const configPath = getCodexConfigPath();
  let mcpRegistered = false;
  let sandboxAllowed = false;
  try {
    const content = fs.readFileSync(configPath, "utf8");
    mcpRegistered = /\[mcp_servers\.awehitch\]/.test(content);
    sandboxAllowed = isStateDirAllowlisted(content, getStateDir());
  } catch {
    // missing config -> both false
  }
  return { skillInstalled: fs.existsSync(skillPath), mcpRegistered, sandboxAllowed, configPath };
}

function upsertCodexMcpEntry(
  content: string,
  cliEntry: { cmd: string; args: string[] },
  workspaceRoot: string
): string {
  const TABLE = "mcp_servers.awehitch";
  const body = [
    `[${TABLE}]`,
    `type = "stdio"`,
    `command = ${tomlString(cliEntry.cmd)}`,
    `args = ${tomlArray([...cliEntry.args, "--workspace", workspaceRoot])}`,
    `env = { AWEHITCH_CONTROL_PLANE = "1" }`,
  ].join("\n");

  const existing = findTableToml(content, TABLE);
  if (existing) {
    // Replace only OUR table's block; never touch unrelated config. The span
    // ends where the next header line begins, and body has no trailing
    // newline — keep one between them or the following table gets glued onto
    // our env line and the whole file stops parsing (this broke a real setup).
    const after = content.slice(existing.end);
    const glue = after.startsWith("\n") ? "" : "\n";
    return content.slice(0, existing.start) + body + glue + after;
  }
  // Append under the [mcp_servers] section if present, else at the end.
  const parent = findTableToml(content, "mcp_servers");
  const prefix = content.length === 0 ? "" : content.endsWith("\n") ? content : `${content}\n`;
  if (parent && !existing) {
    const insertAt = nextTableStart(content, parent.end) ?? content.length;
    const block = `\n${body}\n`;
    return content.slice(0, insertAt) + block + content.slice(insertAt);
  }
  return `${prefix}\n${body}\n`;
}

function nextTableStart(content: string, from: number): number | null {
  const rest = content.slice(from);
  const match = /^[ \t]*\[[^\]]+\][ \t]*$/m.exec(rest);
  return match ? from + match.index : null;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}
