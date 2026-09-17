import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { acquireBrowserLock, browserProfileLockFile } from "../src/control-plane/browser-lock.js";
import { cleanup, makeTmpDir } from "./helpers.js";

/**
 * Cross-process lock for the shared control-plane browser profile.
 *
 * The property that matters: two acquirers can never both hold the lock, a
 * lock left by a crashed process (dead pid) is stolen, and a live holder is
 * reported instead of fought with.
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
    const first = acquireBrowserLock("ws-a");
    if (!("lock" in first)) throw new Error("first acquire must win");
    expect(first.lock.info.pid).toBe(process.pid);
    expect(first.lock.info.workspaceId).toBe("ws-a");

    const raw = JSON.parse(fs.readFileSync(browserProfileLockFile(), "utf8"));
    expect(raw.pid).toBe(process.pid);
    expect(raw.workspaceId).toBe("ws-a");
    first.lock.release();
  });

  it("allows the same process to re-acquire the lock (reentrancy)", () => {
    const first = acquireBrowserLock("ws-a");
    if (!("lock" in first)) throw new Error("first acquire must win");
    const second = acquireBrowserLock("ws-b");
    expect("lock" in second).toBe(true);
    if ("lock" in second) {
      expect(second.lock.info.pid).toBe(process.pid);
      expect(second.lock.info.workspaceId).toBe("ws-b");
      second.lock.release();
    }
    first.lock.release();
  });

  it("reports a live holder from a different process instead of granting a second lock", () => {
    const first = acquireBrowserLock("ws-a");
    if (!("lock" in first)) throw new Error("first acquire must win");
    // Spawn a detached child so we have a guaranteed-live pid that is not ours.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    child.unref();
    const otherPid = child.pid;
    if (!otherPid) throw new Error("failed to spawn helper");
    fs.writeFileSync(
      browserProfileLockFile(),
      JSON.stringify({ pid: otherPid, workspaceId: "ws-other", acquiredAt: new Date().toISOString() })
    );
    const second = acquireBrowserLock("ws-b");
    expect("heldBy" in second).toBe(true);
    if ("heldBy" in second) {
      expect(second.heldBy.pid).toBe(otherPid);
      expect(second.heldBy.workspaceId).toBe("ws-other");
    }
    try {
      process.kill(otherPid, "SIGKILL");
    } catch {
      // ignore
    }
    first.lock.release();
  });

  it("grants the lock again after release", () => {
    const first = acquireBrowserLock("ws-a");
    if (!("lock" in first)) throw new Error("first acquire must win");
    first.lock.release();
    expect(fs.existsSync(browserProfileLockFile())).toBe(false);

    const second = acquireBrowserLock("ws-b");
    expect("lock" in second).toBe(true);
    if ("lock" in second) second.lock.release();
  });

  it("steals a lock left by a crashed process", () => {
    const pid = deadPid();
    fs.mkdirSync(path.dirname(browserProfileLockFile()), { recursive: true });
    fs.writeFileSync(
      browserProfileLockFile(),
      JSON.stringify({ pid, workspaceId: "ws-dead", acquiredAt: new Date().toISOString() })
    );
    const acquired = acquireBrowserLock("ws-live");
    expect("lock" in acquired).toBe(true);
    if ("lock" in acquired) acquired.lock.release();
  });

  it("never removes a newer holder's lock on release", () => {
    const first = acquireBrowserLock("ws-a");
    if (!("lock" in first)) throw new Error("first acquire must win");
    // Simulate a takeover after the fact: a different lock is now on disk.
    const newer = { pid: process.pid, workspaceId: "ws-b", acquiredAt: "2099-01-01T00:00:00.000Z" };
    fs.writeFileSync(browserProfileLockFile(), JSON.stringify(newer));
    first.lock.release();
    expect(fs.existsSync(browserProfileLockFile())).toBe(true);
    fs.rmSync(browserProfileLockFile(), { force: true });
  });

  it("replaces an unreadable junk lock file", () => {
    fs.mkdirSync(path.dirname(browserProfileLockFile()), { recursive: true });
    fs.writeFileSync(browserProfileLockFile(), "not json at all");
    const acquired = acquireBrowserLock("ws-a");
    expect("lock" in acquired).toBe(true);
    if ("lock" in acquired) acquired.lock.release();
  });
});
