/**
 * The dispatch watcher: hands-free execution from the user's own ChatGPT
 * conversations.
 *
 * Runs inside the bridge process. Three modes (dispatch.json):
 *
 * - auto (default, also when no file exists): poll the home page sidebar
 *   for the most recent conversations; when the USER's own latest message
 *   in one of them carries a dispatch marker (@agent, @opencode, @codex,
 *   @zcode), that message IS the task — spawn the named/pinned harness
 *   with it. ChatGPT's reply is not required: the marker in the user's
 *   own message is the authorization. The spawned run opens the same
 *   conversation, introduces the [C2C] protocol, executes, and reports
 *   EXECUTED for ChatGPT's review.
 * - chat (explicit `dispatch watch <url>`): one conversation, watched
 *   through waitDirective — marker + [C2C] DIRECTIVE reply, protocol note
 *   sent on first sight.
 * - off (`dispatch stop`): idle; the dispatch browser is released.
 *
 * The watcher never executes a task itself and never spawns on anything
 * but the user's own words: agent-injected turns (composer sends, which
 * start with [C2C]) are never authorization, even when they echo a marker.
 *
 * Lifecycle notes:
 * - one executor per conversation: if an agent session is also attached
 *   to the same conversation, the user should stop the watcher — both
 *   would react to the same dispatch.
 * - a spawn blocks the loop until the run exits; later dispatches queue.
 * - the last executed task per conversation is persisted before spawning,
 *   so a watcher restart cannot re-fire it. A byte-identical message re-sent
 *   after a restart is swallowed by the same guard — reword to re-dispatch.
 * - exit code != 0 is reported back as [C2C] STATE: BLOCKED with the log
 *   path; exit code 0 stays silent (the agent reported, or the user will
 *   ask).
 * - auto mode needs exactly one registered workspace (the usual `up -w ~`
 *   setup). With zero or several, it skips and logs once — pin one with
 *   `dispatch auto -w <root>` or use `dispatch watch`.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ControlPlaneBrowser } from "../control-plane/browser.js";
import { isAgentInjected, isDispatchAuthorized, parseDirective, resolveDispatchMarker } from "../control-plane/dispatch.js";
import { detectHarnesses } from "../adapters/detect.js";
import type { HarnessId } from "../adapters/paths.js";
import { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";
import { readRuntimeState } from "../bridge/runtime.js";
import { readDispatchWatch, writeDispatchWatch, type DispatchWatch } from "./state.js";
import { pickHarness, planSpawn } from "./harness.js";

const POLL_MS = 25_000;
const AUTO_SCAN_LIMIT = 3;

/** Markers that authorize a dispatch in auto mode; first match wins. */
function autoMarkers(configured: string | undefined): string[] {
  return [...new Set([configured ?? DEFAULT_MARKER, DEFAULT_MARKER, "@opencode", "@codex", "@zcode"])];
}
const DEFAULT_MARKER = "@agent";

