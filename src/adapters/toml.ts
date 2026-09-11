import path from "node:path";
import os from "node:os";

/** Codex home / config path resolution (env overridable, mirrors sandbox-allow.ts). */
export function getCodexConfigPath(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  const home = fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".codex");
  return path.join(home, "config.toml");
}

/** Find a top-level or dotted TOML table. Returns its [start, end) span. */
export function findTableToml(content: string, name: string): { start: number; end: number } | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^[ \\t]*\\[${escaped}\\][ \\t]*$`, "m").exec(content);
  if (!match) return null;
  const start = match.index;
  const afterHeader = start + match[0].length;
  const rest = content.slice(afterHeader);
  const next = /^[ \t]*\[[^\]]+\][ \t]*$/m.exec(rest);
  const end = next ? afterHeader + next.index : content.length;
  return { start, end };
}
