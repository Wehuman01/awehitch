import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";

/**
 * Cross-process lock for the shared control-plane browser profile.
 *
 * Chromium refuses a second process on the same user-data-dir on its own, but
 * the failure is a raw Playwright stack trace. This lock reports who holds
 * the browser and steals a lock left behind by a crashed process. It is held
 * for the whole browser lifetime — as long as Chromium's own singleton lock —
 * not just for the launch.
 */

export interface BrowserLockInfo {
  pid: number;
  profile: string;
  acquiredAt: string;
}

export interface BrowserLock {
  info: BrowserLockInfo;
  release: () => void;
}

export type BrowserLockAcquire =
  | { lock: BrowserLock }
  | { heldBy: BrowserLockInfo };

/**
 * One lock per browser profile. Profiles are named by harness ("default"
 * for harness-less callers), so different harnesses hold different browsers
 * and can drive ChatGPT truly in parallel.
 */
export function browserProfileLockFile(profile?: string): string {
  if (!profile) return path.join(getStateDir(), "control-plane", "browser-profile.lock");
  return path.join(getStateDir(), "control-plane", "profiles", `${profile}.lock`);
}

function readLock(file: string): BrowserLockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BrowserLockInfo> | null;
    if (parsed && typeof parsed.pid === "number" && typeof parsed.profile === "string") {
      return parsed as BrowserLockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

/** True when a process with this pid exists (EPERM also means it exists). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when a live process currently holds the named profile's browser. */
export function isBrowserLockHeld(profile?: string): boolean {
  const holder = readLock(browserProfileLockFile(profile));
  return holder !== null && isAlive(holder.pid);
}

/**
 * Acquire the named profile's lock. Returns `heldBy` when a live process
 * owns the browser; a lock from a dead process is stolen (crash leftover).
 */
export function acquireBrowserLock(profile: string): BrowserLockAcquire {
  const file = browserProfileLockFile(profile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const info: BrowserLockInfo = {
    pid: process.pid,
    profile,
    acquiredAt: new Date().toISOString(),
  };
  for (;;) {
    try {
      // 'wx' fails if the file exists — the atomic create-or-lose that keeps
      // two simultaneous acquirers from both winning.
      fs.writeFileSync(file, JSON.stringify(info), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLock(file);
      if (holder && holder.pid === process.pid) {
        // Same process re-acquiring: treat as self-owned and steal.
        fs.rmSync(file, { force: true });
        continue;
      }
      if (holder && isAlive(holder.pid)) return { heldBy: holder };
      // Stale or unreadable lock — remove it and race again.
      fs.rmSync(file, { force: true });
      continue;
    }
    return {
      lock: {
        info,
        release: () => {
          try {
            // Remove the file only while it is still OURS: never a newer
            // holder's, and never twice.
            const current = readLock(file);
            if (current?.pid === info.pid && current.acquiredAt === info.acquiredAt) {
              fs.rmSync(file, { force: true });
            }
          } catch {
            // Releasing must never break the caller.
          }
        },
      },
    };
  }
}
