/**
 * The `dispatch_agent` connector tool: ChatGPT itself starts the agent.
 *
 * The user @-mentions an executor in their own message ("@opencode fix the
 * login page"); ChatGPT calls this tool with the task. The authorization is
 * a HARD server-side constraint, not a prompt convention: before spawning,
 * the bridge reads the conversation's latest USER message and requires the
 * @-mention there. ChatGPT's own text — or an @-mention it wrote into the
 * task parameter — never dispatches anything. Without the user's @, the only
 * thing ChatGPT can do is its own data-plane tools (read-only, or the
 * chatgptMode write tiers).
 */

import { ControlPlaneBrowser } from "../control-plane/browser.js";
import { isAgentInjected } from "../control-plane/dispatch.js";
import { normalizeChatUrl } from "../control-plane/state.js";
import { detectHarnesses } from "../adapters/detect.js";
import { HARNESS_IDS, type HarnessId } from "../adapters/paths.js";
import type { Logger } from "../logger/index.js";
import type { Workspace } from "../workspace/manager.js";
import { planSpawn } from "./harness.js";
import { openInteractiveTerminal, type InteractiveLaunch } from "./interactive.js";
import { readLaunchStyle, type DispatchLaunchStyle } from "./state.js";
import {
  activeSession,
  buildDispatchPrompt,
  claimConversation,
  defaultSpawnFn,
  noteClaimPid,
  releaseConversation,
  reportBlocked,
  type SpawnPlan,
  type SpawnResult,
} from "./spawn.js";

/** What the verifier could (or could not) read from the conversation. */
export type UserMessageView =
  | { readable: true; text: string | null }
  | { readable: false; reason: string };

export interface DispatchToolDeps {
  installedHarnesses(): HarnessId[];
  spawn(plan: SpawnPlan, onStart?: (pid: number | undefined) => void): Promise<SpawnResult>;
  /** Conversations served by the explicitly pinned watcher; dispatch refuses those. */
  watchedConversations(): string[];
  /**
   * Read the conversation's latest USER (human) message — the only text that
   * can authorize a dispatch. `readable: false` fails closed.
   */
  readUserMessage(chatUrl: string): Promise<UserMessageView>;
  /** How a dispatch starts the agent (visible TUI vs background run). */
  launchStyle(): DispatchLaunchStyle;
  /** Open the harness TUI in a visible terminal; false means it failed. */
  openInteractive(launch: InteractiveLaunch): Promise<boolean>;
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

    const chatUrl = await opts.resolveConversation(opts.workspace, opts.chatUrl);
    if (!chatUrl) {
      return {
        ok: false,
        code: "CONVERSATION_UNRESOLVED",
        message:
          "Could not determine which conversation to report back to. Pass this conversation's chatgpt.com/c/… URL as chatUrl.",
      };
    }