/** Remove the matched marker token from the message; the rest is the task. */
function stripMarker(text: string, marker: string): string {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(^|[^A-Za-z0-9@_-])${escaped}(?![A-Za-z0-9@_-])`), " ").trim();
}

/** The subset of ControlPlaneBrowser the watcher relies on (test seam). */
export interface DispatchDriver {
  waitDirective(opts: { timeoutMs?: number; marker?: string }): Promise<{
    status: string;
    directive: string | null;
  }>;
  openConversation(chatUrl?: string): Promise<string>;
  readLatestUserMessage(): Promise<{ text: string | null; count: number }>;
  readReply(): Promise<{ status: string; text: string | null }>;
  listRecentConversations(limit?: number): Promise<string[]>;
  sendMessage(text: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface SpawnResultLike {
  exitCode: number | null;
}

export interface DispatchWatcherOptions {
  pollMs?: number;
  logger?: Logger;
  /** Test seam: inject a driver instead of a real Playwright browser. */
  driver?: DispatchDriver;
  /** Test seam: run the spawn and await its exit. */
  spawnFn?: (plan: { cmd: string; args: string[]; cwd: string }) => Promise<SpawnResultLike>;
  /** Test seam: which harnesses are installed (default: detect on disk). */
  installedFn?: () => HarnessId[];
  /** Test seam: registered workspace roots (default: read runtime state). */
  registeredRoots?: () => string[];
}

export class DispatchWatcher {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private cached: { root: string; driver: DispatchDriver } | null = null;
  private wake: (() => void) | null = null;
  private readonly pollMs: number;
  private readonly logger: Logger;
  private readonly injectedDriver: DispatchDriver | null;
  private readonly spawnFn: (plan: { cmd: string; args: string[]; cwd: string }) => Promise<SpawnResultLike>;
  private readonly installedFn: () => HarnessId[];
  private readonly registeredRoots: () => string[];
  private autoWorkspaceWarned = false;
  private autoScanWarned = false;

  constructor(opts: DispatchWatcherOptions = {}) {
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.logger = opts.logger ?? new Logger({ name: "dispatch", console: false });
    this.injectedDriver = opts.driver ?? null;
    this.installedFn = opts.installedFn ?? detectHarnesses;
    this.registeredRoots =
      opts.registeredRoots ?? (() => readRuntimeState()?.workspaces.filter((root) => fs.existsSync(root)) ?? []);
    this.spawnFn =
      opts.spawnFn ??
      ((plan) =>
        new Promise((resolve) => {
          const logPath = dispatchLogPath();
          const out = fs.openSync(logPath, "a");
          fs.appendFileSync(logPath, `\n--- dispatch spawn ${new Date().toISOString()} cwd=${plan.cwd} cmd=${plan.cmd} ---\n`);
          const child: ChildProcess = nodeSpawn(plan.cmd, plan.args, {
            cwd: plan.cwd,
            stdio: ["ignore", out, out],
          });
          child.on("exit", (code) => resolve({ exitCode: code }));
          child.on("error", () => resolve({ exitCode: -1 }));
        }));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop().catch((error) => {
      this.logger.error(`dispatch watcher crashed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    if (this.loopPromise) await this.loopPromise;
    this.loopPromise = null;
    if (this.cached) await this.cached.driver.close().catch(() => undefined);
    this.cached = null;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let watch: DispatchWatch;
      try {
        watch = readDispatchWatch() ?? { mode: "auto", updatedAt: new Date().toISOString() };
      } catch {
        watch = { mode: "auto", updatedAt: new Date().toISOString() };
      }
      try {
        if (watch.mode === "chat") {
          const { chatUrl, workspaceRoot } = watch;
          if (chatUrl && workspaceRoot) await this.chatCycle({ ...watch, chatUrl, workspaceRoot });
        } else if (watch.mode === "auto") {
          await this.autoCycle(watch);
        } else if (this.cached) {
          // mode "off": release the machine-global browser.
          const stale = this.cached;
          this.cached = null;
          await stale.driver.close().catch(() => undefined);
        }
      } catch (error) {
        this.logger.warn(
          `dispatch watch cycle failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      await this.sleep(this.pollMs);
    }
  }

  /** Sleep that `stop()` can interrupt, so shutdown never waits a full poll. */
  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private driverFor(workspaceRoot: string): DispatchDriver {
    if (this.cached?.root !== workspaceRoot) {
      if (this.cached) void this.cached.driver.close().catch(() => undefined);
      const driver =
        this.injectedDriver ??
        new ControlPlaneBrowser(new Workspace(workspaceRoot).id, {}, this.logger, "dispatch");
      this.cached = { root: workspaceRoot, driver };
    }
    return this.cached.driver;
  }

  // ------------------------------------------------------------- chat mode

  private async chatCycle(watch: DispatchWatch & { chatUrl: string; workspaceRoot: string }): Promise<void> {
    const driver = this.driverFor(watch.workspaceRoot);
    // One-time protocol note per conversation: ChatGPT must know the
    // DIRECTIVE format before it can dispatch anything.
    if (watch.notedUrl !== watch.chatUrl) {
      await driver.openConversation(watch.chatUrl);
      await driver.sendMessage(FOLLOW_PROTOCOL_NOTE);
      writeDispatchWatch({ ...watch, notedUrl: watch.chatUrl });
      this.logger.info(`dispatch watch armed on ${watch.chatUrl}`);
      return;
    }
    const view = await driver.waitDirective({ timeoutMs: this.pollMs });
    if (view.status !== "directive" || !view.directive) return;
    if (view.directive === watch.lastDirective) return; // already executed (restart dedup)

    const choice = pickHarness(watch, view.directive, this.installedFn());
    if (!choice.ok) {
      await driver.sendMessage(`[C2C]\nSTATE: BLOCKED\nRESULT: ${choice.reason}`);
      writeDispatchWatch({ ...watch, lastDirective: view.directive });
      return;
    }

    // Persist before spawning: a crash mid-run must not re-fire the task.
    writeDispatchWatch({ ...watch, lastDirective: view.directive });
    const prompt = buildDispatchPrompt(view.directive, watch.chatUrl);
    await this.runSpawn(choice.harness, watch, prompt, watch.workspaceRoot, driver, watch.chatUrl);
  }

  // ------------------------------------------------------------- auto mode

  private async autoCycle(watch: DispatchWatch): Promise<void> {
    // The dispatched agent needs a workspace. Exactly one registered root
    // (the `up -w ~` setup) is unambiguous; otherwise skip and say so once.
    const root = watch.workspaceRoot ?? soleRoot(this.registeredRoots());
    if (!root) {
      if (!this.autoWorkspaceWarned) {
        this.autoWorkspaceWarned = true;
        this.logger.warn(
          "auto dispatch skipped: zero or several workspaces registered; run `awehitch up -w <dir>` with one root, or pin one via `awehitch dispatch auto -w <dir>` / `awehitch dispatch watch <url>`"
        );
      }
      return;
    }
    this.autoWorkspaceWarned = false;
    const driver = this.driverFor(root);
    const candidates = await driver.listRecentConversations(AUTO_SCAN_LIMIT);
    if (candidates.length === 0) {
      // Silence here is what made a broken scan undiagnosable: say it once
      // per streak, then keep retrying quietly.
      if (!this.autoScanWarned) {
        this.autoScanWarned = true;
        this.logger.warn(
          "auto dispatch: the ChatGPT sidebar showed no recent conversations " +
            "(bot-check page? ChatGPT DOM changed?); retrying next cycle."
        );
      }
      return;
    }
    this.autoScanWarned = false;
    const scanned = { ...(watch.scanned ?? {}) };
    const markers = autoMarkers(resolveDispatchMarker(new Workspace(root).projectConfig.dispatchMarker));

    for (const url of candidates) {
      await driver.openConversation(url);
      const { text } = await driver.readLatestUserMessage();
      if (!text || isAgentInjected(text)) continue; // agent-sent turns never authorize
      const matched = markers.find((marker) => isDispatchAuthorized(text, marker));
      if (!matched) continue;
      // Ownership signal: a [C2C] DIRECTIVE reply means a protocol-aware
      // executor already serves this conversation (a manually bound agent
      // session) — defer to it instead of double-spawning. While ChatGPT
      // is still generating, wait for the reply to render first.
      const reply = await driver.readReply();
      if (reply.status === "generating") continue;
      if (reply.status !== "error" && parseDirective(reply.text).isDirective) continue;
      const task = stripMarker(text, matched);
      if (!task) continue; // a bare "@opencode" carries no task yet
      if (scanned[url]?.lastDispatched === task) continue; // already executed

      // Persist before spawning: a crash mid-run must not re-fire the task.
      scanned[url] = { lastDispatched: task };
      writeDispatchWatch({ ...watch, scanned });
      const choice = pickHarness(watch, `${matched} ${task}`, this.installedFn());
      if (!choice.ok) {
        await driver.sendMessage(`[C2C]\nSTATE: BLOCKED\nRESULT: ${choice.reason}`);
        continue;
      }
      this.logger.info(`auto dispatch from ${url} to ${choice.harness}`);
      const prompt = buildDispatchPrompt(task, url, { protocolNote: true });
      await this.runSpawn(choice.harness, { ...watch, scanned }, prompt, root, driver, url);
    }
  }

  // ---------------------------------------------------------------- shared

  private async runSpawn(
    harness: HarnessId,
    watch: DispatchWatch,
    prompt: string,
    root: string,
    driver: DispatchDriver,
    reportUrl?: string
  ): Promise<void> {
    const plan = planSpawn(harness, root, prompt, watch.command);
    const result = await this.spawnFn(plan);
    this.logger.info(`dispatched ${harness} run finished with code ${result.exitCode}`);
    if (result.exitCode !== 0) {
      const where = reportUrl ? await driver.openConversation(reportUrl).catch(() => undefined) : null;
      if (where) {
        await driver
          .sendMessage(
            `[C2C]\nSTATE: BLOCKED\nRESULT: the dispatched ${harness} run exited with code ${result.exitCode} without reporting; its log is at ${dispatchLogPath()}.`
          )
          .catch(() => undefined);
      }
    }
  }
}

/** The same protocol note the manual flow sends on first bind. */
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

function soleRoot(roots: string[]): string | null {
  return roots.length === 1 ? roots[0] : null;
}

function dispatchLogPath(): string {
  const dir = path.join(getStateDir(), "logs");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "dispatch.log");
}
