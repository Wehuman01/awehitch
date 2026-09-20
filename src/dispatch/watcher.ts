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
  noteClaimPid,
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
  /** Give up the session slot too (short-lived drivers); optional seam. */
  dispose?(): Promise<void>;
}

export type DispatchSpawnFn = (
  plan: { cmd: string; args: string[]; cwd: string },
  onStart?: (pid: number | undefined) => void
) => Promise<SpawnResult>;

export interface DispatchWatcherOptions {
  pollMs?: number;
  logger?: Logger;
  /** Test seam: inject a driver instead of a real Playwright browser. */
  driver?: DispatchDriver;
  /** Test seam: run the spawn and await its exit. */
  spawnFn?: DispatchSpawnFn;
  /** Test seam: which harnesses are installed (default: detect on disk). */
  installedFn?: () => HarnessId[];
}

export class DispatchWatcher {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private cached: { root: string; driver: DispatchDriver; marker: string } | null = null;
  private wake: (() => void) | null = null;
  /**
   * A directive that arrived while another executor owned the conversation
   * (a tool-dispatched run): kept for the next cycle instead of being
   * silently dropped or double-fired.
   */
  private pendingDirective: string | null = null;
  private readonly pollMs: number;
  private readonly logger: Logger;
  private readonly injectedDriver: DispatchDriver | null;
  private readonly spawnFn: DispatchSpawnFn;
  private readonly installedFn: () => HarnessId[];

  constructor(opts: DispatchWatcherOptions = {}) {
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.logger = opts.logger ?? new Logger({ name: "dispatch", console: false });
    this.injectedDriver = opts.driver ?? null;
    this.installedFn = opts.installedFn ?? detectHarnesses;
    this.spawnFn =
      opts.spawnFn ??
      (async (plan, onStart) => {
        const out = fs.openSync(dispatchLogPath(), "a");
        fs.appendFileSync(
          dispatchLogPath(),
          `\n--- dispatch spawn ${new Date().toISOString()} cwd=${plan.cwd} cmd=${plan.cmd} ---\n`
        );
        const child = (await import("node:child_process")).spawn(plan.cmd, plan.args, {
          cwd: plan.cwd,
          stdio: ["ignore", out, out],
        });
        // The child dups the fd; the watcher must not leak one per spawn.
        fs.closeSync(out);
        onStart?.(child.pid);
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
    if (this.loopPromise) {
      // The loop may be awaiting a spawned run's exit (minutes, hours):
      // shutdown must not hang on it. The run keeps going; the watcher
      // stops watching.
      await Promise.race([
        this.loopPromise,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          timer.unref?.();
        }),
      ]);
    }
    this.loopPromise = null;
    if (this.cached) {
      const driver = this.cached.driver;
      await (driver.dispose ? driver.dispose() : driver.close()).catch(() => undefined);
    }
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

  private driverFor(workspaceRoot: string): { driver: DispatchDriver; marker: string } {
    if (this.cached?.root !== workspaceRoot) {
      if (this.cached) {
        const stale = this.cached.driver;
        void (stale.dispose ? stale.dispose() : stale.close()).catch(() => undefined);
      }
      // The marker comes from the WATCHED workspace's config — the CLI
      // prints "type this marker" from the same place, so honoring anything
      // else would silently disarm the watch.
      let dispatchMarker: string | undefined;
      try {
        dispatchMarker = new Workspace(workspaceRoot).projectConfig.dispatchMarker;
      } catch {
        // A vanished root is doctor's report; the default marker applies.
      }
      const driver =
        this.injectedDriver ??
        new ControlPlaneBrowser(new Workspace(workspaceRoot).id, {}, this.logger, "dispatch");
      this.cached = { root: workspaceRoot, driver, marker: resolveDispatchMarker(dispatchMarker) };
    }
    return { driver: this.cached.driver, marker: this.cached.marker };
  }

  private async chatCycle(watch: DispatchWatch & { chatUrl: string; workspaceRoot: string }): Promise<void> {
    const { driver, marker } = this.driverFor(watch.workspaceRoot);
    // One-time protocol note per conversation: ChatGPT must know the
    // DIRECTIVE format before it can dispatch anything.
    if (watch.notedUrl !== watch.chatUrl) {
      await driver.openConversation(watch.chatUrl);
      await driver.sendMessage(FOLLOW_PROTOCOL_NOTE);
      writeDispatchWatch({ ...watch, notedUrl: watch.chatUrl });
      this.logger.info(`dispatch watch armed on ${watch.chatUrl}`);
      return;
    }
    let directive: string | null = null;
    if (this.pendingDirective !== null) {
      directive = this.pendingDirective;
    } else {
      const view = await driver.waitDirective({ timeoutMs: this.pollMs, marker });
      if (view.status !== "directive" || !view.directive) return;
      if (view.directive === watch.lastDirective) return; // already executed (restart dedup)
      directive = view.directive;
    }

    const choice = pickHarness(watch, directive, this.installedFn());
    if (!choice.ok) {
      await driver.sendMessage(`[C2C]\nSTATE: BLOCKED\nRESULT: ${choice.reason}`);
      writeDispatchWatch({ ...watch, lastDirective: directive });
      this.pendingDirective = null;
      return;
    }

    // Claim FIRST. Persisting before a failed claim would mark a directive
    // as executed that nobody ever spawned — a silent drop. A claim held by
    // a tool-dispatched run parks the directive for the next cycle instead.
    if (!claimConversation(watch.chatUrl, choice.harness)) {
      this.pendingDirective = directive;
      this.logger.info(`dispatch watch deferred a directive: ${watch.chatUrl} has an active agent session`);
      return;
    }
    // Persist before spawning: a crash mid-run must not re-fire the task.
    writeDispatchWatch({ ...watch, lastDirective: directive });
    this.pendingDirective = null;
    const prompt = buildDispatchPrompt(directive, watch.chatUrl);
    const plan = planSpawn(choice.harness, watch.workspaceRoot, prompt, watch.command);
    const result = await this.spawnFn(plan, (pid) => noteClaimPid(watch.chatUrl, pid));
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