    // HARD authorization gate: the executor must be @-mentioned in the
    // conversation's latest USER message. ChatGPT's task/harness parameters
    // alone never dispatch anything.
    const userMessage = await deps.readUserMessage(chatUrl);
    if (!userMessage.readable) {
      return {
        ok: false,
        code: "DISPATCH_UNVERIFIED",
        message:
          `Could not read this conversation's latest user message (${userMessage.reason}), ` +
          `so the dispatch cannot be verified and is refused. Do the work with your own tools ` +
          `(read-only, or the workspace's chatgptMode write tiers) instead.`,
      };
    }
    const userText = isAgentInjected(userMessage.text) ? null : userMessage.text;
    const userMention = userText ? mentionToHarness(userText) : null;
    if (!userMention) {
      return {
        ok: false,
        code: "DISPATCH_UNAUTHORIZED",
        message:
          "The user's own latest message does not @-mention an executor, so starting an agent is not authorized. " +
          "Either ask the user to send a new message that @-mentions one (@opencode, @codex, @zcode), or do the " +
          "work yourself with your data-plane tools (read-only, or the workspace's chatgptMode write tiers).",
      };
    }
    if (opts.harness && opts.harness.trim().toLowerCase() !== userMention) {
      return {
        ok: false,
        code: "EXECUTOR_MISMATCH",
        message:
          `The user @-mentioned @${userMention}, not '${opts.harness}'. Dispatch the one the user named, ` +
          `or ask them to confirm.`,
      };
    }
    const harness: HarnessId = userMention;
    if (!deps.installedHarnesses().includes(harness)) {
      return {
        ok: false,
        code: "HARNESS_NOT_INSTALLED",
        message: `${harness} is not installed on this machine.`,
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
    // One conversation, one agent session — for interactive launches too: the
    // terminal the script opens releases its claim when the TUI exits.
    const busy = activeSession(chatUrl);
    if (busy || !claimConversation(chatUrl, harness)) {
      return {
        ok: false,
        code: "CONVERSATION_BUSY",
        message: `This conversation already has an active agent session (${busy?.harness ?? "unknown"}, started ${busy?.startedAt ?? "earlier"}). Wait for its [C2C] EXECUTED report before dispatching again, or have the user run \`awehitch dispatch release ${chatUrl}\` if that session is gone.`,
      };
    }

    if (deps.launchStyle() === "interactive") {
      const opened = await deps.openInteractive({
        harness,
        workspaceRoot: opts.workspace.root,
        chatUrl,
        prompt: buildDispatchPrompt(stripMention(task, harness), chatUrl, { protocolNote: true }),
      });
      if (!opened) {
        releaseConversation(chatUrl);
        return {
          ok: false,
          code: "INTERACTIVE_LAUNCH_FAILED",
          message: `Could not open an interactive ${harness} terminal for this workspace. Tell the user to run \`awehitch dispatch launch headless\` or open it manually.`,
        };
      }
      deps.logger.info(`dispatch_agent: interactive ${harness} terminal opened for ${chatUrl} in ${opts.workspace.root}`);
      return {
        ok: true,
        harness,
        chatUrl,
        message: `Opened an interactive ${harness} terminal for this conversation (workspace ${opts.workspace.root}). The window first offers an aweswitch profile picker (Enter launches plain), then the task is pasted into the agent and submitted automatically; if that fails it stays on the clipboard. The conversation stays bound to that session until its terminal closes. No automatic [C2C] report will be posted — the user reports back from that session.`,
      };
    }

    const prompt = buildDispatchPrompt(stripMention(task, harness), chatUrl, { protocolNote: true });
    const plan = planSpawn(harness, opts.workspace.root, prompt);
    void deps
      .spawn(plan, (pid) => noteClaimPid(chatUrl, pid))
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

/**
 * Real user-message reader for the hard dispatch gate: open the exact
 * conversation and read its latest USER message. Failures are reported as
 * unreadable — the dispatch gate fails closed, never open.
 */
export function browserUserMessageReader(logger: Logger) {
  return async (chatUrl: string): Promise<UserMessageView> => {
    const browser = new ControlPlaneBrowser("dispatch-verify", {}, logger, "dispatch");
    try {
      await browser.openConversation(chatUrl);
      const { text } = await browser.readLatestUserMessage();
      return { readable: true, text };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`dispatch user-message verification failed for ${chatUrl}: ${reason}`);
      return { readable: false, reason };
    } finally {
      await browser.close().catch(() => undefined);
    }
  };
}

export function defaultDispatchToolDeps(logger: Logger, watchedConversations: () => string[]): DispatchToolDeps {
  return {
    installedHarnesses: detectHarnesses,
    spawn: (plan, onStart) => defaultSpawnFn(plan, onStart),
    watchedConversations,
    readUserMessage: browserUserMessageReader(logger),
    launchStyle: readLaunchStyle,
    openInteractive: async (launch) => (await openInteractiveTerminal(launch)).ok,
    logger,
  };
}
