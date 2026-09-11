import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  applyChatBinding,
  browserProfileDir,
  controlPlaneStateFile,
  mergeControlPlaneState,
  normalizeChatUrl,
  readControlPlaneState,
  resolveChatTarget,
  writeControlPlaneState,
} from "../src/control-plane/state.js";
import { writeSession } from "../src/session/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  stateDir = makeTmpDir("control-plane-state");
  previousStateDir = process.env.AWEHITCH_STATE_DIR;
  process.env.AWEHITCH_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.AWEHITCH_STATE_DIR;
  else process.env.AWEHITCH_STATE_DIR = previousStateDir;
  cleanup(stateDir);
});

describe("control-plane state", () => {
  it("persists and reads the bound conversation", () => {
    writeControlPlaneState("ws123", {
      chatUrl: "https://chatgpt.com/c/abc",
      savedAt: new Date().toISOString(),
    });
    const saved = readControlPlaneState("ws123");
    expect(saved?.chatUrl).toBe("https://chatgpt.com/c/abc");
    // state file lives under the OS state dir, never in the project
    expect(controlPlaneStateFile("ws123")).toContain(stateDir);
    // permissions are owner-only
    const mode = fs.statSync(controlPlaneStateFile("ws123")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("merges patches without losing saved fields", () => {
    writeControlPlaneState("ws123", {
      chatUrl: "https://chatgpt.com/c/abc",
      savedAt: new Date().toISOString(),
    });
    const next = mergeControlPlaneState("ws123", { title: "C2C awehitch" });
    expect(next.chatUrl).toBe("https://chatgpt.com/c/abc");
    expect(next.title).toBe("C2C awehitch");
    expect(readControlPlaneState("ws123")?.title).toBe("C2C awehitch");
  });

  it("isolates state per workspace", () => {
    writeControlPlaneState("ws-a", { chatUrl: "https://chatgpt.com/c/a", savedAt: "" });
    writeControlPlaneState("ws-b", { chatUrl: "https://chatgpt.com/c/b", savedAt: "" });
    expect(readControlPlaneState("ws-a")?.chatUrl).toBe("https://chatgpt.com/c/a");
    expect(readControlPlaneState("ws-b")?.chatUrl).toBe("https://chatgpt.com/c/b");
  });

  it("shares one browser profile across workspaces (one login per machine)", () => {
    const a = browserProfileDir();
    const b = browserProfileDir();
    expect(a).toBe(b);
    expect(a).toContain(path.join(stateDir, "control-plane", "browser-profile"));
  });
});

describe("normalizeChatUrl", () => {
  it("accepts chatgpt.com conversation URLs", () => {
    expect(normalizeChatUrl("https://chatgpt.com/c/abc-123")).toBe("https://chatgpt.com/c/abc-123");
    expect(normalizeChatUrl(" https://www.chatgpt.com/c/xyz ")).toBe("https://chatgpt.com/c/xyz");
    expect(normalizeChatUrl("https://chatgpt.com/")).toBe("https://chatgpt.com/");
  });

  it("rejects non-ChatGPT URLs and garbage", () => {
    expect(normalizeChatUrl("https://evil.example.com/c/abc")).toBeNull();
    expect(normalizeChatUrl("not a url")).toBeNull();
    expect(normalizeChatUrl("")).toBeNull();
  });
});

describe("task chat bindings", () => {
  it("resolves bound task chats and falls back to legacy sessions", () => {
    // Unknown task with no state → new chat.
    expect(resolveChatTarget("ws-task", { taskId: "t1" })).toBeNull();

    // Legacy session: the checkpoint's task may claim the workspace chat.
    writeSession("ws-task", {
      url: "https://chatgpt.com/c/legacy",
      savedAt: "2026-01-01T00:00:00.000Z",
      checkpoint: {
        taskId: "t1",
        iteration: 2,
        protocolState: "EXECUTING",
        waitingFor: "none",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(resolveChatTarget("ws-task", { taskId: "t1" })).toBe("https://chatgpt.com/c/legacy");
    // A different task never claims the legacy chat.
    expect(resolveChatTarget("ws-task", { taskId: "t2" })).toBeNull();

    // An explicit binding wins over the legacy fallback.
    applyChatBinding("ws-task", "https://chatgpt.com/c/new", "t1");
    expect(resolveChatTarget("ws-task", { taskId: "t1" })).toBe("https://chatgpt.com/c/new");
    // fresh forces a replacement chat even when a binding exists.
    expect(resolveChatTarget("ws-task", { taskId: "t1", fresh: true })).toBeNull();
  });

  it("binds per task, mirrors to the workspace chat, and ignores the home page", () => {
    applyChatBinding("ws-mirror", "https://chatgpt.com/c/one", "t1");
    applyChatBinding("ws-mirror", "https://chatgpt.com/c/two", "t2");
    const saved = readControlPlaneState("ws-mirror");
    expect(saved?.taskChats).toEqual({
      t1: "https://chatgpt.com/c/one",
      t2: "https://chatgpt.com/c/two",
    });
    // chatUrl mirrors the last used conversation, for task-less callers.
    expect(saved?.chatUrl).toBe("https://chatgpt.com/c/two");
    expect(resolveChatTarget("ws-mirror")).toBe("https://chatgpt.com/c/two");

    // The home page has no conversation id yet — nothing to bind.
    expect(applyChatBinding("ws-mirror", "https://chatgpt.com/", "t3")).toBeNull();
    expect(readControlPlaneState("ws-mirror")?.taskChats?.t3).toBeUndefined();
  });
});
