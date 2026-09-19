import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildDispatchPrompt, DispatchWatcher, FOLLOW_PROTOCOL_NOTE } from "../src/dispatch/watcher.js";
import { pickHarness, planSpawn } from "../src/dispatch/harness.js";
import { dispatchStateFile, readDispatchWatch, writeDispatchWatch } from "../src/dispatch/state.js";
import type { HarnessId } from "../src/adapters/paths.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

let stateDir: string;

beforeEach(() => {
  stateDir = isolateStateDir();
});

afterEach(() => {
  delete process.env.AWEHITCH_STATE_DIR;
  cleanup(stateDir);
});

const CHAT_URL = "https://chatgpt.com/c/abc123";
const DIRECTIVE = "fix the login validation";

function writeWatch(root: string, extra: Record<string, unknown> = {}): void {
  writeDispatchWatch({ workspaceRoot: root, chatUrl: CHAT_URL, updatedAt: new Date().toISOString(), ...extra });
}

interface Calls {
  opened: string[];
  sent: string[];
  waits: number;
  closed: boolean;
}

function stubDriver(waitResults: { status: string; directive: string | null }[]) {
  const calls: Calls = { opened: [], sent: [], waits: 0, closed: false };
  let i = 0;
  const driver = {
    async openConversation(url?: string) {
      calls.opened.push(url ?? "home");
      return url ?? "home";
    },
    async sendMessage(text: string) {
      calls.sent.push(text);
      return {};
    },
    async waitDirective() {
      calls.waits++;
      const next = waitResults[Math.min(i, waitResults.length - 1)];
      i++;
      return next;
    },
    async close() {
      calls.closed = true;
    },
  };
  return { driver, calls };
}

function watcherOpts(
  driver: unknown,
  spawns: unknown[],
  exitCode = 0,
  installed: HarnessId[] = ["codex", "opencode"]
) {
  return {
    driver: driver as never,
    spawnFn: async (plan: unknown) => {
      spawns.push(plan);
      return { exitCode };
    },
    installedFn: () => installed,
    pollMs: 5,
  };
}

describe("dispatch watch state", () => {
  it("round-trips and deletes", () => {
    const root = makeTmpDir("dispatch-root");
    expect(readDispatchWatch()).toBeNull();
    writeWatch(root);
    expect(readDispatchWatch()).toMatchObject({ workspaceRoot: root, chatUrl: CHAT_URL });
    writeDispatchWatch(null);
    expect(readDispatchWatch()).toBeNull();
    expect(fs.existsSync(dispatchStateFile())).toBe(false);
    cleanup(root);
  });

  it("returns null for corrupt, invalid, or vanished watches", () => {
    fs.mkdirSync(path.dirname(dispatchStateFile()), { recursive: true });
    fs.writeFileSync(dispatchStateFile(), "{ not json");
    expect(readDispatchWatch()).toBeNull();
    writeDispatchWatch({ workspaceRoot: makeTmpDir("dispatch-root"), chatUrl: "https://example.com/x", updatedAt: "" });
    expect(readDispatchWatch()).toBeNull();
    writeDispatchWatch({ workspaceRoot: "/definitely/missing/dir", chatUrl: CHAT_URL, updatedAt: "" });
    expect(readDispatchWatch()).toBeNull();
  });
});

describe("pickHarness", () => {
  it("prefers a harness named in the directive, case-insensitively", () => {
    expect(pickHarness({}, "用 opencode 修一下", ["codex", "opencode"])).toEqual({ ok: true, harness: "opencode" });
    expect(pickHarness({ harness: "zcode" }, "call CODEX please", ["codex", "zcode"])).toEqual({ ok: true, harness: "codex" });
  });

  it("falls back to the pinned harness, then the first installed", () => {
    expect(pickHarness({ harness: "zcode" }, "no names here", ["zcode"])).toEqual({ ok: true, harness: "zcode" });
    expect(pickHarness({}, "no names here", ["codex", "opencode"])).toEqual({ ok: true, harness: "codex" });
  });

  it("refuses honestly when the named or pinned harness is missing", () => {
    const named = pickHarness({}, "use codex for this", ["opencode"]);
    expect(named.ok).toBe(false);
    if (!named.ok) expect(named.reason).toContain("codex");
    const pinned = pickHarness({ harness: "zcode" }, "no names", ["opencode"]);
    expect(pinned.ok).toBe(false);
    const none = pickHarness({}, "no names", []);
    expect(none.ok).toBe(false);
  });
});

