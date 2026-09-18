import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { isBrowserLockHeld } from "./browser-lock.js";

/**
 * Session slots: how several sessions of the SAME harness run C2C in
 * parallel. Per-harness profiles serialize same-harness sessions (one
 * Chromium per profile, cross-process lock); a session slot gives every
 * control-plane process its own profile from a small, reusable pool:
 *
 *   slot 0      -> profiles/<harness>          (the pre-existing profile)
 *   slot k >= 1 -> profiles/<harness>-s<k>     (seeded from a logged-in one)
 *
 * A slot is claimed through a lease file held for the whole process
 * lifetime — across idle browser closes — and stolen when its holder died,
 * exactly like the browser lock. Slots (and their profiles) are reused by
 * later sessions, so the pool never grows beyond its cap.
 */

/** Default pool size per harness: two concurrent sessions of one harness. */
const DEFAULT_MAX_PARALLEL_SESSIONS = 2;

const MIN_PARALLEL_SESSIONS = 1;
const MAX_PARALLEL_SESSIONS = 16;

export function maxParallelSessions(): number {
  const raw = process.env.AWEHITCH_MAX_PARALLEL_SESSIONS;
  if (!raw || raw.trim() === "") return DEFAULT_MAX_PARALLEL_SESSIONS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_PARALLEL_SESSIONS;
  return Math.min(Math.max(parsed, MIN_PARALLEL_SESSIONS), MAX_PARALLEL_SESSIONS);
}

export interface SessionSlot {
  /** Pool index: 0 is the legacy per-harness profile. */
  index: number;
  /** Profile key: `<harness>` for slot 0, `<harness>-s<k>` after. */
  key: string;
  release: () => void;
}

export interface SlotHolder {
  pid: number;
  slotKey: string;
  acquiredAt: string;
}

/** Lease file guarding a session slot for one control-plane process. */
export function slotLeaseFile(slotKey: string): string {
  return path.join(getStateDir(), "control-plane", "profiles", `${slotKey}.session.lock`);
}

/** Profile key of a harness's slot k (slot 0 keeps the legacy name). */
export function slotKeyFor(harness: string, index: number): string {
  return index === 0 ? harness : `${harness}-s${index}`;
}

function readLease(file: string): SlotHolder | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SlotHolder> | null;
    if (parsed && typeof parsed.pid === "number" && typeof parsed.slotKey === "string") {
      return parsed as SlotHolder;
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

/** Who currently holds a harness slot lease, when anybody alive does. */
export function slotLeaseHolder(slotKey: string): SlotHolder | null {
  const holder = readLease(slotLeaseFile(slotKey));
  return holder && isAlive(holder.pid) ? holder : null;
}

function tryWriteLease(file: string, info: SlotHolder): boolean {
  try {
    fs.writeFileSync(file, JSON.stringify(info), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

/**
 * Claim a free session slot for this process. A slot is free when no live
 * process holds its lease and no live process drives its browser (covers a
 * pre-slot-version session sitting on the legacy profile). All slots busy
 * throws with the honest list of holders.
 */
export function claimSessionSlot(harness: string): SessionSlot {
  const max = maxParallelSessions();
  const busy: SlotHolder[] = [];
  for (let index = 0; index < max; index++) {
    const key = slotKeyFor(harness, index);
    const file = slotLeaseFile(key);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const info: SlotHolder = { pid: process.pid, slotKey: key, acquiredAt: new Date().toISOString() };
    if (tryWriteLease(file, info)) {
      return holdSlot(index, key, file, info);
    }
    const holder = readLease(file);
    if (holder && isAlive(holder.pid)) {
      busy.push(holder);
      continue;
    }
    // Stale or unreadable lease — remove it and race again.
    fs.rmSync(file, { force: true });
    if (tryWriteLease(file, info)) {
      return holdSlot(index, key, file, info);
    }
    // Lost the race to another claimer: keep scanning.
  }
  // The legacy profile may also be driven without a lease (older binary);
  // only report that as busy when it is actually held.
  const holders = busy
    .map((h) => `${h.slotKey} (pid ${h.pid})`)
    .concat(isBrowserLockHeld(harness) ? [`${harness} (browser in use, no lease)`] : [])
    .join(", ");
  throw new Error(
    `All ${max} ChatGPT session slots for harness "${harness}" are busy: ${holders}. ` +
      `Stop one of those sessions, or raise the pool with AWEHITCH_MAX_PARALLEL_SESSIONS (max ${MAX_PARALLEL_SESSIONS}).`
  );
}

function holdSlot(index: number, key: string, file: string, info: SlotHolder): SessionSlot {
  heldLeases.set(file, info);
  ensureExitRelease();
  const release = (): void => {
    try {
      const current = readLease(file);
      if (current?.pid === info.pid && current.acquiredAt === info.acquiredAt) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // Releasing must never break the caller.
    } finally {
      heldLeases.delete(file);
    }
  };
  return { index, key, release };
}

/** Leases held by this process, released by ONE exit handler. */
const heldLeases = new Map<string, SlotHolder>();
let exitHookInstalled = false;

function ensureExitRelease(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // The lease outlives idle browser closes; on abrupt exit the stale
  // files are stolen by the next claimer, so best-effort atexit is enough.
  process.once("exit", () => {
    for (const [file, info] of heldLeases) {
      try {
        const current = readLease(file);
        if (current?.pid === info.pid && current.acquiredAt === info.acquiredAt) {
          fs.rmSync(file, { force: true });
        }
      } catch {
        // best effort
      }
    }
  });
}
