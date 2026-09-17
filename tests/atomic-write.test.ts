import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../src/fs/atomic.js";
import { makeTmpDir, cleanup } from "./helpers.js";

describe("writeFileAtomic", () => {
  it("creates the file and missing parent directories", () => {
    const dir = makeTmpDir("atomic-create");
    const file = path.join(dir, "nested", "deeper", "config.json");
    writeFileAtomic(file, '{"ok":true}\n', { mode: 0o600 });
    expect(fs.readFileSync(file, "utf8")).toBe('{"ok":true}\n');
    cleanup(dir);
  });

  it("replaces existing content completely and leaves no temp files behind", () => {
    const dir = makeTmpDir("atomic-replace");
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "old-content-that-is-longer-than-the-new-content");
    writeFileAtomic(file, "new\n");
    expect(fs.readFileSync(file, "utf8")).toBe("new\n");
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
    cleanup(dir);
  });

  it.runIf(process.platform !== "win32")("applies the requested mode even under a permissive umask", () => {
    const dir = makeTmpDir("atomic-mode");
    const file = path.join(dir, "secret.json");
    writeFileAtomic(file, "{}", { mode: 0o600 });
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    cleanup(dir);
  });
});
