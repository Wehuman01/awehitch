import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, sessionKey, writeSecureJson } from "../config/paths.js";
import { isBrowserLockHeld } from "./browser-lock.js";
import { readSession } from "../session/state.js";

/**
 * Control-plane proxy state: which ChatGPT conversation is bound to which
 * workspace, and the Playwright profile directories (login state lives
 * there). All of it stays in the OS state dir, never in the project.
 *
 * Keyed by the session key (workspace + optional harness): each harness
 * gets its own chat bindings, checkpoint and browser profile, which is
 * what makes parallel C2C across harnesses safe. Within one harness,
 * concurrent sessions claim session SLOTS (see slot.ts): task chats are
 * merged into the shared file under a cross-process lock (they must
 * survive session restarts), while each session's own chat pointer is
 * private — slot 0 keeps it in the shared file (legacy), slots >= 1 keep
 * it in `<key>.slot-<n>.json`.
 */

export interface ControlPlaneState {
  /** Conversation URL last used for [C2C] messages (slot 0 / single-session mirror). */
  chatUrl?: string;
  /** Human-readable conversation title. */
  title?: string;
  /** ChatGPT Project collection URL, when project mode is used. */
  projectUrl?: string;
  /** taskId -> bound ChatGPT conversation URL. One chat per task. */
  taskChats?: Record<string, string>;
  savedAt: string;
}

export function controlPlaneStateFile(workspaceId: string, harness?: string): string {
  return path.join(getStateDir(), "control-plane", `${sessionKey(workspaceId, harness)}.json`);
}

export function readControlPlaneState(workspaceId: string, harness?: string): ControlPlaneState | null {
  return readJsonIfExists<ControlPlaneState>(controlPlaneStateFile(workspaceId, harness));
}

export function writeControlPlaneState(
  workspaceId: string,
  state: ControlPlaneState,
  harness?: string
): ControlPlaneState {
  writeSecureJson(controlPlaneStateFile(workspaceId, harness), state);
  return state;
}

export function mergeControlPlaneState(
  workspaceId: string,
  patch: Partial<Omit<ControlPlaneState, "savedAt">>,
  harness?: string
): ControlPlaneState {
  const previous = readControlPlaneState(workspaceId, harness);
  const next: ControlPlaneState = {
    ...previous,
    ...patch,
    savedAt: new Date().toISOString(),
  };
  writeControlPlaneState(workspaceId, next, harness);
  return next;
}

// ---------------------------------------------------------------- browser profiles

/** Layout before per-harness profiles: the one shared profile directory. */
function legacyBrowserProfileDir(): string {
  return path.join(getStateDir(), "control-plane", "browser-profile", "shared");
}

/** Persistent Chromium profile for a session key (login state lives here). */
export function browserProfileDir(harness?: string): string {
  return path.join(getStateDir(), "control-plane", "profiles", harness ?? "default");
}

/**
 * Seed a profile from a logged-in one so another session (or harness) never
 * needs its own ChatGPT login. Copying a live Chromium profile can corrupt
 * the seed, so sources holding their browser lock are skipped; candidates
 * are the master profile first, then any other unlocked profile (a second
 * opencode session may start while codex drives the master). When nothing
 * is copyable the session starts with an empty profile and logs in itself.
 */
