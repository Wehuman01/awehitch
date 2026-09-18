import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fs/atomic.js";
import { harnessHome } from "./paths.js";
import { renderSkill } from "./skill-template.js";

/**
 * opencode adapter.
 *
 * 1. MCP registration: `"mcp": { "awehitch": { "type": "local", "command": […] } }`
 *    in the global opencode.json (JSONC-aware upsert that preserves comments)
 * 2. Instructions: `~/.opencode/skills/awehitch/SKILL.md` (AGENTS.md left to the user —
 *    awehitch never edits the project)
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
  const skillDir = path.join(home, "skills", "awehitch");
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  writeFileAtomic(skillPath, renderSkill({ harness: "opencode", harnessId: "opencode", connectorName: opts.connectorName }), {
    mode: 0o644,
  });

  // 2. MCP entry — idempotent upsert in the global config (JSONC-aware)
  const configPath = path.join(home, "opencode.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const entry = {
    type: "local",
    command: [
      opts.cliEntry.cmd,
      ...opts.cliEntry.args,
      "--workspace",
      opts.workspaceRoot,
      "--harness",
      "opencode",
    ],
    enabled: true,
  };
  let next: string;
  try {
    next = mergeMcpEntry(raw, entry);
  } catch (error) {
    throw new Error(
      `Cannot update ${configPath}: ${(error as Error).message}. Fix or remove the file and rerun setup.`
    );
  }
  if (next !== raw) writeFileAtomic(configPath, next, { mode: 0o600 });

  return { skillPath, configPath };
}

export function opencodeAdapterStatus(): {
  skillInstalled: boolean;
  mcpRegistered: boolean;
  configPath: string;
} {
  const home = harnessHome("opencode");
  const skillPath = path.join(home, "skills", "awehitch", "SKILL.md");
  const configPath = path.join(home, "opencode.json");
  let mcpRegistered = false;
  try {
    const config = readJsonc(configPath);
    mcpRegistered = Boolean(config.mcp?.awehitch);
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

/**
 * Merge `mcp.awehitch` into the raw config text. Commented files are edited
 * surgically so the user's comments and formatting survive byte-for-byte
 * outside the awehitch entry; comment-free files round-trip through JSON
 * (insertion order preserved). Throws on input it cannot parse — the caller
 * reports the path instead of clobbering the file.
 */
function mergeMcpEntry(raw: string, entry: Record<string, unknown>): string {
  const json = JSON.stringify(entry);
  if (raw.trim().length === 0) {
    return `${JSON.stringify({ mcp: { awehitch: entry } }, null, 2)}\n`;
  }
  if (stripJsoncComments(raw) === raw) {
    const parsed = JSON.parse(raw) as Record<string, any>;
    parsed.mcp ??= {};
    parsed.mcp.awehitch = entry;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }

  const rootOpen = skipWsAndComments(raw, 0);
  if (raw[rootOpen] !== "{") {
    throw new Error("the root value is not a JSON object");
  }
  const mcpSpan = findKeyInObject(raw, rootOpen, "mcp");
  if (!mcpSpan) {
    return insertIntoObject(raw, rootOpen, `"mcp": { "awehitch": ${json} }`);
  }
  const mcpOpen = skipWsAndComments(raw, mcpSpan.valueStart);
  if (raw[mcpOpen] !== "{") {
    throw new Error('the "mcp" key holds a non-object value');
  }
  const existing = findKeyInObject(raw, mcpOpen, "awehitch");
  if (existing) {
    return raw.slice(0, existing.valueStart) + json + raw.slice(existing.valueEnd);
  }
  return insertIntoObject(raw, mcpOpen, `"awehitch": ${json}`);
}

/** Span of `key`'s value inside the object opening at `objOpen`, or null. */
function findKeyInObject(
  text: string,
  objOpen: number,
  key: string
): { valueStart: number; valueEnd: number } | null {
  const close = matchingBrace(text, objOpen);
  if (close === -1) return null;
  let i = skipWsAndComments(text, objOpen + 1);
  while (i < close) {
    if (text[i] !== '"') return null;
    const keyEnd = skipString(text, i);
    if (keyEnd === -1) return null;
    let keyName: string;
    try {
      keyName = JSON.parse(text.slice(i, keyEnd)) as string;
    } catch {
      return null;
    }
    i = skipWsAndComments(text, keyEnd);
    if (text[i] !== ":") return null;
    i = skipWsAndComments(text, i + 1);
    const valueStart = i;
    const valueEnd = skipValue(text, i);
    if (valueEnd === -1) return null;
    if (keyName === key) return { valueStart, valueEnd };
    i = skipWsAndComments(text, valueEnd);
    if (text[i] === ",") i = skipWsAndComments(text, i + 1);
    else if (i !== close) return null; // missing separator: refuse to guess
  }
  return null;
}

/** Insert `snippet` ("key": value) as the last entry of the object at `objOpen`. */
function insertIntoObject(text: string, objOpen: number, snippet: string): string {
  const close = matchingBrace(text, objOpen);
  if (close === -1) throw new Error("unterminated object");
  const inner = text.slice(objOpen + 1, close);
  const base = inner.trimEnd();
  const trailing = inner.slice(base.length);
  const comma = base.trim().length > 0 ? "," : "";
  const newline = trailing.lastIndexOf("\n");
  const indent = newline >= 0 ? trailing.slice(newline + 1) : "";
  const keep = newline >= 0 ? trailing.slice(0, newline + 1) : "\n";
  return text.slice(0, objOpen + 1) + base + comma + "\n" + indent + "  " + snippet + keep + text.slice(close);
}

function skipWsAndComments(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const char = text[i];
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
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
    return i;
  }
  return i;
}

/** Index just past the closing quote of the string starting at `i`. */
function skipString(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") {
      j += 2;
      continue;
    }
    if (text[j] === text[i]) return j + 1;
    j += 1;
  }
  return -1;
}

/** Index just past the JSON value starting at `i` (ws/comments pre-skipped). */
function skipValue(text: string, i: number): number {
  const char = text[i];
  if (char === undefined) return -1;
  if (char === '"') return skipString(text, i);
  if (char === "{" || char === "[") {
    const close = matchingBrace(text, i);
    return close === -1 ? -1 : close + 1;
  }
  let j = i;
  while (j < text.length && !",}] \t\r\n".includes(text[j])) j += 1;
  return j === i ? -1 : j;
}

/** Index of the brace/bracket closing the one at `openIdx`, or -1. */
function matchingBrace(text: string, openIdx: number): number {
  const open = text[openIdx];
  const close = open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return -1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"') quote = char;
    else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
    } else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
