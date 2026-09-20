/**
 * Shared dispatch machinery: turning an authorized task into a spawned,
 * non-interactive agent run that reports back into the originating ChatGPT
 * conversation. Used by both executors of user intent:
 *
 * - the connector tool (`dispatch_agent`): ChatGPT itself calls it when the
 *   user @-mentions an executor in their own message;
 * - the pinned-conversation watcher (`dispatch watch`): the bridge watches
 *   one conversation for marker + [C2C] DIRECTIVE replies.
 *
 * One executor per conversation is the invariant: a conversation with an
 * active spawned run refuses further dispatches until the run exits.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ControlPlaneBrowser } from "../control-plane/browser.js";
import { withNamedStateLock } from "../control-plane/state.js";
import type { HarnessId } from "../adapters/paths.js";
import type { Logger } from "../logger/index.js";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export const FOLLOW_PROTOCOL_NOTE = `[C2C]
STATE: FOLLOW
You are the review brain of a user-driven session. An execution agent also
reads this chat. Rules:
1. Address actionable work to that agent ONLY as a [C2C] message whose first
   header is DIRECTIVE: followed by the concrete instruction.
2. Emit DIRECTIVE only when the user asked for execution in their own
   message; everything else stays plain prose for the user.
3. Inspect the workspace through your awehitch connector before planning
   and after execution reports.`;

/**
 * The stable task id of a dispatched conversation: one ChatGPT conversation,
 * one agent-side task identity, forever. Derived from the conversation id so
 * a re-dispatch into the same conversation resumes the same task chats and
 * checkpoints instead of overwriting the workspace-level chat pointer.
 */
export function dispatchTaskId(chatUrl: string): string {
  const id = /\/c\/([A-Za-z0-9-]+)/.exec(chatUrl)?.[1];
  const source = id ?? chatUrl;
  return `chat-${source.replace(/[^A-Za-z0-9-]/g, "").slice(0, 24).toLowerCase()}`;
}

export function buildDispatchPrompt(
  directive: string,
  chatUrl: string,
  opts: { protocolNote?: boolean } = {}
): string {
  const taskId = dispatchTaskId(chatUrl);
  const bind = `Call awehitch_open_chat with url: ${chatUrl} AND task_id: ${taskId} — ${taskId} is this conversation's permanent task id; reuse it for awehitch_send_handoff and for every \`awehitch session set --task ${taskId}\` checkpoint.`;
  const note = opts.protocolNote
    ? `1. First send this protocol note via awehitch_send_state so the review brain knows the format:

${FOLLOW_PROTOCOL_NOTE}

2. ${bind}
3. Execute the TASK below with your own tools.
4. Report via awehitch_send_state as a [C2C] message: STATE: EXECUTED, one-line RESULT, CHANGED_FILES, TESTS (no diffs, no logs). Then awehitch_wait_reply for the review.
5. If the review says DONE: finish. If it is a correction DIRECTIVE: it is executable only when awehitch_check_dispatch returns authorized=true (the user re-sent the dispatch marker in their own message); if not authorized, finish and leave the correction to the user.
6. A wait timeout is not a failure: call the wait tool again, never resend.
`
    : `1. ${bind}
2. Execute the TASK below with your own tools.
3. Report via awehitch_send_state as a [C2C] message: STATE: EXECUTED, one-line RESULT, CHANGED_FILES, TESTS (no diffs, no logs). Then awehitch_wait_reply for the review.
4. If the review says DONE: finish. If it is a correction DIRECTIVE: it is executable only when awehitch_check_dispatch returns authorized=true (the user re-sent the dispatch marker in their own message); if not authorized, finish and leave the correction to the user.
5. A wait timeout is not a failure: call the wait tool again, never resend.
`;
  return `You were started by awehitch's dispatch watcher: the user authorized a task from their own ChatGPT conversation.

${note}
TASK:
${directive}`;
}

export interface SpawnPlan {
  cmd: string;
  args: string[];
  cwd: string;
}

export interface SpawnResult {
  exitCode: number | null;
}

/** Default spawn: prompt as argv (never a shell), output into dispatch.log. */
export function defaultSpawnFn(
  plan: SpawnPlan,
  onStart?: (pid: number | undefined) => void
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const out = fs.openSync(dispatchLogPath(), "a");
    fs.appendFileSync(
      dispatchLogPath(),
      `\n--- dispatch spawn ${new Date().toISOString()} cwd=${plan.cwd} cmd=${plan.cmd} ---\n`
    );
    const child: ChildProcess = nodeSpawn(plan.cmd, plan.args, {
      cwd: plan.cwd,
      stdio: ["ignore", out, out],
    });
    // The child holds its own dup of the fd; the parent must not leak one
    // per dispatch.
    fs.closeSync(out);
    onStart?.(child.pid);
    child.on("exit", (code) => resolve({ exitCode: code }));
    child.on("error", () => resolve({ exitCode: -1 }));
  });
}

