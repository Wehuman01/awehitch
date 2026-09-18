import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  applyChatBinding,
  readControlPlaneState,
  readSlotPointer,
  resolveChatTarget,
  withStateMergeLock,
} from "../src/control-plane/state.js";
import {
  claimSessionSlot,
  maxParallelSessions,
  slotKeyFor,
  slotLeaseFile,
  slotLeaseHolder,
} from "../src/control-plane/slot.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

let stateDir: string;
let previousStateDir: string | undefined;
let previousMax: string | undefined;

beforeEach(() => {
  stateDir = makeTmpDir("control-plane-slots");
  previousStateDir = process.env.AWEHITCH_STATE_DIR;
  process.env.AWEHITCH_STATE_DIR = stateDir;
  previousMax = process.env.AWEHITCH_MAX_PARALLEL_SESSIONS;
  delete process.env.AWEHITCH_MAX_PARALLEL_SESSIONS;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.AWEHITCH_STATE_DIR;
  else process.env.AWEHITCH_STATE_DIR = previousStateDir;
  if (previousMax === undefined) delete process.env.AWEHITCH_MAX_PARALLEL_SESSIONS;
  else process.env.AWEHITCH_MAX_PARALLEL_SESSIONS = previousMax;
  cleanup(stateDir);
});

describe("session slot pool", () => {
  it("gives the first session the legacy harness profile (slot 0)", () => {
    const slot = claimSessionSlot("opencode");
    expect(slot.index).toBe(0);
    expect(slot.key).toBe("opencode");
    expect(slotLeaseHolder("opencode")?.pid).toBe(process.pid);
    slot.release();
    expect(slotLeaseHolder("opencode")).toBeNull();
  });

  it("gives a concurrent second session its own slot and profile key", () => {
    const first = claimSessionSlot("opencode");
    const second = claimSessionSlot("opencode");
    expect(first.index).toBe(0);
    expect(second.index).toBe(1);
    expect(second.key).toBe("opencode-s1");
    // the two sessions never share a lease file
    expect(slotLeaseFile(first.key)).not.toBe(slotLeaseFile(second.key));
    first.release();
    second.release();
  });

  it("pools slots per harness", () => {
    const oc = claimSessionSlot("opencode");
    const cx = claimSessionSlot("codex");
    expect(cx.index).toBe(0);
    expect(cx.key).toBe("codex");
    oc.release();
    cx.release();
  });

  it("fails honestly when the pool is exhausted", () => {
    const first = claimSessionSlot("opencode");
    const second = claimSessionSlot("opencode");
    expect(() => claimSessionSlot("opencode")).toThrow(/slots for harness "opencode" are busy/);
    expect(() => claimSessionSlot("opencode")).toThrow(/AWEHITCH_MAX_PARALLEL_SESSIONS/);
    first.release();
    second.release();
  });

  it("steals the lease of a dead process", () => {
    const dir = path.dirname(slotLeaseFile("opencode"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      slotLeaseFile("opencode"),
      JSON.stringify({ pid: 999_999_999, slotKey: "opencode", acquiredAt: "2020-01-01T00:00:00Z" })
    );
    const slot = claimSessionSlot("opencode");
    expect(slot.index).toBe(0);
    slot.release();
  });

  it("honors AWEHITCH_MAX_PARALLEL_SESSIONS within sane bounds", () => {
    process.env.AWEHITCH_MAX_PARALLEL_SESSIONS = "3";
    expect(maxParallelSessions()).toBe(3);
    const slots = [claimSessionSlot("zcode"), claimSessionSlot("zcode"), claimSessionSlot("zcode")];
    expect(slots.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(() => claimSessionSlot("zcode")).toThrow(/busy/);
    for (const slot of slots) slot.release();

    process.env.AWEHITCH_MAX_PARALLEL_SESSIONS = "0";
    expect(maxParallelSessions()).toBe(1);
    process.env.AWEHITCH_MAX_PARALLEL_SESSIONS = "999";
    expect(maxParallelSessions()).toBe(16);
    process.env.AWEHITCH_MAX_PARALLEL_SESSIONS = "not-a-number";
    expect(maxParallelSessions()).toBe(2);
  });

  it("slot keys keep the legacy name for slot 0 and derive the rest", () => {
    expect(slotKeyFor("codex", 0)).toBe("codex");
    expect(slotKeyFor("codex", 1)).toBe("codex-s1");
    expect(slotKeyFor("codex", 12)).toBe("codex-s12");
  });
});

describe("slot-scoped chat pointers", () => {
  it("slot >= 1 sessions keep a private chat pointer outside the shared state", () => {
    applyChatBinding("ws1", "https://chatgpt.com/c/aaa", "task-a", "opencode", 1);
    // task binding is shared (survives session restarts)
    expect(readControlPlaneState("ws1", "opencode")?.taskChats?.["task-a"]).toBe("https://chatgpt.com/c/aaa");
    // the session pointer is private, never mirrored into the shared file
    expect(readControlPlaneState("ws1", "opencode")?.chatUrl).toBeUndefined();
    expect(readSlotPointer("ws1", "opencode", 1)).toBe("https://chatgpt.com/c/aaa");
  });

  it("slot 0 sessions keep mirroring chatUrl into the shared state (legacy view)", () => {
    applyChatBinding("ws1", "https://chatgpt.com/c/aaa", "task-a", "opencode", 0);
    const saved = readControlPlaneState("ws1", "opencode");
    expect(saved?.chatUrl).toBe("https://chatgpt.com/c/aaa");
    expect(saved?.taskChats?.["task-a"]).toBe("https://chatgpt.com/c/aaa");
    expect(readSlotPointer("ws1", "opencode", 0)).toBeNull();
  });

  it("a slot >= 1 session falls back only to ITS OWN chat, never the shared one", () => {
    applyChatBinding("ws1", "https://chatgpt.com/c/other-session", null, "opencode", 0);
    // another live session's chat must not be reopened by this session
    expect(resolveChatTarget("ws1", {}, "opencode", 1)).toBeNull();
    applyChatBinding("ws1", "https://chatgpt.com/c/mine", null, "opencode", 1);
    expect(resolveChatTarget("ws1", {}, "opencode", 1)).toBe("https://chatgpt.com/c/mine");
  });

  it("task chats stay shared across sessions of one harness", () => {
    // session 1 binds task-a, session 2 binds task-b: both survive
    applyChatBinding("ws1", "https://chatgpt.com/c/aaa", "task-a", "opencode", 0);
    applyChatBinding("ws1", "https://chatgpt.com/c/bbb", "task-b", "opencode", 1);
    const saved = readControlPlaneState("ws1", "opencode");
    expect(saved?.taskChats?.["task-a"]).toBe("https://chatgpt.com/c/aaa");
    expect(saved?.taskChats?.["task-b"]).toBe("https://chatgpt.com/c/bbb");
    // a restarted session (any slot) reopens the task's chat
    expect(resolveChatTarget("ws1", { taskId: "task-b" }, "opencode", 0)).toBe("https://chatgpt.com/c/bbb");
  });
});

describe("shared-state merge lock", () => {
  it("runs the critical section and releases the lock", () => {
    const value = withStateMergeLock("ws1", "opencode", () => 42);
    expect(value).toBe(42);
    const lockFile = path.join(stateDir, "control-plane", "ws1__opencode.merge.lock");
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("steals a stale lock left by a dead process", () => {
    const lockFile = path.join(stateDir, "control-plane", "ws1__opencode.merge.lock");
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999_999 }));
    expect(withStateMergeLock("ws1", "opencode", () => "ok")).toBe("ok");
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("still runs (unlocked) when a live process holds the lock too long", () => {
    const lockFile = path.join(stateDir, "control-plane", "ws1__opencode.merge.lock");
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }));
    const started = Date.now();
    expect(withStateMergeLock("ws1", "opencode", () => "ran")).toBe("ran");
    // it waited for the 2s deadline instead of deadlocking forever
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    // a foreign live holder's lock is never removed
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it("nested re-entrant use from the same process still proceeds", () => {
    // applyChatBinding itself locks; calling it INSIDE another critical
    // section would deadlock a strict lock. The 2s deadline keeps it honest.
    const result = withStateMergeLock("ws1", "codex", () => {
      applyChatBinding("ws1", "https://chatgpt.com/c/ccc", "task-c", "codex");
      return readControlPlaneState("ws1", "codex")?.taskChats?.["task-c"];
    });
    expect(result).toBe("https://chatgpt.com/c/ccc");
  });
});
