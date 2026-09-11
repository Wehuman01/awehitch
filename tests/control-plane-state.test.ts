import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  browserProfileDir,
  controlPlaneStateFile,
  mergeControlPlaneState,
  normalizeChatUrl,
  readControlPlaneState,
  writeControlPlaneState,
} from "../src/control-plane/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  stateDir = makeTmpDir("control-plane-state");
  previousStateDir = process.env.AWEMIND_STATE_DIR;
  process.env.AWEMIND_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.AWEMIND_STATE_DIR;
  else process.env.AWEMIND_STATE_DIR = previousStateDir;
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
    const next = mergeControlPlaneState("ws123", { title: "C2C awemind" });
    expect(next.chatUrl).toBe("https://chatgpt.com/c/abc");
    expect(next.title).toBe("C2C awemind");
    expect(readControlPlaneState("ws123")?.title).toBe("C2C awemind");
  });

  it("isolates state per workspace", () => {
    writeControlPlaneState("ws-a", { chatUrl: "https://chatgpt.com/c/a", savedAt: "" });
    writeControlPlaneState("ws-b", { chatUrl: "https://chatgpt.com/c/b", savedAt: "" });
    expect(readControlPlaneState("ws-a")?.chatUrl).toBe("https://chatgpt.com/c/a");
    expect(readControlPlaneState("ws-b")?.chatUrl).toBe("https://chatgpt.com/c/b");
  });

  it("gives each workspace its own browser profile directory", () => {
    const a = browserProfileDir("ws-a");
    const b = browserProfileDir("ws-b");
    expect(a).not.toBe(b);
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