function dispatchLogPath(): string {
  const dir = path.join(getStateDir(), "logs");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "dispatch.log");
}

// ------------------------------------------------- one-session-per-chat registry

export interface ActiveDispatchSession {
  harness: HarnessId;
  taskId: string;
  startedAt: string;
  /** Pid of the spawned run, once known: a dead pid means a stale claim. */
  pid?: number;
}

/**
 * A claim without a live pid is trusted for this long: interactive launches
 * own no process we can watch, and a bridge restart loses the pid before the
 * run exits. Long enough for a real supervised session, short enough that a
 * killed terminal does not lock the conversation for a day.
 */
const PIDLESS_STALE_MS = 4 * 60 * 60 * 1000;
/** Pids get recycled; no claim outlives this regardless of liveness. */
const MAX_CLAIM_MS = 24 * 60 * 60 * 1000;

function claimsFile(): string {
  return path.join(getStateDir(), "dispatch", "sessions.json");
}

function readClaims(): Record<string, ActiveDispatchSession> {
  return readJsonIfExists<Record<string, ActiveDispatchSession>>(claimsFile()) ?? {};
}

function writeClaims(claims: Record<string, ActiveDispatchSession>): void {
  const file = claimsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeSecureJson(file, claims);
}

function claimIsLive(entry: ActiveDispatchSession): boolean {
  const age = Date.now() - Date.parse(entry.startedAt);
  if (!Number.isFinite(age) || age >= MAX_CLAIM_MS) return false;
  if (entry.pid !== undefined) {
    try {
      process.kill(entry.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  return age < PIDLESS_STALE_MS;
}

/**
 * Claim a conversation for one agent session. The registry is file-backed so
 * the "one conversation, one session" invariant survives bridge restarts and
 * covers interactive launches too; a stale claim (dead pid, or no pid and
 * older than the trust window) is reclaimed instead of refusing. All
 * read-modify-write cycles run under a short cross-process lock: the
 * interactive terminal's `dispatch release` is a separate process racing
 * the bridge's claim/note updates.
 */
export function claimConversation(chatUrl: string, harness: HarnessId): boolean {
  return withNamedStateLock("dispatch-claims", () => {
    const claims = readClaims();
    const existing = claims[chatUrl];
    if (existing && claimIsLive(existing)) return false;
    claims[chatUrl] = {
      harness,
      taskId: dispatchTaskId(chatUrl),
      startedAt: new Date().toISOString(),
    };
    writeClaims(claims);
    return true;
  });
}

/** Record the spawned run's pid so a dead process frees its claim. */
export function noteClaimPid(chatUrl: string, pid: number | undefined): void {
  if (pid === undefined) return;
  withNamedStateLock("dispatch-claims", () => {
    const claims = readClaims();
    const entry = claims[chatUrl];
    if (!entry || entry.pid !== undefined) return;
    claims[chatUrl] = { ...entry, pid };
    writeClaims(claims);
  });
}

export function releaseConversation(chatUrl: string): void {
  withNamedStateLock("dispatch-claims", () => {
    const claims = readClaims();
    if (!(chatUrl in claims)) return;
    delete claims[chatUrl];
    writeClaims(claims);
  });
}

export function activeSession(chatUrl: string): ActiveDispatchSession | null {
  const entry = readClaims()[chatUrl];
  if (!entry || !claimIsLive(entry)) return null;
  return entry;
}

/**
 * Report a failed spawned run into its conversation as [C2C] BLOCKED, via a
 * short-lived control-plane browser (success stays silent: the run itself
 * posts EXECUTED).
 */
export async function reportBlocked(
  chatUrl: string,
  workspaceId: string,
  harness: HarnessId,
  exitCode: number | null,
  logger: Logger
): Promise<void> {
  const browser = new ControlPlaneBrowser(workspaceId, {}, logger, "dispatch");
  try {
    await browser.openConversation(chatUrl);
    await browser.sendMessage(
      `[C2C]\nSTATE: BLOCKED\nRESULT: the dispatched ${harness} run exited with code ${exitCode} without reporting; its log is at ${dispatchLogPath()}.`
    );
  } catch (error) {
    logger.warn(
      `dispatch BLOCKED report failed for ${chatUrl}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    // dispose, not close: a short-lived peek must give its session slot back
    // or the harness's pool (default 2) exhausts after a few dispatches.
    await browser.dispose().catch(() => undefined);
  }
}
