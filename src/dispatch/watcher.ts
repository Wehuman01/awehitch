/**
 * The dispatch watcher: hands-free execution from a user-owned ChatGPT
 * conversation.
 *
 * Runs inside the bridge process. When a watch exists (dispatch.json), it
 * polls the conversation with the same dispatch-authority gate as the
 * manual flow — driver.waitDirective only fires when the USER's own latest
 * message carries the dispatch marker AND ChatGPT answered with a [C2C]
 * DIRECTIVE. On a fresh directive it spawns the selected harness in its
 * non-interactive mode with the directive as the task; the spawned agent
 * reports back into the same conversation through the control-plane tools.
 * The watcher never executes a directive itself and never spawns without
 * the marker gate.
 *
 * Lifecycle notes:
 * - one executor per conversation: if an agent session is also attached to
 *   the watched conversation (manual flow), stop the watcher — both would
 *   react to the same directive.
 * - a spawn blocks the loop until the run exits, so directives arriving
 *   during a run queue up and fire afterwards (waitDirective's first-call
 *   anchor returns them).
 * - the last executed directive body is persisted before spawning, so a
 *   watcher restart cannot re-fire it. A byte-identical directive re-sent
 *   after a restart is swallowed by the same guard — reword to re-dispatch.
 * - exit code != 0 is reported back as [C2C] STATE: BLOCKED with the log
 *   path; exit code 0 stays silent (the agent reported, or the user will
 *   ask).
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ControlPlaneBrowser } from "../control-plane/browser.js";
import { detectHarnesses } from "../adapters/detect.js";
import type { HarnessId } from "../adapters/paths.js";
import { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";
import { readDispatchWatch, writeDispatchWatch, type DispatchWatch } from "./state.js";
import { pickHarness, planSpawn } from "./harness.js";

const POLL_MS = 25_000;

/** The subset of ControlPlaneBrowser the watcher relies on (test seam). */
export interface DispatchDriver {
  waitDirective(opts: { timeoutMs?: number; marker?: string }): Promise<{
    status: string;
    directive: string | null;
  }>;
  openConversation(chatUrl?: string): Promise<string>;
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

  constructor(opts: DispatchWatcherOptions = {}) {
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.logger = opts.logger ?? new Logger({ name: "dispatch", console: false });
    this.injectedDriver = opts.driver ?? null;
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
    this.installedFn = opts.installedFn ?? detectHarnesses;
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
      let watch: DispatchWatch | null = null;
      try {
        watch = readDispatchWatch();
      } catch {
        // Unreadable state file: treat as no watch this cycle.
      }
      if (watch) {
        try {
          await this.handleWatch(watch);
        } catch (error) {
          this.logger.warn(
            `dispatch watch cycle failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else if (this.cached) {
        // Watch removed (`dispatch stop`): release the machine-global browser.
        const stale = this.cached;
        this.cached = null;
        await stale.driver.close().catch(() => undefined);
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

  private driverFor(watch: DispatchWatch): DispatchDriver {
    if (this.cached?.root !== watch.workspaceRoot) {
      if (this.cached) void this.cached.driver.close().catch(() => undefined);
      const driver = this.injectedDriver ?? new ControlPlaneBrowser(new Workspace(watch.workspaceRoot).id, {}, this.logger, "dispatch");
      this.cached = { root: watch.workspaceRoot, driver };
    }
    return this.cached.driver;
  }

  private async handleWatch(watch: DispatchWatch): Promise<void> {
    const driver = this.driverFor(watch);
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
    const harness = choice.harness;

    // Persist before spawning: a crash mid-run must not re-fire the task.
    writeDispatchWatch({ ...watch, lastDirective: view.directive });
    const prompt = buildDispatchPrompt(view.directive, watch.chatUrl);
    const plan = planSpawn(harness, watch.workspaceRoot, prompt, watch.command);
    this.logger.info(`dispatching to ${harness} (exit awaited)`);
    const result = await this.spawnFn(plan);
    this.logger.info(`dispatched ${harness} run finished with code ${result.exitCode}`);
    if (result.exitCode !== 0) {
      await driver.sendMessage(
        `[C2C]\nSTATE: BLOCKED\nRESULT: the dispatched ${harness} run exited with code ${result.exitCode} without reporting; its log is at ${dispatchLogPath()}.`
      ).catch(() => undefined);
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

export function buildDispatchPrompt(directive: string, chatUrl: string): string {
  return `You were started by awehitch's dispatch watcher: the user authorized a task from their own ChatGPT conversation.

1. Call awehitch_open_chat with url: ${chatUrl} (the conversation that dispatched you).
2. Execute the TASK below with your own tools.
3. Report via awehitch_send_state as a [C2C] message: STATE: EXECUTED, one-line RESULT, CHANGED_FILES, TESTS (no diffs, no logs). Then awehitch_wait_reply for the review.
4. If the review says DONE: finish. If it is a correction DIRECTIVE: it is executable only when awehitch_check_dispatch returns authorized=true (the user re-sent the dispatch marker in their own message); if not authorized, finish and leave the correction to the user.
5. A wait timeout is not a failure: call the wait tool again, never resend.

TASK:
${directive}`;
}

function dispatchLogPath(): string {
  const dir = path.join(getStateDir(), "logs");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "dispatch.log");
}
