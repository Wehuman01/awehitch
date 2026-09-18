import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  acquireBrowserLock,
  browserProfileLockFile,
  isBrowserLockHeld,
} from "../src/control-plane/browser-lock.js";
import { cleanup, makeTmpDir } from "./helpers.js";

/**
 * Cross-process locks for the per-harness control-plane browser profiles.
 *
 * The properties that matter: two acquirers can never both hold one lock, a
 * lock left by a crashed process (dead pid) is stolen, a live holder is
 * reported instead of fought with, and different profiles never block each
 * other (that independence is what makes parallel C2C across harnesses
 * possible).
 */

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  stateDir = makeTmpDir("browser-lock");
  previousStateDir = process.env.AWEHITCH_STATE_DIR;
  process.env.AWEHITCH_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.AWEHITCH_STATE_DIR;
  else process.env.AWEHITCH_STATE_DIR = previousStateDir;
  cleanup(stateDir);
});

/** A pid guaranteed to be dead: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

describe("browser profile lock", () => {
  it("lets the first acquirer win and records who holds it", () => {
    const first = acquireBrowserLock("codex");
    if (!("lock" in first)) throw new Error("first acquire must win");
    expect(first.lock.info.pid).toBe(process.pid);
    expect(first.lock.info.profile).toBe("codex");

    const raw = JSON.parse(fs.readFileSync(browserProfileLockFile("codex"), "utf8"));
    expect(raw.pid).toBe(process.pid);
    expect(raw.profile).toBe("codex");
    first.lock.release();
  });

  it("keeps different profiles independent", () => {
    const first = acquireBrowserLock("codex");
    if (!("lock" in first)) throw new Error("first acquire must win");
    // Another profile's lock must not be fought over — parallel harnesses.
    const second = acquireBrowserLock("opencode");
    expect("lock" in second).toBe(true);
    if ("lock" in second) second.lock.release();
    expect(isBrowserLockHeld("codex")).toBe(true);
    expect(isBrowserLockHeld("opencode")).toBe(false);
    first.lock.release();
    expect(isBrowserLockHeld("codex")).toBe(false);
  });

  it("reports a live holder from a different process instead of granting a second lock", () => {
    const first = acquireBrowserLock("codex");
    if (!("lock" in first)) throw new Error("first acquire must win");
    // Spawn a detached child so we have a guaranteed-live pid that is not ours.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    child.unref();
    const otherPid = child.pid;
    if (!otherPid) throw new Error("failed to spawn helper");
    fs.writeFileSync(
      browserProfileLockFile("default"),
      JSON.stringify({ pid: otherPid, profile: "default", acquiredAt: new Date().toISOString() })
    );
    const second = acquireBrowserLock("default");
    expect("heldBy" in second).toBe(true);
    if ("heldBy" in second) {
      expect(second.heldBy.pid).toBe(otherPid);
      expect(second.heldBy.profile).toBe("default");
    }
    try {
      process.kill(otherPid, "SIGKILL");
    } catch {
      // ignore
    }
    first.lock.release();
  });

  it("grants the lock again after release", () => {
    const first = acquireBrowserLock("codex");
    if (!("lock" in first)) throw new Error("first acquire must win");
    first.lock.release();
    expect(fs.existsSync(browserProfileLockFile("codex"))).toBe(false);

    const second = acquireBrowserLock("codex");
    expect("lock" in second).toBe(true);
    if ("lock" in second) second.lock.release();
  });

  it("steals a lock left by a crashed process", () => {
    const pid = deadPid();
    fs.mkdirSync(path.dirname(browserProfileLockFile("codex")), { recursive: true });
    fs.writeFileSync(
      browserProfileLockFile("codex"),
      JSON.stringify({ pid, profile: "codex", acquiredAt: new Date().toISOString() })
    );
    const acquired = acquireBrowserLock("codex");
    expect("lock" in acquired).toBe(true);
    if ("lock" in acquired) acquired.lock.release();
  });

  it("never removes a newer holder's lock on release", () => {
    const first = acquireBrowserLock("codex");
    if (!("lock" in first)) throw new Error("first acquire must win");
    // Simulate a takeover after the fact: a different lock is now on disk.
    const newer = { pid: process.pid, profile: "opencode", acquiredAt: "2099-01-01T00:00:00.000Z" };
    fs.writeFileSync(browserProfileLockFile("codex"), JSON.stringify(newer));
    first.lock.release();
    expect(fs.existsSync(browserProfileLockFile("codex"))).toBe(true);
    fs.rmSync(browserProfileLockFile("codex"), { force: true });
  });

  it("replaces an unreadable junk lock file", () => {
    fs.mkdirSync(path.dirname(browserProfileLockFile("codex")), { recursive: true });
    fs.writeFileSync(browserProfileLockFile("codex"), "not json at all");
    const acquired = acquireBrowserLock("codex");
    expect("lock" in acquired).toBe(true);
    if ("lock" in acquired) acquired.lock.release();
  });
});
