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
  // No explicit mode: readDispatchWatch infers "chat" from the chat URL.
  writeDispatchWatch({ workspaceRoot: root, chatUrl: CHAT_URL, updatedAt: new Date().toISOString(), ...extra });
}

interface Calls {
  opened: string[];
  sent: string[];
  waits: number;
  closed: boolean;
  latestUser: string | null;
  recent: string[];
  reply: { status: string; text: string | null };
}

function stubDriver(
  waitResults: { status: string; directive: string | null }[],
  latestUser: string | null = null,
  reply: { status: string; text: string | null } = { status: "replied", text: "Plain prose answer." }
) {
  const calls: Calls = { opened: [], sent: [], waits: 0, closed: false, latestUser, recent: [], reply };
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
    async readLatestUserMessage() {
      return { text: calls.latestUser, count: calls.latestUser === null ? 0 : 1 };
    },
    async readReply() {
      return calls.reply;
    },
    async listRecentConversations(limit = 3) {
      return calls.recent.slice(0, limit);
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
  opts: { exitCode?: number; installed?: HarnessId[]; registered?: string[] } = {}
) {
  return {
    driver: driver as never,
    spawnFn: async (plan: unknown) => {
      spawns.push(plan);
      return { exitCode: opts.exitCode ?? 0 };
    },
    installedFn: () => opts.installed ?? (["codex", "opencode"] as HarnessId[]),
    registeredRoots: () => opts.registered ?? [],
    pollMs: 5,
  };
}

describe("dispatch watch state", () => {
  it("round-trips and deletes", () => {
    const root = makeTmpDir("dispatch-root");
    expect(readDispatchWatch()).toBeNull();
    writeWatch(root);
    expect(readDispatchWatch()).toMatchObject({ mode: "chat", workspaceRoot: root, chatUrl: CHAT_URL });
    writeDispatchWatch(null);
    expect(readDispatchWatch()).toBeNull();
    expect(fs.existsSync(dispatchStateFile())).toBe(false);
    cleanup(root);
  });

  it("infers the mode: chat from a chat URL, auto otherwise, off stays off", () => {
    const root = makeTmpDir("dispatch-root");
    writeWatch(root);
    expect(readDispatchWatch()?.mode).toBe("chat");
    writeDispatchWatch({ mode: "auto", updatedAt: "" });
    expect(readDispatchWatch()?.mode).toBe("auto");
    writeDispatchWatch({ mode: "off", updatedAt: "" });
    expect(readDispatchWatch()).toEqual({ mode: "off", updatedAt: expect.any(String) });
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

  it("includes the protocol note when the spawned run must introduce it", () => {
    const prompt = buildDispatchPrompt("do X", CHAT_URL, { protocolNote: true });
    expect(prompt).toContain("STATE: FOLLOW");
    expect(prompt).toContain("TASK:\ndo X");
  });
});

describe("DispatchWatcher chat mode", () => {
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
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns, { exitCode: 3 }));
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
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns, { installed: ["opencode"] }));
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
});

