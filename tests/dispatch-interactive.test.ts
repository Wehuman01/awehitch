import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildCommandScript, ensureAweswitch, openInteractiveTerminal } from "../src/dispatch/interactive.js";
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
      { harness: "opencode", workspaceRoot: root, prompt: "do the TASK\nline two", aweswitchProfiles: [] },
      "test1"
    );
    expect(promptPath).toContain("prompt-test1.md");
    expect(fs.readFileSync(promptPath, "utf8")).toContain("do the TASK");
    expect(script).toContain(`cd '${root.replaceAll("'", `'\\''`)}'`);
    expect(script).toContain("pbcopy");
    expect(script).not.toContain("aweswitch");
    expect(script).toMatch(/exec 'opencode'\n?$/);
    expect(fs.statSync(scriptPath).mode & 0o111).toBeTruthy();
  });

  it("resolves the zcode bundle like the headless spawner does", () => {
    const { script } = buildCommandScript(
      { harness: "zcode", workspaceRoot: "/tmp", prompt: "x", aweswitchProfiles: [] },
      "test2"
    );
    expect(script).toMatch(/exec '(zcode|node|.*zcode\.cjs)'/);
  });

  it("offers an aweswitch profile picker when profiles exist for the harness", () => {
    const { script } = buildCommandScript(
      { harness: "opencode", workspaceRoot: "/tmp", prompt: "x", aweswitchProfiles: ["oc-glm", "oc-deepseek"] },
      "test3"
    );
    expect(script).toContain("profiles=('oc-glm' 'oc-deepseek')");
    expect(script).toContain('printf "  %2d) %s\\n" "$i" "$p"');
    expect(script).toContain("aweswitch");
    expect(script).toMatch(/exec aweswitch "\$PROFILE"; else exec 'opencode'/);
  });

  it("auto-pastes the task into the dispatched TUI and releases the claim after it exits", () => {
    const { script } = buildCommandScript(
      {
        harness: "opencode",
        workspaceRoot: "/tmp",
        prompt: "x",
        chatUrl: "https://chatgpt.com/c/abc-123",
        aweswitchProfiles: [],
      },
      "test4"
    );
    expect(script).not.toContain("exec ");
    expect(script).toContain("'opencode' &");
    expect(script).toContain("AGENT=$!");
    expect(script).toContain('keystroke "v" using command down');
    expect(script).toContain("keystroke return");
    expect(script).toContain("wait $AGENT");
    expect(script).toMatch(/awehitch dispatch release 'https:\/\/chatgpt\.com\/c\/abc-123' >\/dev\/null 2>&1\n?$/);
  });

  it("auto-pastes after the aweswitch picker too, launching it in the background", () => {
    const { script } = buildCommandScript(
      {
        harness: "opencode",
        workspaceRoot: "/tmp",
        prompt: "x",
        chatUrl: "https://chatgpt.com/c/abc-123",
        aweswitchProfiles: ["oc-glm"],
      },
      "test5"
    );
    expect(script).toContain('aweswitch "$PROFILE" &');
    expect(script).toContain('keystroke "v" using command down');
    expect(script).not.toContain("exec ");
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

describe("ensureAweswitch (dependency of interactive dispatch)", () => {
  const realPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = realPath;
  });

  it("is satisfied when aweswitch is already on PATH", async () => {
    const bin = makeTmpDir("fake-bin");
    fs.writeFileSync(path.join(bin, "aweswitch"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = bin;
    const result = await ensureAweswitch(async () => {
      throw new Error("must not install");
    });
    expect(result).toEqual({ ok: true, alreadyPresent: true });
    cleanup(bin);
  });

  it("installs via pip when missing, and reports honestly when pip fails", async () => {
    process.env.PATH = "/usr/bin:/bin";
    const ran: string[][] = [];
    const result = await ensureAweswitch(async (_cmd, args) => {
      ran.push(args);
      return 1;
    });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("failed");
    expect(ran).toEqual([["install", "--user", "aweswitch"]]);
  });
});
