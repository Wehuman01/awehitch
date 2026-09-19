/**
 * Machine-level dispatch watch state.
 *
 * The dispatch watcher (running inside the bridge process) watches ONE
 * user-owned ChatGPT conversation and spawns the configured coding agent
 * for each user-authorized dispatch. The watch is machine-level state —
 * it must survive agent sessions and CLI exits, and the agent does not
 * need to be running for the watch to exist. Manual conversation binding
 * (per-workspace control-plane state, set via open_chat) stays separate:
 * this file only serves the watcher.
 */

import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import type { HarnessId } from "../adapters/paths.js";
import { normalizeChatUrl } from "../control-plane/state.js";

export interface DispatchWatch {
  /** Workspace root the dispatched agent runs in (absolute). */
  workspaceRoot: string;
  /** The watched conversation (normalized chatgpt.com/c/… URL). */
  chatUrl: string;
  /** Harness to spawn; omit to auto-detect (or let the directive name one). */
  harness?: HarnessId;
  /** Command override for the harness binary (split on spaces, no shell). */
  command?: string;
  /** Conversation the [C2C] FOLLOW protocol note was already sent to. */
  notedUrl?: string;
  /** Body of the last executed directive — dedups a re-fire after restart. */
  lastDirective?: string;
  updatedAt: string;
}

export function dispatchStateFile(): string {
  return path.join(getStateDir(), "dispatch.json");
}

export function readDispatchWatch(): DispatchWatch | null {
  const file = dispatchStateFile();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.workspaceRoot !== "string" || typeof w.chatUrl !== "string") return null;
  if (!fs.existsSync(w.workspaceRoot)) return null;
  const chatUrl = normalizeChatUrl(w.chatUrl);
  if (!chatUrl) return null;
  const watch: DispatchWatch = {
    workspaceRoot: w.workspaceRoot,
    chatUrl,
    updatedAt: typeof w.updatedAt === "string" ? w.updatedAt : new Date().toISOString(),
  };
  if (w.harness === "codex" || w.harness === "opencode" || w.harness === "zcode") watch.harness = w.harness;
  if (typeof w.command === "string" && w.command.trim()) watch.command = w.command.trim();
  if (typeof w.notedUrl === "string") watch.notedUrl = w.notedUrl;
  if (typeof w.lastDirective === "string") watch.lastDirective = w.lastDirective;
  return watch;
}

/** Persist the watch; null deletes it (stops watching). */
export function writeDispatchWatch(watch: DispatchWatch | null): void {
  const file = dispatchStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (watch === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, JSON.stringify({ ...watch, updatedAt: new Date().toISOString() }, null, 2) + "\n");
}
