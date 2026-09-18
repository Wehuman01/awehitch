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
 * Every piece is keyed by the session key (workspace + optional harness):
 * each harness gets its own chat bindings, checkpoint and browser profile,
 * which is what makes parallel C2C across harnesses safe.
 */

export interface ControlPlaneState {
  /** Conversation URL last used for [C2C] messages (workspace-level mirror). */
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
 * Seed a per-harness profile from the logged-in master so a second harness
 * never needs its own ChatGPT login. Copying a live Chromium profile can
 * corrupt the seed, so a source holding its browser lock is not copied —
 * the harness then starts with an empty profile and logs in itself.
 */
export function ensureBrowserProfile(harness?: string): string {
  const dir = browserProfileDir(harness);
  if (fs.existsSync(dir)) return dir;

  const legacy = legacyBrowserProfileDir();
  let source: string | null = null;
  if (harness) {
    if (fs.existsSync(browserProfileDir()) && !isBrowserLockHeld("default")) {
      source = browserProfileDir();
    } else if (fs.existsSync(legacy) && !isBrowserLockHeld()) {
      source = legacy;
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
    if (parsed.pathname === "/") return "https://chatgpt.com/";
    return `https://chatgpt.com${parsed.pathname}`;
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
 * Order: bound task chat > legacy session fallback > saved workspace chat
 * (only without task context). Returns null when a NEW chat should be opened
 * (unknown task, `fresh: true`, or nothing saved at all).
 */
export function resolveChatTarget(
  workspaceId: string,
  input: { taskId?: string; fresh?: boolean } = {},
  harness?: string
): string | null {
  const taskId = input.taskId?.trim() || null;
  if (taskId) {
    if (input.fresh) return null;
    const bound = readControlPlaneState(workspaceId, harness)?.taskChats?.[taskId];
    if (bound) return bound;
    return legacyTaskChatUrl(workspaceId, taskId, harness);
  }
  if (input.fresh) return null;
  return readControlPlaneState(workspaceId, harness)?.chatUrl ?? null;
}

/**
 * Persist a conversation binding. `/c/…` URLs bind to the active task (when
 * one is open) and mirror to the workspace-level chatUrl; the home page has
 * no conversation id yet and binds nothing. Returns the state actually
 * written, or null when nothing changed.
 */
export function applyChatBinding(
  workspaceId: string,
  url: string,
  taskId: string | null,
  harness?: string
): ControlPlaneState | null {
  if (!url.startsWith("https://chatgpt.com/c/")) return null;
  const saved = readControlPlaneState(workspaceId, harness);
  const taskChats = { ...(saved?.taskChats ?? {}) };
  let changed = saved?.chatUrl !== url;
  if (taskId && taskChats[taskId] !== url) {
    taskChats[taskId] = url;
    changed = true;
  }
  if (!changed) return null;
  const next: ControlPlaneState = {
    ...(saved ?? {}),
    chatUrl: url,
    savedAt: new Date().toISOString(),
  };
  if (taskId) next.taskChats = taskChats;
  return writeControlPlaneState(workspaceId, next, harness);
}