describe("planSpawn", () => {
  it("builds codex exec and opencode run commands", () => {
    const root = makeTmpDir("dispatch-root");
    expect(planSpawn("codex", root, "PROMPT")).toEqual({
      harness: "codex",
      cmd: "codex",
      args: ["exec", "--cd", root, "--skip-git-repo-check", "PROMPT"],
      cwd: root,
    });
    expect(planSpawn("opencode", root, "PROMPT")).toEqual({
      harness: "opencode",
      cmd: "opencode",
      args: ["run", "PROMPT"],
      cwd: root,
    });
    cleanup(root);
  });

  it("builds a zcode headless run and honors a command override", () => {
    const root = makeTmpDir("dispatch-root");
    const zc = planSpawn("zcode", root, "PROMPT");
    expect(zc.args).toContain("--prompt");
    expect(zc.args).toContain("PROMPT");
    expect(zc.args).toContain("--cwd");
    expect(zc.args).toContain(root);
    const override = planSpawn("zcode", root, "PROMPT", "/custom/zcode");
    expect(override.cmd).toBe("/custom/zcode");
    cleanup(root);
  });
});

describe("buildDispatchPrompt", () => {
  it("carries the conversation URL and the task", () => {
    const prompt = buildDispatchPrompt("do X", CHAT_URL);
    expect(prompt).toContain(CHAT_URL);
    expect(prompt).toContain("TASK:\ndo X");
  });
});

describe("DispatchWatcher", () => {
  it("sends the protocol note once, then spawns on an authorized directive", async () => {
    const root = makeTmpDir("dispatch-root");
    writeWatch(root);
    const { driver, calls } = stubDriver([{ status: "directive", directive: DIRECTIVE }]);
    const spawns: unknown[] = [];
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns));
    watcher.start();
    try {
      await vi.waitFor(() => expect(spawns).toHaveLength(1));
      expect(calls.sent[0]).toBe(FOLLOW_PROTOCOL_NOTE);
      const plan = spawns[0] as { cmd: string; args: string[]; cwd: string };
      expect(plan.cwd).toBe(root);
      expect(plan.args.at(-1)).toContain(`TASK:\n${DIRECTIVE}`);
      expect(plan.args.at(-1)).toContain(CHAT_URL);
      expect(readDispatchWatch()?.lastDirective).toBe(DIRECTIVE);
    } finally {
      await watcher.stop();
    }
    expect(calls.closed).toBe(true);
    cleanup(root);
  });

  it("never spawns the same directive twice", async () => {
    const root = makeTmpDir("dispatch-root");
    writeWatch(root, { notedUrl: CHAT_URL });
    const { driver } = stubDriver([{ status: "directive", directive: DIRECTIVE }]);
    const spawns: unknown[] = [];
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns));
    watcher.start();
    try {
      await vi.waitFor(() => expect(spawns).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 40)); // several more polls
      expect(spawns).toHaveLength(1);
    } finally {
      await watcher.stop();
    }
    cleanup(root);
  });

  it("reports BLOCKED back when the spawned run exits non-zero", async () => {
    const root = makeTmpDir("dispatch-root");
    writeWatch(root, { notedUrl: CHAT_URL });
    const { driver, calls } = stubDriver([{ status: "directive", directive: DIRECTIVE }]);
    const spawns: unknown[] = [];
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns, 3));
    watcher.start();
    try {
      await vi.waitFor(() => expect(calls.sent.some((t) => t.includes("STATE: BLOCKED"))).toBe(true));
      expect(calls.sent.at(-1)).toContain("exited with code 3");
    } finally {
      await watcher.stop();
    }
    cleanup(root);
  });

  it("skips a directive already executed before the restart", async () => {
    const root = makeTmpDir("dispatch-root");
    writeWatch(root, { notedUrl: CHAT_URL, lastDirective: DIRECTIVE });
    const { driver } = stubDriver([{ status: "directive", directive: DIRECTIVE }]);
    const spawns: unknown[] = [];
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns));
    watcher.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(spawns).toHaveLength(0);
    } finally {
      await watcher.stop();
    }
    cleanup(root);
  });

  it("refuses a directive naming an uninstalled harness, with the reason", async () => {
    const root = makeTmpDir("dispatch-root");
    writeWatch(root, { notedUrl: CHAT_URL });
    const { driver, calls } = stubDriver([{ status: "directive", directive: "use codex to do it" }]);
    const spawns: unknown[] = [];
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns, 0, ["opencode"]));
    watcher.start();
    try {
      await vi.waitFor(() => expect(calls.sent.some((t) => t.includes("STATE: BLOCKED"))).toBe(true));
      expect(calls.sent.at(-1)).toContain("codex");
      expect(spawns).toHaveLength(0);
    } finally {
      await watcher.stop();
    }
    cleanup(root);
  });

  it("does nothing while no watch exists and releases the browser after removal", async () => {
    const { driver, calls } = stubDriver([{ status: "timeout", directive: null }]);
    const spawns: unknown[] = [];
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns));
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spawns).toHaveLength(0);
    expect(calls.waits).toBe(0); // no watch: the loop never even opens a browser

    const root = makeTmpDir("dispatch-root");
    writeWatch(root, { notedUrl: CHAT_URL });
    await vi.waitFor(() => expect(calls.waits).toBeGreaterThan(0));
    writeDispatchWatch(null);
    await vi.waitFor(() => expect(calls.closed).toBe(true));
    await watcher.stop();
    cleanup(root);
  });
});
