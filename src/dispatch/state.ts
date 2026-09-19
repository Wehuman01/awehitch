/**
 * Machine-level dispatch watch state.
 *
 * "chat" pins one conversation to the watcher inside the bridge (explicit
 * `dispatch watch <url>`); "off" watches nothing. Hands-free dispatching is
 * NOT here — it is the `dispatch_agent` connector tool ChatGPT itself calls
 * when the user @-mentions an executor; no state, no polling.
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

export type DispatchMode = "chat" | "off";

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
  // The pre-tool era had an "auto" mode (background sidebar polling). It is
  // gone; a leftover auto state reads as "not watching anything".
  const mode: DispatchMode = w.mode === "chat" ? "chat" : "off";
  if (mode === "off") return { mode, updatedAt: new Date().toISOString() };
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

/**
 * Persist the watch. null deletes the file — which also means "not watching"
 * (no file = no pinned conversation; `dispatch stop` writes mode "off").
 */
export function writeDispatchWatch(watch: DispatchWatch | null): void {
  const file = dispatchStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (watch === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  const launchStyle = readLaunchStyle();
  fs.writeFileSync(
    file,
    JSON.stringify({ ...watch, ...(launchStyle === "interactive" ? { launchStyle } : {}), updatedAt: new Date().toISOString() }, null, 2) + "\n"
  );
}

// ------------------------------------------------------- launch style

/**
 * How a dispatch starts the agent: "headless" runs it in the background and
 * reports back into the conversation; "interactive" opens the harness's TUI
 * in a visible terminal window for the user to supervise and steer. Machine
 * level, kept in dispatch.json alongside the watch (and surviving watch
 * rewrites).
 */
export type DispatchLaunchStyle = "headless" | "interactive";

export function readLaunchStyle(): DispatchLaunchStyle {
  try {
    const raw = JSON.parse(fs.readFileSync(dispatchStateFile(), "utf8"));
    return raw?.launchStyle === "interactive" ? "interactive" : "headless";
  } catch {
    return "headless";
  }
}

export function writeLaunchStyle(style: DispatchLaunchStyle): void {
  const file = dispatchStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
  } catch {
    // no state yet — start fresh
  }
  delete raw.launchStyle;
  const next = style === "headless" ? raw : { ...raw, launchStyle: style };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
}
