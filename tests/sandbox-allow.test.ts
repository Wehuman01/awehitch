import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ensureSandboxAllowlist,
  isStateDirAllowlisted,
  listWritableRoots,
  pathsEquivalent,
  toTomlPath,
  upsertWritableRoot,
} from "../src/config/sandbox-allow.js";
import { makeTmpDir, cleanup } from "./helpers.js";

describe("sandbox allowlist", () => {
  it("treats Windows slash variants as the same path", () => {
    expect(pathsEquivalent("C:\\Users\\Ada\\AppData\\Local\\awehitch", "C:/Users/Ada/AppData/Local/awehitch")).toBe(
      true
    );
    expect(pathsEquivalent("C:/Users/Ada/AppData/Local/awehitch/", "c:\\users\\ada\\appdata\\local\\awehitch")).toBe(
      true
    );
    expect(toTomlPath("C:\\Users\\Ada\\AppData\\Local\\awehitch").includes("\\")).toBe(false);
  });

  it("creates the table when config.toml is missing", () => {
    const dir = makeTmpDir("sandbox-missing");
    const stateDir = path.join(dir, "state");
    const configPath = path.join(dir, "config.toml");
    const result = ensureSandboxAllowlist({ configPath, stateDir });
    expect(result.added).toBe(true);
    const text = fs.readFileSync(configPath, "utf8");
    expect(text).toContain("[sandbox_workspace_write]");
    expect(isStateDirAllowlisted(text, stateDir)).toBe(true);
    cleanup(dir);
  });

  it("appends the table without rewriting existing Codex settings", () => {
    const original = [
      'model = "gpt-5.6-luna"',
      "",
      "[features]",
      "js_repl = false",
      "",
      '[projects."/Users/ada/app"]',
      'trust_level = "trusted"',
      "",
    ].join("\n");
    const next = upsertWritableRoot(original, "/Users/ada/Library/Application Support/awehitch");
    expect(next).toContain('model = "gpt-5.6-luna"');
    expect(next).toContain("[features]");
    expect(next).toContain('trust_level = "trusted"');
    expect(next).toContain("[sandbox_workspace_write]");
    expect(next).toContain(
      `writable_roots = ["${toTomlPath("/Users/ada/Library/Application Support/awehitch")}"]`
    );
  });

  it("inserts writable_roots into an existing empty table", () => {
    const next = upsertWritableRoot("[sandbox_workspace_write]\n", "/tmp/c2c-state");
    expect(next).toContain(`writable_roots = ["${toTomlPath("/tmp/c2c-state")}"]`);
  });

  it("adds to a single-line array and keeps other roots", () => {
    const next = upsertWritableRoot(
      '[sandbox_workspace_write]\nwritable_roots = ["/already"]\n',
      "/Users/ada/Library/Application Support/awehitch"
    );
    expect(next).toContain(`"${toTomlPath("/already")}"`);
    expect(next).toContain(`"${toTomlPath("/Users/ada/Library/Application Support/awehitch")}"`);
  });

  it("adds to a multiline Windows-style array", () => {
    const next = upsertWritableRoot(
      [
        "[sandbox_workspace_write]",
        "writable_roots = [",
        '  "C:/Users/Ada/other",',
        "]",
        "",
      ].join("\n"),
      "C:\\Users\\Ada\\AppData\\Local\\awehitch"
    );
    expect(next).toContain("C:/Users/Ada/other");
    expect(next).toContain("C:/Users/Ada/AppData/Local/awehitch");
  });

  it("is idempotent when the path is already listed with the other slash style", () => {
    const dir = makeTmpDir("sandbox-idem");
    const configPath = path.join(dir, "config.toml");
    const stateDir = path.join(dir, "state");
    fs.writeFileSync(
      configPath,
      `[sandbox_workspace_write]\nwritable_roots = ["${toTomlPath(stateDir)}"]\n`
    );
    const first = ensureSandboxAllowlist({ configPath, stateDir });
    const second = ensureSandboxAllowlist({ configPath, stateDir });
    expect(first.alreadyAllowed).toBe(true);
    expect(second.added).toBe(false);
    const text = fs.readFileSync(configPath, "utf8");
    expect(text.match(/writable_roots/g)?.length).toBe(1);
    cleanup(dir);
  });

  it("does not truncate a path containing a ']' and can read the result back", () => {
    const stateDir = "/Users/ada/data[beta]/cache";
    const next = upsertWritableRoot(
      '[sandbox_workspace_write]\nwritable_roots = ["/already"]\n',
      stateDir
    );
    // The appended entry keeps the whole "]"-containing path intact.
    expect(next).toContain(toTomlPath(stateDir));
    expect(next, "no truncated array").not.toContain('[cache]');
    // And the result is parseable back into the exact same roots.
    expect(listWritableRoots(next)).toEqual(["/already", toTomlPath(stateDir)]);
  });

  it("preserves a user's ~/data entry verbatim, appending only the new root", () => {
    const original = '[sandbox_workspace_write]\nwritable_roots = ["~/data", "/other"]\n';
    const next = upsertWritableRoot(original, "/Users/ada/Library/Application Support/awehitch");
    // ~/data must be written back exactly as the user wrote it — never
    // resolved into an absolute path.
    expect(next).toContain('"~/data"');
    expect(next).not.toContain(path.resolve("~/data"));
    expect(next).toContain(`"${toTomlPath("/Users/ada/Library/Application Support/awehitch")}"`);
  });

  it("keeps a multiline array multiline after appending", () => {
    const next = upsertWritableRoot(
      [
        "[sandbox_workspace_write]",
        "writable_roots = [",
        '  "C:/Users/Ada/other",',
        "]",
        "",
      ].join("\n"),
      "C:\\Users\\Ada\\AppData\\Local\\awehitch"
    );
    const before = "[sandbox_workspace_write]\nwritable_roots = [\n  \"C:/Users/Ada/other\",\n]\n";
    expect(next).toContain("C:/Users/Ada/other");
    expect(next).toContain("C:/Users/Ada/AppData/Local/awehitch");
    // still multiline, with no broken syntax (readable back)
    expect(listWritableRoots(next)).toEqual(["C:/Users/Ada/other", "C:/Users/Ada/AppData/Local/awehitch"]);
  });

  it("is idempotent across repeated appends (single call each run)", () => {
    const dir = makeTmpDir("sandbox-append-idem");
    const configPath = path.join(dir, "config.toml");
    const stateDir = path.join(dir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const first = ensureSandboxAllowlist({ configPath, stateDir });
    const second = ensureSandboxAllowlist({ configPath, stateDir });
    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    const text = fs.readFileSync(configPath, "utf8");
    expect(text.match(/writable_roots/g)?.length).toBe(1);
    cleanup(dir);
  });
});
