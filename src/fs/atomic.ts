import fs from "node:fs";
import path from "node:path";

/**
 * Write a file atomically: write to a temp file in the same directory, then
 * rename over the target. A crash mid-write can never truncate the target —
 * these files carry the user's other MCP config, so a torn write is data loss.
 */
export function writeFileAtomic(file: string, data: string, options?: { mode?: number }): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  try {
    fs.writeFileSync(tmp, data, { encoding: "utf8", ...(options?.mode !== undefined ? { mode: options.mode } : {}) });
    if (options?.mode !== undefined) {
      try {
        fs.chmodSync(tmp, options.mode);
      } catch {
        // platforms without chmod semantics
      }
    }
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already renamed onto the target, or never created
    }
  }
}