describe("DispatchWatcher auto mode", () => {
  const MARKER_MESSAGE = "@opencode fix the login validation";

  it("spawns the named harness for a marker message in a recent conversation", async () => {
    const root = makeTmpDir("dispatch-root");
    const { driver, calls } = stubDriver([{ status: "timeout", directive: null }], MARKER_MESSAGE);
    calls.recent = [CHAT_URL];
    const spawns: unknown[] = [];
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns, { registered: [root] }));
    watcher.start();
    try {
      await vi.waitFor(() => expect(spawns).toHaveLength(1));
      const plan = spawns[0] as { cmd: string; args: string[]; cwd: string };
      expect(plan.cwd).toBe(root);
      expect(plan.cmd).toBe("opencode"); // named by the @opencode marker
      expect(plan.args.at(-1)).toContain("TASK:\nfix the login validation");
      expect(plan.args.at(-1)).toContain(CHAT_URL);
      expect(plan.args.at(-1)).toContain("STATE: FOLLOW"); // spawned run introduces the protocol
      expect(readDispatchWatch()?.scanned?.[CHAT_URL]?.lastDispatched).toBe("fix the login validation");
      // No re-fire on later polls.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(spawns).toHaveLength(1);
    } finally {
      await watcher.stop();
    }
    cleanup(root);
  });

  it("treats @agent as authorization and lets the installed harnesses decide", async () => {
    const root = makeTmpDir("dispatch-root");
    const { driver, calls } = stubDriver([{ status: "timeout", directive: null }], "@agent fix the login validation");
    calls.recent = [CHAT_URL];
    const spawns: unknown[] = [];
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns, { registered: [root] }));
    watcher.start();
    try {
      await vi.waitFor(() => expect(spawns).toHaveLength(1));
      const plan = spawns[0] as { cmd: string; args: string[] };
      expect(plan.cmd).toBe("codex"); // first installed
    } finally {
      await watcher.stop();
    }
    cleanup(root);
  });

  it("defers to a protocol-aware executor: DIRECTIVE reply means owned", async () => {
    const root = makeTmpDir("dispatch-root");
    const { driver, calls } = stubDriver(
      [{ status: "timeout", directive: null }],
      MARKER_MESSAGE,
      { status: "replied", text: "[C2C]\nDIRECTIVE: fix the login validation" }
    );
    calls.recent = [CHAT_URL];
    const spawns: unknown[] = [];
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns, { registered: [root] }));
    watcher.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(spawns).toHaveLength(0); // a manually bound agent owns this conversation
    } finally {
      await watcher.stop();
    }
    cleanup(root);
  });

  it("waits out a generating reply instead of spawning mid-answer", async () => {
    const root = makeTmpDir("dispatch-root");
    const { driver, calls } = stubDriver(
      [{ status: "timeout", directive: null }],
      MARKER_MESSAGE,
      { status: "generating", text: "[C2C]\nDIRECTIVE: fix the…" }
    );
    calls.recent = [CHAT_URL];
    const spawns: unknown[] = [];
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns, { registered: [root] }));
    watcher.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(spawns).toHaveLength(0);
      // Once the answer renders as plain prose, the dispatch fires.
      calls.reply = { status: "replied", text: "Sure, on it." };
      await vi.waitFor(() => expect(spawns).toHaveLength(1));
    } finally {
      await watcher.stop();
    }
    cleanup(root);
  });

  it("ignores agent-injected turns even when they echo a marker", async () => {
    const root = makeTmpDir("dispatch-root");
    const { driver, calls } = stubDriver(
      [{ status: "timeout", directive: null }],
      "[C2C]\nSTATE: EXECUTED\nRESULT: done for @opencode"
    );
    calls.recent = [CHAT_URL];
    const spawns: unknown[] = [];
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns, { registered: [root] }));
    watcher.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(spawns).toHaveLength(0);
    } finally {
      await watcher.stop();
    }
    cleanup(root);
  });

  it("skips a bare marker with no task, and skips with zero or several workspaces", async () => {
    const root = makeTmpDir("dispatch-root");
    const { driver, calls } = stubDriver([{ status: "timeout", directive: null }], "@opencode");
    calls.recent = [CHAT_URL];
    const spawns: unknown[] = [];
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns, { registered: [root, makeTmpDir("extra")] }));
    watcher.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(spawns).toHaveLength(0); // several registered roots: skip
    } finally {
      await watcher.stop();
    }

    const watcher2 = new DispatchWatcher(watcherOpts(driver, spawns, { registered: [] }));
    watcher2.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(spawns).toHaveLength(0); // no registered root: skip
    } finally {
      await watcher2.stop();
    }

    // Bare marker with a single root: still no task to run.
    const watcher3 = new DispatchWatcher(watcherOpts(driver, spawns, { registered: [root] }));
    watcher3.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(spawns).toHaveLength(0);
    } finally {
      await watcher3.stop();
    }
    cleanup(root);
  });

  it("releases the browser when the watch is turned off", async () => {
    const root = makeTmpDir("dispatch-root");
    writeWatch(root, { notedUrl: CHAT_URL });
    const { driver, calls } = stubDriver([{ status: "directive", directive: DIRECTIVE }]);
    const spawns: unknown[] = [];
    const watcher = new DispatchWatcher(watcherOpts(driver, spawns));
    watcher.start();
    try {
      await vi.waitFor(() => expect(calls.waits).toBeGreaterThan(0));
      writeDispatchWatch({ mode: "off", updatedAt: new Date().toISOString() });
      await vi.waitFor(() => expect(calls.closed).toBe(true));
    } finally {
      await watcher.stop();
    }
    cleanup(root);
  });
});
