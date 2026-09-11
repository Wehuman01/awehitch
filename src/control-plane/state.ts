import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { readSession } from "../session/state.js";

/**
 * Control-plane proxy state: which ChatGPT conversation is bound to which
 * workspace, and the Playwright profile directory (login state lives there).
 * All of it stays in the OS state dir, never in the project.
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

export function controlPlaneStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "control-plane", `${workspaceId}.json`);
}

export function readControlPlaneState(workspaceId: string): ControlPlaneState | null {
  return readJsonIfExists<ControlPlaneState>(controlPlaneStateFile(workspaceId));
}

export function writeControlPlaneState(
  workspaceId: string,
  state: ControlPlaneState
): ControlPlaneState {
  writeSecureJson(controlPlaneStateFile(workspaceId), state);
  return state;
}

export function mergeControlPlaneState(
  workspaceId: string,
  patch: Partial<Omit<ControlPlaneState, "savedAt">>
): ControlPlaneState {
  const previous = readControlPlaneState(workspaceId);
  const next: ControlPlaneState = {
    ...previous,
    ...patch,
    savedAt: new Date().toISOString(),
  };
  writeControlPlaneState(workspaceId, next);
  return next;
}

/**
 * Persistent browser profile for the control plane. A dedicated profile keeps
 * the ChatGPT login isolated from the user's daily Chrome profile.
 *
 * The profile is SHARED by every workspace on the machine: one ChatGPT login
 * instead of one per project. Only one process may hold it at a time (see
 * `control-plane/browser-lock.ts`); sessions release the browser after a few
 * idle minutes so a parked workspace never blocks another.
 */
export function browserProfileDir(): string {
  return path.join(getStateDir(), "control-plane", "browser-profile", "shared");
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
function legacyTaskChatUrl(workspaceId: string, taskId: string): string | null {
  const session = readSession(workspaceId);
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
  input: { taskId?: string; fresh?: boolean } = {}
): string | null {
  const taskId = input.taskId?.trim() || null;
  if (taskId) {
    if (input.fresh) return null;
    const bound = readControlPlaneState(workspaceId)?.taskChats?.[taskId];
    if (bound) return bound;
    return legacyTaskChatUrl(workspaceId, taskId);
  }
  if (input.fresh) return null;
  return readControlPlaneState(workspaceId)?.chatUrl ?? null;
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
  taskId: string | null
): ControlPlaneState | null {
  if (!url.startsWith("https://chatgpt.com/c/")) return null;
  const saved = readControlPlaneState(workspaceId);
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
  return writeControlPlaneState(workspaceId, next);
}
