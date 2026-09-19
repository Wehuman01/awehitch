/**
 * Machine-level dispatch watch state.
 *
 * The dispatch watcher (running inside the bridge process) spawns the
 * configured coding agent for user-authorized dispatches from the user's
 * own ChatGPT conversations. Three modes:
 *
 * - "auto" (default — also when this file does not exist): watch the
 *   sidebar's most recent conversations; a dispatch marker in the user's
 *   own latest message authorizes a spawn there.
 * - "chat": watch exactly one conversation (explicit `dispatch watch`).
 * - "off": do nothing (`dispatch stop`).
 *
 * The state is machine-level: it must survive agent sessions and CLI
 * exits, and no agent needs to be running for a watch to exist. Manual
 * conversation binding (per-workspace control-plane state, set via
 * open_chat) stays separate — this file only serves the watcher.
 */

import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import type { HarnessId } from "../adapters/paths.js";
import { normalizeChatUrl } from "../control-plane/state.js";

export type DispatchMode = "chat" | "auto" | "off";

export interface DispatchWatch {
  mode: DispatchMode;
  /** Workspace root the dispatched agent runs in (absolute). */
  workspaceRoot?: string;
  /** The watched conversation (chat mode only, normalized chatgpt.com/c/…). */
  chatUrl?: string;
  /** Harness to spawn; omit to auto-detect (or let the message name one). */
  harness?: HarnessId;
  /** Command override for the harness binary (split on spaces, no shell). */
  command?: string;
  /** Conversation the [C2C] FOLLOW protocol note was already sent to (chat). */
  notedUrl?: string;
  /** Body of the last executed directive (chat) — dedups a re-fire after restart. */
  lastDirective?: string;
  /** Per-conversation dispatch bookkeeping (auto): last message we spawned for. */
  scanned?: Record<string, { lastDispatched?: string }>;
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
  const mode: DispatchMode =
    w.mode === "off" || w.mode === "auto" || w.mode === "chat"
      ? w.mode
      : typeof w.chatUrl === "string"
        ? "chat"
        : "auto";
  if (mode === "off") return { mode, updatedAt: new Date().toISOString() };
  if (mode === "chat") {
    if (typeof w.chatUrl !== "string") return null;
    const chatUrl = normalizeChatUrl(w.chatUrl);
    const workspaceRoot = typeof w.workspaceRoot === "string" ? w.workspaceRoot : undefined;
    if (!chatUrl || !workspaceRoot || !fs.existsSync(workspaceRoot)) return null;
    const watch: DispatchWatch = { mode, workspaceRoot, chatUrl, updatedAt: new Date().toISOString() };
    if (w.harness === "codex" || w.harness === "opencode" || w.harness === "zcode") watch.harness = w.harness;
    if (typeof w.command === "string" && w.command.trim()) watch.command = w.command.trim();
    if (typeof w.notedUrl === "string") watch.notedUrl = w.notedUrl;
    if (typeof w.lastDirective === "string") watch.lastDirective = w.lastDirective;
    return watch;
  }
  // auto
  const watch: DispatchWatch = { mode, updatedAt: new Date().toISOString() };
  const workspaceRoot = typeof w.workspaceRoot === "string" ? w.workspaceRoot : undefined;
  if (workspaceRoot && fs.existsSync(workspaceRoot)) watch.workspaceRoot = workspaceRoot;
  if (w.harness === "codex" || w.harness === "opencode" || w.harness === "zcode") watch.harness = w.harness;
  if (typeof w.command === "string" && w.command.trim()) watch.command = w.command.trim();
  if (w.scanned && typeof w.scanned === "object" && !Array.isArray(w.scanned)) {
    const scanned: DispatchWatch["scanned"] = {};
    for (const [key, value] of Object.entries(w.scanned as Record<string, unknown>)) {
      const chatUrl = normalizeChatUrl(key);
      if (!chatUrl || !value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      const last = typeof entry.lastDispatched === "string" ? entry.lastDispatched : undefined;
      if (last !== undefined) scanned[chatUrl] = { lastDispatched: last };
    }
    watch.scanned = scanned;
  }
  return watch;
}

/**
 * Persist the watch. null deletes the file — which means auto (the
 * default), not off: `dispatch stop` writes mode "off" instead.
 */
export function writeDispatchWatch(watch: DispatchWatch | null): void {
  const file = dispatchStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (watch === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, JSON.stringify({ ...watch, updatedAt: new Date().toISOString() }, null, 2) + "\n");
}
