/**
 * The `dispatch_agent` connector tool: ChatGPT itself starts the agent.
 *
 * The user @-mentions an executor in their own message ("@opencode fix the
 * login page"); ChatGPT calls this tool with the task (and the named
 * harness). The bridge spawns the harness non-interactively in the
 * workspace, bound to THIS conversation — one conversation, one agent
 * session. No background watching: the tool call is the trigger, the user's
 * own @-mention is the authorization.
 */

import { ControlPlaneBrowser } from "../control-plane/browser.js";
import { normalizeChatUrl } from "../control-plane/state.js";
import { detectHarnesses } from "../adapters/detect.js";
import { HARNESS_IDS, type HarnessId } from "../adapters/paths.js";
import type { Logger } from "../logger/index.js";
import type { Workspace } from "../workspace/manager.js";
import { planSpawn } from "./harness.js";
import {
  activeSession,
  buildDispatchPrompt,
  claimConversation,
  defaultSpawnFn,
  releaseConversation,
  reportBlocked,
  type SpawnPlan,
  type SpawnResult,
} from "./spawn.js";

export interface DispatchToolDeps {
  installedHarnesses(): HarnessId[];
  spawn(plan: SpawnPlan): Promise<SpawnResult>;
  /** Conversations served by the explicitly pinned watcher; dispatch refuses those. */
  watchedConversations(): string[];
  logger: Logger;
}

export type DispatchOutcome =
  | { ok: true; message: string; harness: HarnessId; chatUrl: string }
  | { ok: false; code: string; message: string };

function mentionToHarness(text: string): HarnessId | null {
  for (const id of HARNESS_IDS) {
    if (new RegExp(`(^|[^A-Za-z0-9@_-])@${id}(?![A-Za-z0-9@_-])`, "i").test(text)) return id;
  }
  return null;
}

/** Remove the matched @-mention token; the rest is the task the agent runs. */
function stripMention(text: string, harness: HarnessId): string {
  return text
    .replace(new RegExp(`(^|[^A-Za-z0-9@_-])@${harness}(?![A-Za-z0-9@_-])`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function createDispatchToolHandler(deps: DispatchToolDeps) {
  return async function dispatchAgent(opts: {
    workspace: Workspace;
    task: string;
    harness?: string;
    chatUrl?: string;
    resolveConversation: (workspace: Workspace, explicitUrl?: string) => Promise<string | null>;
  }): Promise<DispatchOutcome> {
    const task = opts.task.trim();
    if (!task) {
      return { ok: false, code: "INVALID_TASK", message: "The task is empty; pass the user's requested work as task." };
    }

    let harness: HarnessId | null = null;
    if (opts.harness) {
      const wanted = opts.harness.trim().toLowerCase() as HarnessId;
      if (!HARNESS_IDS.includes(wanted)) {
        return {
          ok: false,
          code: "UNKNOWN_HARNESS",
          message: `Unknown harness '${opts.harness}'. Installed/executable ones: ${HARNESS_IDS.join(", ")}.`,
        };
      }
      harness = wanted;
    } else {
      harness = mentionToHarness(task);
    }
    if (!harness) {
      return {
        ok: false,
        code: "HARNESS_UNRESOLVED",
        message:
          "No executor named. Ask the user which one, or have them @-mention it: @opencode, @codex or @zcode.",
      };
    }
    if (!deps.installedHarnesses().includes(harness)) {
      return {
        ok: false,
        code: "HARNESS_NOT_INSTALLED",
        message: `${harness} is not installed on this machine.`,
      };
    }

    const chatUrl = await opts.resolveConversation(opts.workspace, opts.chatUrl);
    if (!chatUrl) {
      return {
        ok: false,
        code: "CONVERSATION_UNRESOLVED",
        message:
          "Could not determine which conversation to report back to. Pass this conversation's chatgpt.com/c/… URL as chatUrl.",
      };
    }
    if (deps.watchedConversations().includes(chatUrl)) {
      return {
        ok: false,
        code: "CONVERSATION_WATCHED",
        message:
          "This conversation is served by an explicitly pinned watcher (`awehitch dispatch watch`); it already spawns agents for marker messages here.",
      };
    }
    const busy = activeSession(chatUrl);
    if (busy || !claimConversation(chatUrl, harness)) {
      return {
        ok: false,
        code: "CONVERSATION_BUSY",
        message: `This conversation already has an active agent session (${busy?.harness ?? "unknown"}, started ${busy?.startedAt ?? "earlier"}). Wait for its [C2C] EXECUTED report before dispatching again.`,
      };
    }

    const prompt = buildDispatchPrompt(stripMention(task, harness), chatUrl, { protocolNote: true });
    const plan = planSpawn(harness, opts.workspace.root, prompt);
    void deps
      .spawn(plan)
      .then((result) => {
        if (result.exitCode !== 0) {
          void reportBlocked(chatUrl, opts.workspace.id, harness, result.exitCode, deps.logger);
        }
      })
      .catch(() => undefined)
      .finally(() => releaseConversation(chatUrl));

    deps.logger.info(`dispatch_agent: ${harness} spawned for ${chatUrl} in ${opts.workspace.root}`);
    return {
      ok: true,
      harness,
      chatUrl,
      message: `Dispatched ${harness} for this conversation (workspace ${opts.workspace.root}). It will post a [C2C] EXECUTED report here when the run finishes; until then this conversation has one active agent session.`,
    };
  };
}

/**
 * Real conversation resolver: an explicit URL wins; otherwise one short
 * browser peek at the sidebar — the conversation the user just dispatched
 * from is its most recent entry. The browser closes immediately after.
 */
export function browserConversationResolver(logger: Logger) {
  return async (workspace: Workspace, explicitUrl?: string): Promise<string | null> => {
    if (explicitUrl) {
      const normalized = normalizeChatUrl(explicitUrl);
      if (normalized) return normalized;
    }
    const browser = new ControlPlaneBrowser(workspace.id, {}, logger, "dispatch");
    try {
      const [recent] = await browser.listRecentConversations(1);
      return recent ?? null;
    } catch (error) {
      logger.warn(
        `dispatch conversation lookup failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    } finally {
      await browser.close().catch(() => undefined);
    }
  };
}

export function defaultDispatchToolDeps(logger: Logger, watchedConversations: () => string[]): DispatchToolDeps {
  return {
    installedHarnesses: detectHarnesses,
    spawn: defaultSpawnFn,
    watchedConversations,
    logger,
  };
}