export function ensureBrowserProfile(profileKey?: string): string {
  const dir = browserProfileDir(profileKey);
  if (fs.existsSync(dir)) return dir;

  let source: string | null = null;
  if (profileKey) {
    for (const candidate of seedCandidates()) {
      if (candidate.dir === dir) continue;
      if (!isBrowserLockHeld(candidate.lockKey)) {
        source = candidate.dir;
        break;
      }
    }
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  if (source) {
    try {
      fs.cpSync(source, dir, { recursive: true });
    } catch {
      // A broken seed is worse than none: fall back to an empty profile.
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Directories that may hold a logged-in seed, best candidate first, each
 * with the profile key its browser lock lives under.
 */
function seedCandidates(): { dir: string; lockKey: string | undefined }[] {
  const candidates: { dir: string; lockKey: string | undefined }[] = [];
  const master = browserProfileDir();
  if (fs.existsSync(master)) candidates.push({ dir: master, lockKey: "default" });
  const legacy = legacyBrowserProfileDir();
  if (fs.existsSync(legacy)) candidates.push({ dir: legacy, lockKey: undefined });
  const pool = path.join(getStateDir(), "control-plane", "profiles");
  try {
    for (const entry of fs.readdirSync(pool).sort()) {
      const full = path.join(pool, entry);
      if (fs.statSync(full).isDirectory()) candidates.push({ dir: full, lockKey: entry });
    }
  } catch {
    // No profiles dir yet: master/legacy above are all there is.
  }
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.dir)) return false;
    seen.add(c.dir);
    return true;
  });
}

/**
 * One-time migration: adopt the pre-existing shared profile as the default
 * (master) profile so the existing ChatGPT login survives the upgrade.
 * Cheap rename, done before any profile is seeded.
 */
export function migrateLegacyBrowserProfile(): void {
  const legacy = legacyBrowserProfileDir();
  const master = browserProfileDir();
  if (!fs.existsSync(legacy) || fs.existsSync(master)) return;
  fs.mkdirSync(path.dirname(master), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(legacy, master);
  } catch {
    // Cross-device or locked: leave it; the master profile will be created
    // fresh and the user logs in once more.
  }
}

