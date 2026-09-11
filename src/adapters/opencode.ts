import fs from "node:fs";
import path from "node:path";
import { harnessHome } from "./paths.js";
import { renderSkill } from "./skill-template.js";

/**
 * opencode adapter.
 *
 * 1. MCP registration: `"mcp": { "awemind": { "type": "local", "command": […] } }`
 *    in the global opencode.json (JSONC-aware upsert that preserves comments)
 * 2. Instructions: `~/.opencode/skills/awemind/SKILL.md` (AGENTS.md left to the user —
 *    awemind never edits the project)
 * 3. Sandbox: none needed (opencode has no writable_roots equivalent)
 *
 * Note: opencode natively supports remote MCP with OAuth (RFC 7591 DCR). The
 * ChatGPT data-plane bridge URL can be added with `opencode mcp add` if the
 * user wants opencode itself to read the workspace — but the primary design
 * keeps the data plane for ChatGPT only, so this adapter registers just the
 * control plane.
 */

export function setupOpencodeAdapter(opts: {
  workspaceRoot: string;
  cliEntry: { cmd: string; args: string[] };
  connectorName: string;
}): { skillPath: string; configPath: string } {
  const home = harnessHome("opencode");

  // 1. Skill (instructions)
  const skillDir = path.join(home, "skills", "awemind");
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, renderSkill({ harness: "opencode", connectorName: opts.connectorName }), {
    mode: 0o644,
  });

  // 2. MCP entry — idempotent JSON upsert in the global config
  const configPath = path.join(home, "opencode.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const config = readJsonc(configPath);
  config.mcp ??= {};
  config.mcp.awemind = {
    type: "local",
    command: [opts.cliEntry.cmd, ...opts.cliEntry.args, "--workspace", opts.workspaceRoot],
    enabled: true,
  };
  writeJson(configPath, config);

  return { skillPath, configPath };
}

export function opencodeAdapterStatus(): {
  skillInstalled: boolean;
  mcpRegistered: boolean;
  configPath: string;
} {
  const home = harnessHome("opencode");
  const skillPath = path.join(home, "skills", "awemind", "SKILL.md");
  const configPath = path.join(home, "opencode.json");
  let mcpRegistered = false;
  try {
    const config = readJsonc(configPath);
    mcpRegistered = Boolean(config.mcp?.awemind);
  } catch {
    // missing or unparsable -> false
  }
  return { skillInstalled: fs.existsSync(skillPath), mcpRegistered, configPath };
}

/** Minimal JSONC parse: strip // and /* *\/ comments outside strings, then JSON.parse. */
function readJsonc(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  const cleaned = stripJsoncComments(raw);
  if (!cleaned.trim()) return {};
  return JSON.parse(cleaned) as Record<string, any>;
}

function stripJsoncComments(text: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (char === '"') inString = false;
      i += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      i += 1;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** opencode.json may be hand-edited; preserve key order with 2-space JSON. */
function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // platforms without chmod semantics
  }
}
