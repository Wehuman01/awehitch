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
import type { HarnessId } from "../adapters/paths.js";
import type { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";

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

export function buildDispatchPrompt(
  directive: string,
  chatUrl: string,
  opts: { protocolNote?: boolean } = {}
): string {
  const note = opts.protocolNote
    ? `1. First send this protocol note via awehitch_send_state so the review brain knows the format:

${FOLLOW_PROTOCOL_NOTE}

2. Call awehitch_open_chat with url: ${chatUrl} (the conversation that dispatched you).
3. Execute the TASK below with your own tools.
4. Report via awehitch_send_state as a [C2C] message: STATE: EXECUTED, one-line RESULT, CHANGED_FILES, TESTS (no diffs, no logs). Then awehitch_wait_reply for the review.
5. If the review says DONE: finish. If it is a correction DIRECTIVE: it is executable only when awehitch_check_dispatch returns authorized=true (the user re-sent the dispatch marker in their own message); if not authorized, finish and leave the correction to the user.
6. A wait timeout is not a failure: call the wait tool again, never resend.
`
    : `1. Call awehitch_open_chat with url: ${chatUrl} (the conversation that dispatched you).
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
export function defaultSpawnFn(plan: SpawnPlan): Promise<SpawnResult> {
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
  startedAt: string;
}

const activeSessions = new Map<string, ActiveDispatchSession>();

/** Claim a conversation for one spawned run; false when already served. */
export function claimConversation(chatUrl: string, harness: HarnessId): boolean {
  if (activeSessions.has(chatUrl)) return false;
  activeSessions.set(chatUrl, { harness, startedAt: new Date().toISOString() });
  return true;
}

export function releaseConversation(chatUrl: string): void {
  activeSessions.delete(chatUrl);
}

export function activeSession(chatUrl: string): ActiveDispatchSession | null {
  return activeSessions.get(chatUrl) ?? null;
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
    await browser.close().catch(() => undefined);
  }
}