export function normalizeChatUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.hostname !== "chatgpt.com" && parsed.hostname !== "www.chatgpt.com") return null;
    if (parsed.pathname === "/" || parsed.pathname === "") return "https://chatgpt.com/";
    // Trailing slashes are copy-paste noise: "/c/<id>/" and "/c/<id>" are
    // the same conversation and must compare equal (watch-mode refusal and
    // the one-session-per-chat registry key on it).
    return `https://chatgpt.com${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * Legacy fallback: sessions written before task-scoped chats stored one URL
 * per workspace. It still identifies the chat of the checkpoint's task, so
 * only that task may claim it.
 */
function legacyTaskChatUrl(workspaceId: string, taskId: string, harness?: string): string | null {
  const session = readSession(workspaceId, harness);
  const checkpoint = session?.checkpoint;
  if (!checkpoint || checkpoint.taskId !== taskId) return null;
  const url = checkpoint.chatUrl ?? session?.url;
  if (!url) return null;
  return normalizeChatUrl(url);
}

/**
 * Resolve which URL openConversation should navigate to.
 * Order: bound task chat > legacy session fallback > this session's saved
 * chat (only without task context). Returns null when a NEW chat should be
 * opened (unknown task, `fresh: true`, or nothing saved at all).
 *
 * A session slot >= 1 only ever falls back to ITS OWN chat pointer — never
 * to the shared workspace chatUrl, which belongs to another live session.
 */
export function resolveChatTarget(
  workspaceId: string,
  input: { taskId?: string; fresh?: boolean } = {},
  harness?: string,
  slotIndex?: number
): string | null {
  const taskId = input.taskId?.trim() || null;
  if (taskId) {
    if (input.fresh) return null;
    const bound = readControlPlaneState(workspaceId, harness)?.taskChats?.[taskId];
    if (bound) return bound;
    return legacyTaskChatUrl(workspaceId, taskId, harness);
  }
  if (input.fresh) return null;
  if (slotIndex !== undefined && slotIndex >= 1) {
    return readSlotPointer(workspaceId, harness, slotIndex);
  }
  return readControlPlaneState(workspaceId, harness)?.chatUrl ?? null;
}

/**
 * Persist a conversation binding. `/c/…` URLs bind to the active task (when
 * one is open) in the SHARED per-harness state — task chats must survive
 * session restarts, so every session of a harness merges into one file
 * under a short cross-process lock. The workspace-level chatUrl mirror is
 * this session's own pointer: slot 0 keeps writing it into the shared file
 * (legacy single-session view), slots >= 1 keep it in their private file.
 * The home page has no conversation id yet and binds nothing. Returns the
 * state actually written, or null when nothing changed.
 */
export function applyChatBinding(
  workspaceId: string,
  url: string,
  taskId: string | null,
  harness?: string,
  slotIndex?: number
): ControlPlaneState | null {
  if (!url.startsWith("https://chatgpt.com/c/")) return null;
  const privateSlot = slotIndex !== undefined && slotIndex >= 1;
  const result = withStateMergeLock(workspaceId, harness, () => {
    const saved = readControlPlaneState(workspaceId, harness);
    const taskChats = { ...(saved?.taskChats ?? {}) };
    let changed = false;
    if (taskId && taskChats[taskId] !== url) {
      taskChats[taskId] = url;
      changed = true;
    }
    if (!privateSlot && saved?.chatUrl !== url) changed = true;
    if (!changed) return null;
    const next: ControlPlaneState = {
      ...(saved ?? {}),
      savedAt: new Date().toISOString(),
    };
    if (!privateSlot) next.chatUrl = url;
    if (taskId) next.taskChats = taskChats;
    return writeControlPlaneState(workspaceId, next, harness);
  });
  if (privateSlot) writeSlotPointer(workspaceId, harness, slotIndex, url);
  return result;
}

// ---------------------------------------------------------------- session pointers

/** Private chat pointer of a session slot >= 1 (slot 0 lives in the shared file). */
export function slotPointerFile(workspaceId: string, harness?: string, slotIndex?: number): string {
  const key = sessionKey(workspaceId, harness);
  return path.join(getStateDir(), "control-plane", `${key}.slot-${slotIndex ?? 0}.json`);
}

export function readSlotPointer(workspaceId: string, harness?: string, slotIndex?: number): string | null {
  return readJsonIfExists<ControlPlaneState>(slotPointerFile(workspaceId, harness, slotIndex))?.chatUrl ?? null;
}

export function writeSlotPointer(
  workspaceId: string,
  harness: string | undefined,
  slotIndex: number | undefined,
  chatUrl: string
): void {
  // Idle-close recovery re-binds the same URL on every poll; skip the
  // rewrite when the pointer is already current.
  if (readSlotPointer(workspaceId, harness, slotIndex) === chatUrl) return;
  writeSecureJson(slotPointerFile(workspaceId, harness, slotIndex), {
    chatUrl,
    savedAt: new Date().toISOString(),
  } satisfies ControlPlaneState);
}

// ---------------------------------------------------------------- merge lock

/**
 * Cross-process read-modify-write lock for the shared per-harness state.
 * Advisory and short-lived: two same-harness sessions merge their task
 * bindings instead of racing last-writer-wins. A stale lock (dead pid) is
 * stolen; when the lock stays contested past the deadline the critical
 * section runs anyway — the atomic write keeps the worst case at today's
 * behaviour (one lost update), which beats deadlocking a tool call.
 */
export function withStateMergeLock<T>(
  workspaceId: string,
  harness: string | undefined,
  fn: () => T
): T {
  return withNamedStateLock(`${sessionKey(workspaceId, harness)}.merge`, fn);
}

/** The same primitive under an explicit lock name (machine-level files). */
export function withNamedStateLock<T>(name: string, fn: () => T): T {
  const file = path.join(getStateDir(), "control-plane", `${name}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const info = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });
  const deadline = Date.now() + 2000;
  let locked = false;
  for (;;) {
    try {
      fs.writeFileSync(file, info, { flag: "wx" });
      locked = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = readLockPid(file);
    if (holder !== null && !isPidAlive(holder)) {
      // Stale lock from a dead process: steal it.
      fs.rmSync(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  const release = (): void => {
    if (!locked) return;
    try {
      const holder = readLockPid(file);
      if (holder === process.pid) fs.rmSync(file, { force: true });
    } catch {
      // Releasing must never break the caller.
    }
  };
  try {
    return fn();
  } finally {
    release();
  }
}

function readLockPid(file: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
