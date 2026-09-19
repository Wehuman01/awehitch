/**
 * The pinned-conversation dispatch watcher.
 *
 * Runs inside the bridge process and serves exactly one conversation
 * (explicit `awehitch dispatch watch <url>`): it sends the protocol note
 * once, then polls waitDirective — the USER's own latest message must carry
 * the dispatch marker AND ChatGPT must answer with a [C2C] DIRECTIVE. The
 * directive is the task; the watcher spawns the harness non-interactively
 * and the run reports back into the same conversation.
 *
 * There is no background auto-watch anymore: hands-free dispatching is the
 * `dispatch_agent` connector tool (ChatGPT itself calls it when the user
 * @-mentions an executor); this watcher is the explicit, opt-in variant for
 * one pinned conversation.
 *
 * Lifecycle notes:
 * - one executor per conversation: the spawn blocks the loop until the run
 *   exits; later directives queue.
 * - the last executed directive is persisted before spawning, so a watcher
 *   restart cannot re-fire it.
 * - exit code != 0 is reported back as [C2C] STATE: BLOCKED with the log
 *   path; exit code 0 stays silent (the run reported, or the user will ask).
 */

import fs from "node:fs";
import path from "node:path";
import { ControlPlaneBrowser } from "../control-plane/browser.js";
import { parseDirective, resolveDispatchMarker } from "../control-plane/dispatch.js";
import { detectHarnesses } from "../adapters/detect.js";
import type { HarnessId } from "../adapters/paths.js";
import { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";
import { readDispatchWatch, writeDispatchWatch, type DispatchWatch } from "./state.js";
import { pickHarness, planSpawn } from "./harness.js";
import {
  buildDispatchPrompt,
  claimConversation,
  releaseConversation,
  FOLLOW_PROTOCOL_NOTE,
  type SpawnResult,
} from "./spawn.js";

const POLL_MS = 25_000;

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

export interface DispatchWatcherOptions {
  pollMs?: number;
  logger?: Logger;
  /** Test seam: inject a driver instead of a real Playwright browser. */
  driver?: DispatchDriver;
  /** Test seam: run the spawn and await its exit. */
  spawnFn?: (plan: { cmd: string; args: string[]; cwd: string }) => Promise<SpawnResult>;
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
  private readonly spawnFn: (plan: { cmd: string; args: string[]; cwd: string }) => Promise<SpawnResult>;
  private readonly installedFn: () => HarnessId[];

  constructor(opts: DispatchWatcherOptions = {}) {
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.logger = opts.logger ?? new Logger({ name: "dispatch", console: false });
    this.injectedDriver = opts.driver ?? null;
    this.installedFn = opts.installedFn ?? detectHarnesses;
    this.spawnFn =
      opts.spawnFn ??
      (async (plan) => {
        const out = fs.openSync(dispatchLogPath(), "a");
        fs.appendFileSync(
          dispatchLogPath(),
          `\n--- dispatch spawn ${new Date().toISOString()} cwd=${plan.cwd} cmd=${plan.cmd} ---\n`
        );
        const child = (await import("node:child_process")).spawn(plan.cmd, plan.args, {
          cwd: plan.cwd,
          stdio: ["ignore", out, out],
        });
        return await new Promise<SpawnResult>((resolve) => {
          child.on("exit", (code) => resolve({ exitCode: code }));
          child.on("error", () => resolve({ exitCode: -1 }));
        });
      });
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

  /** The conversation this watcher serves, if any (for dispatch_agent to defer). */
  watchedConversation(): string | null {
    const watch = readDispatchWatch();
    return watch?.mode === "chat" && watch.chatUrl ? watch.chatUrl : null;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let watch: DispatchWatch | null = null;
      try {
        watch = readDispatchWatch();
      } catch {
        watch = null;
      }
      try {
        if (watch?.mode === "chat" && watch.chatUrl && watch.workspaceRoot) {
          await this.chatCycle({ ...watch, chatUrl: watch.chatUrl, workspaceRoot: watch.workspaceRoot });
        } else if (this.cached) {
          // No watched conversation: release the machine-global browser.
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
    if (!claimConversation(watch.chatUrl, choice.harness)) return; // a tool-dispatched run owns it
    const prompt = buildDispatchPrompt(view.directive, watch.chatUrl);
    const plan = planSpawn(choice.harness, watch.workspaceRoot, prompt, watch.command);
    const result = await this.spawnFn(plan);
    releaseConversation(watch.chatUrl);
    this.logger.info(`dispatched ${choice.harness} run finished with code ${result.exitCode}`);
    if (result.exitCode !== 0) {
      await driver
        .sendMessage(
          `[C2C]\nSTATE: BLOCKED\nRESULT: the dispatched ${choice.harness} run exited with code ${result.exitCode} without reporting; its log is at ${dispatchLogPath()}.`
        )
        .catch(() => undefined);
    }
  }
}

/** The same protocol note the manual flow sends on first bind. */
export { buildDispatchPrompt, FOLLOW_PROTOCOL_NOTE };

function dispatchLogPath(): string {
  const dir = path.join(getStateDir(), "logs");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "dispatch.log");
}
