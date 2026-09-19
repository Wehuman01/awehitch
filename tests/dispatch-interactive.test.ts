import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildCommandScript, openInteractiveTerminal } from "../src/dispatch/interactive.js";
import { writeLaunchStyle, readLaunchStyle, writeDispatchWatch, readDispatchWatch } from "../src/dispatch/state.js";
import { getStateDir } from "../src/config/paths.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

let stateDir: string;

beforeEach(() => {
  stateDir = isolateStateDir();
});

afterEach(() => {
  cleanup(stateDir);
});

describe("interactive dispatch script", () => {
  it("prints the prompt, copies it to the clipboard, then execs the TUI — paths safely quoted", () => {
    const root = makeTmpDir("dispatch root 'quoted'");
    const { script, scriptPath, promptPath } = buildCommandScript(
      { harness: "opencode", workspaceRoot: root, prompt: "do the TASK\nline two" },
      "test1"
    );
    expect(promptPath).toContain("prompt-test1.md");
    expect(fs.readFileSync(promptPath, "utf8")).toContain("do the TASK");
    expect(script).toContain(`cd '${root.replaceAll("'", `'\\''`)}'`);
    expect(script).toContain("pbcopy");
    expect(script).toMatch(/exec 'opencode'\n?$/);
    expect(fs.statSync(scriptPath).mode & 0o111).toBeTruthy();
  });

  it("resolves the zcode bundle like the headless spawner does", () => {
    const { script } = buildCommandScript(
      { harness: "zcode", workspaceRoot: "/tmp", prompt: "x" },
      "test2"
    );
    expect(script).toMatch(/exec '(zcode|node|.*zcode\.cjs)'/);
  });

  it("refuses non-macOS honestly", async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const result = await openInteractiveTerminal({ harness: "opencode", workspaceRoot: "/tmp", prompt: "x" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("headless");
    } finally {
      realPlatform?.restore?.();
      if (!realPlatform) delete (process as Record<string, unknown>).platform;
    }
  });
});

describe("dispatch launch style state", () => {
  it("round-trips and survives watch rewrites", () => {
    expect(readLaunchStyle()).toBe("headless");
    writeLaunchStyle("interactive");
    expect(readLaunchStyle()).toBe("interactive");

    // a watch rewrite must not clobber the launch style
    const root = makeTmpDir("dispatch-root");
    writeDispatchWatch({ mode: "chat", workspaceRoot: root, chatUrl: "https://chatgpt.com/c/abc", updatedAt: "" });
    expect(readDispatchWatch()?.mode).toBe("chat");
    expect(readLaunchStyle()).toBe("interactive");

    writeLaunchStyle("headless");
    expect(readLaunchStyle()).toBe("headless");
    const raw = JSON.parse(fs.readFileSync(path.join(getStateDir(), "dispatch.json"), "utf8"));
    expect("launchStyle" in raw).toBe(false);
  });
});
