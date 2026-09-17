import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStateDir } from "./paths.js";
import { writeFileAtomic } from "../fs/atomic.js";

const TABLE = "sandbox_workspace_write";
const KEY = "writable_roots";

export interface SandboxAllowResult {
  added: boolean;
  alreadyAllowed: boolean;
  stateDir: string;
  configPath: string;
}

export function getCodexHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".codex");
}

export function getCodexConfigPath(): string {
  return path.join(getCodexHome(), "config.toml");
}

/** POSIX slashes are valid in TOML and accepted by Codex on Windows. */
export function toTomlPath(p: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\")) return p.replace(/\\/g, "/");
  return path.resolve(p).replace(/\\/g, "/");
}

export function pathsEquivalent(a: string, b: string): boolean {
  const left = normalizeCompare(a);
  const right = normalizeCompare(b);
  if (isWindowsStyle(a) || isWindowsStyle(b)) return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

export function listWritableRoots(content: string): string[] {
  const table = findTable(content, TABLE);
  if (!table) return [];
  const assignment = findArrayAssignment(table.body, KEY);
  return assignment ? parseTomlStringArray(assignment.rawArray) : [];
}

export function isStateDirAllowlisted(content: string, stateDir: string): boolean {
  return listWritableRoots(content).some((root) => pathsEquivalent(root, stateDir));
}

/**
 * Idempotently add the awehitch state directory to Codex's sandbox writable_roots.
 * Works on macOS, Windows, and Linux. Never rewrites unrelated config.
 */
export function ensureSandboxAllowlist(opts?: {
  configPath?: string;
  stateDir?: string;
}): SandboxAllowResult {
  const stateDir = path.resolve(opts?.stateDir ?? getStateDir());
  const configPath = opts?.configPath ?? getCodexConfigPath();
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });

  const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  if (isStateDirAllowlisted(previous, stateDir)) {
    return { added: false, alreadyAllowed: true, stateDir, configPath };
  }

  const next = upsertWritableRoot(previous, stateDir);
  writeFileAtomic(configPath, next, { mode: 0o600 });
  return { added: true, alreadyAllowed: false, stateDir, configPath };
}

export function upsertWritableRoot(content: string, stateDir: string): string {
  const tomlPath = toTomlPath(stateDir);
  if (isStateDirAllowlisted(content, stateDir)) return content;

  const table = findTable(content, TABLE);
  if (!table) {
    const prefix = content.length === 0 ? "" : content.endsWith("\n") ? content : `${content}\n`;
    const spacer = prefix.length === 0 || prefix.endsWith("\n\n") ? "" : "\n";
    return `${prefix}${spacer}[${TABLE}]\n${KEY} = ["${escapeTomlString(tomlPath)}"]\n`;
  }

  const assignment = findArrayAssignment(table.body, KEY);
  if (!assignment) {
    const insertAt = table.start + firstLineLength(table.body);
    const line = `${KEY} = ["${escapeTomlString(tomlPath)}"]\n`;
    return content.slice(0, insertAt) + line + content.slice(insertAt);
  }

  // Existing entries are preserved VERBATIM (byte-for-byte), never re-serialised.
  // Re-serialising user entries through toTomlPath() would silently rewrite a
  // hand-written `~/data` into a resolved absolute path; appending keeps the
  // user's text and the array's single/multi-line style untouched.
  const renderedArray = appendArrayItem(assignment.rawArray, `"${escapeTomlString(tomlPath)}"`);

  const assignStart = table.start + assignment.start;
  const assignEnd = table.start + assignment.end;
  return content.slice(0, assignStart) + `${KEY} = ${renderedArray}` + content.slice(assignEnd);
}

function normalizeCompare(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isWindowsStyle(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.includes("\\");
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function findTable(content: string, name: string): { start: number; end: number; body: string } | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^[ \\t]*\\[${escaped}\\][ \\t]*$`, "m").exec(content);
  if (!match) return null;
  const start = match.index;
  const afterHeader = start + match[0].length;
  const rest = content.slice(afterHeader);
  const next = /^[ \t]*\[[^\]]+\][ \t]*$/m.exec(rest);
  const end = next ? afterHeader + next.index : content.length;
  return { start, end, body: content.slice(start, end) };
}

function findArrayAssignment(
  tableBody: string,
  key: string
):
  | { start: number; end: number; rawArray: string }
  | null {
  const keyRe = new RegExp(`^[ \\t]*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}[ \\t]*=[ \\t]*`, "m");
  const match = keyRe.exec(tableBody);
  if (!match) return null;

  // Quote-aware scan for the closing ']': a path may contain ']', so skipping
  // `"…"` and `'…'` (with escapes) is required before trusting the first `]`.
  let i = match.index + match[0].length;
  while (i < tableBody.length && (tableBody[i] === " " || tableBody[i] === "\t")) i++;
  if (tableBody[i] !== "[") return null;
  const arrayStart = i;
  i++;
  for (; i < tableBody.length; i++) {
    const char = tableBody[i];
    if (char === '"' || char === "'") {
      const quote = char;
      i++;
      while (i < tableBody.length) {
        if (tableBody[i] === "\\") {
          i += 2;
          continue;
        }
        if (tableBody[i] === quote) break;
        i++;
      }
      continue;
    }
    if (char === "]") break;
  }
  const arrayEnd = i + 1; // one past the closing ']'
  return {
    start: match.index,
    end: arrayEnd,
    rawArray: tableBody.slice(arrayStart, arrayEnd),
  };
}

/**
 * Append one array item, preserving every existing byte (entries and style).
 * Single-line arrays keep a single line; multi-line arrays get a new indented
 * entry line before the closing bracket. The user's existing entries are never
 * re-serialised.
 */
function appendArrayItem(rawArray: string, entry: string): string {
  const closingIdx = rawArray.length - 1; // index of the closing ']'
  const innerRaw = rawArray.slice(1, closingIdx);

  if (innerRaw.trim() === "") {
    return `[\n  ${entry},\n]`;
  }

  if (innerRaw.includes("\n")) {
    const beforeClose = rawArray.slice(0, closingIdx);
    const tail = /(\r?\n)([ \t]*)$/.exec(beforeClose);
    const tailWs = tail ? tail[0] : "\n";
    const head = beforeClose.slice(0, beforeClose.length - tailWs.length);
    // Indent the new entry like the existing entries (the closing bracket
    // usually sits further left than they do).
    const lastEntryLine = /(\r?\n)([ \t]*)\S/.exec(head);
    const indent = lastEntryLine ? lastEntryLine[2] : tail ? tail[2] : "  ";
    const sep = head.endsWith(",") ? "\n" : ",\n";
    return `${head}${sep}${indent}${entry}${tailWs}]`;
  }

  return `${rawArray.slice(0, closingIdx)}, ${entry}]`;
}

function parseTomlStringArray(src: string): string[] {
  const values: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src))) {
    const raw = match[1] ?? match[2] ?? "";
    values.push(raw.replace(/\\(.)/g, "$1"));
  }
  return values;
}

function firstLineLength(text: string): number {
  const newline = text.indexOf("\n");
  return newline === -1 ? text.length : newline + 1;
}
