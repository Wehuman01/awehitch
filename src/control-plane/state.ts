import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

/**
 * Control-plane proxy state: which ChatGPT conversation is bound to which
 * workspace, and the Playwright profile directory (login state lives there).
 * All of it stays in the OS state dir, never in the project.
 */

export interface ControlPlaneState {
  /** ChatGPT conversation URL currently used for [C2C] messages. */
  chatUrl?: string;
  /** Human-readable conversation title. */
  title?: string;
  /** ChatGPT Project collection URL, when project mode is used. */
  projectUrl?: string;
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
 * the ChatGPT login isolated from the user's daily Chrome profile and lets
 * the proxy relaunch headless between sessions.
 */
export function browserProfileDir(workspaceId: string): string {
  return path.join(getStateDir(), "control-plane", "browser-profile", workspaceId);
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
