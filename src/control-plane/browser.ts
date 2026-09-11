import { chromium, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  browserProfileDir,
  resolveChatTarget,
  applyChatBinding,
  normalizeChatUrl,
} from "./state.js";
import { typeMultiline, normalizeForCompare, lastUserText } from "./composer.js";
import { loadSiteSelectors, type SiteSelectors } from "./selectors.js";
import { acquireBrowserLock, type BrowserLock } from "./browser-lock.js";
import { ensureDir, getStateDir } from "../config/paths.js";
import { Logger, nullLogger } from "../logger/index.js";

/**
 * Control-plane browser driver.
 *
 * Wraps the ChatGPT web conversation used for [C2C] state messages and
 * exposes it as five semantic operations. The rules below are hard-won
 * (they come from the original Codex skill) and MUST NOT be relaxed:
 *
 * 1. One browser, one tab. Switch conversations with goto, never new tabs.
 * 2. Poll for replies with cheap DOM checks every 20-30s. Never one long
 *    waitFor; never screenshot polling.
 * 3. A timeout is NOT failure: it means "still generating". Callers
 *    re-check; they never resend a message just because a wait timed out.
 * 4. Only the pairing code may ever be typed into a page by this driver;
 *    OAuth tokens, cookies and session storage are never touched.
 *
 * ChatGPT DOM is untrusted territory: selectors fail and layouts change.
 * Every lookup has fallbacks and errors are honest (`CHATGPT_DOM_CHANGED`
 * rather than a generic throw) so the agent can run doctor / ask the user.
 */

const CHATGPT_HOME = "https://chatgpt.com/";

/** Cheap DOM probe interval. Never hold one long browser wait. */
const POLL_INTERVAL_MS = 25_000;

export type WaitStatus = "generating" | "timeout" | "replied" | "error";

export interface ReplyView {
  status: WaitStatus;
  /** Full text of the latest assistant message, when available. */
  text: string | null;
  /** True when the text starts with `[C2C]` and contains a `STATE:` header. */
  isControlMessage: boolean;
  /** Parsed `STATE:` value from a [C2C] control message. */
  state: string | null;
  /** Present on `timeout` when a reply exists but was not accepted, and why. */
  note?: string;
}

/** Snapshot of the reply log taken when the last message was sent. */
export interface ReplyAnchor {
  count: number;
  text: string;
}

/**
 * Decide whether a reply view is NEW relative to a send anchor. Without an
 * anchor (no send in this process — e.g. after a restart) any reply counts:
 * the driver cannot know better and must not pretend otherwise.
 */
export function isFreshReply(
  view: { messageCount: number; text: string | null },
  anchor: ReplyAnchor | null
): boolean {
  if (!anchor) return true;
  // Message count moved (appended reply, or a different conversation was
  // opened) — treat as new; same count means the last message must have
  // changed in place (streamed/edited) to count.
  if (view.messageCount !== anchor.count) return true;
  return view.text !== anchor.text;
}

export interface SendResult {
  sent: boolean;
  url: string;
}

export interface DriverEvents {
  onNotice?: (message: string) => void;
}

export class ControlPlaneError extends Error {
  constructor(
    public code:
      | "NOT_LOGGED_IN"
      | "CHATGPT_DOM_CHANGED"
      | "BROWSER_LAUNCH_FAILED"
      | "SEND_FAILED"
      | "INVALID_URL"
      | "NO_CONVERSATION",
    message: string
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

/**
 * The control-plane browser is machine-global: one Chromium on one shared
 * profile (one ChatGPT login for every workspace), guarded by a cross-process
 * lock while it runs. Every `ControlPlaneBrowser` instance drives its OWN tab
 * inside that context, so workspaces sharing a process never fight over
 * `goto`. Per-instance rule 1 below still applies to each tab.
 */
interface SharedBrowser {
  context: BrowserContext;
  lock: BrowserLock;
  /** Instances currently driving a tab in this context. */
  refs: number;
  /** Chromium opens one blank tab at launch; the first instance claims it. */
  initialPageClaimed: boolean;
}

let shared: SharedBrowser | null = null;

async function launchSharedContext(workspaceId: string): Promise<SharedBrowser> {
  const acquired = acquireBrowserLock(workspaceId);
  if ("heldBy" in acquired) {
    throw new ControlPlaneError(
      "BROWSER_LAUNCH_FAILED",
      `ChatGPT 控制面浏览器正被另一个进程使用（pid ${acquired.heldBy.pid}，workspace ${acquired.heldBy.workspaceId}）。` +
        "闲置的会话几分钟后会自动释放浏览器；也可以停掉那个会话后重试。"
    );
  }
  const profile = browserProfileDir();
  fs.mkdirSync(profile, { recursive: true });
  const launchOptions = {
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  let context: BrowserContext;
  try {
    // Prefer the system Chrome binary (no extra download). The profile is a
    // dedicated directory — the user's daily Chrome login state is NOT reused.
    context = await chromium.launchPersistentContext(profile, {
      ...launchOptions,
      channel: "chrome",
    });
  } catch (firstError) {
    try {
      context = await chromium.launchPersistentContext(profile, launchOptions);
    } catch {
      // Never leave the lock held by a failed launch.
      acquired.lock.release();
      throw firstError;
    }
  }
  const s: SharedBrowser = { context, lock: acquired.lock, refs: 0, initialPageClaimed: false };
  // The user can close the window, or Chrome can crash: drop the shared
  // handle and free the profile lock so the next driver call relaunches.
  s.context.once("close", () => {
    if (shared === s) shared = null;
    s.lock.release();
  });
  return s;
}

export class ControlPlaneBrowser {
  private page: Page | null = null;
  /** The shared browser this instance currently holds a tab ref on. */
  private sharedRef: SharedBrowser | null = null;
  /** Task whose conversation is currently open; bindings apply to it. */
  private activeTaskId: string | null = null;
  private replyAnchor: ReplyAnchor | null = null;
  /** Active selector pack (external override over compiled defaults). */
  private readonly site: SiteSelectors;
  private readonly logger: Logger;

  constructor(
    private readonly workspaceId: string,
    private readonly events: DriverEvents = {},
    logger?: Logger
  ) {
    this.logger = logger ?? nullLogger;
    this.site = loadSiteSelectors().site;
  }

  /** Lazy-launch (or attach a tab to) the shared Chromium. */
  private async ensurePage(): Promise<Page> {
    if (this.page && this.page.isClosed()) {
      this.page = null;
      this.dropSharedRef();
    }
    if (this.page) return this.page;

    // One relaunch allowed per call: a context may die under us (the user
    // closed the window, Chrome crashed); anything beyond that is a real
    // failure and must surface.
    for (let attempt = 0; ; attempt++) {
      if (!shared) shared = await launchSharedContext(this.workspaceId);
      const s = shared;
      try {
        const initial = s.context.pages()[0];
        if (initial && !initial.isClosed() && !s.initialPageClaimed) {
          // Chromium opens one blank tab at launch; the first instance uses
          // it so no empty tab lingers in the window.
          s.initialPageClaimed = true;
          s.refs++;
          this.sharedRef = s;
          this.page = initial;
          return initial;
        }
        const page = await s.context.newPage();
        s.refs++;
        this.sharedRef = s;
        this.page = page;
        return page;
      } catch (error) {
        if (attempt > 0 || !s.context.isClosed()) throw error;
        // The context died before/while we used it. Its 'close' listener
        // clears `shared` and the lock; do it here too in case the event has
        // not been delivered yet. Both are idempotent.
        if (shared === s) shared = null;
        s.lock.release();
      }
    }
  }

  /** One fewer live tab; the last one out closes the browser and the lock. */
  private dropSharedRef(): void {
    const s = this.sharedRef;
    this.sharedRef = null;
    if (!s) return;
    if (--s.refs > 0) return;
    if (shared === s) shared = null;
    void s.context.close().catch(() => undefined);
    s.lock.release();
  }

  async close(): Promise<void> {
    const page = this.page;
    this.page = null;
    await page?.close().catch(() => undefined);
    this.dropSharedRef();
  }

  /** Current page handle (for diagnostics and login helpers). */
  async currentPage(): Promise<Page> {
    return this.ensurePage();
  }

  /** True when the ChatGPT login wall is absent for the current page. */
  private async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes("/auth/login") || url.includes("auth.openai.com")) return false;
    const loginMarker = await page
      .locator(this.site.selectors.loginWall)
      .count()
      .catch(() => 0);
    return loginMarker === 0;
  }

  /**
   * Open (or take over) the ChatGPT conversation for a task.
   *
   * Resolution: an explicit URL wins; otherwise a known task_id reopens its
   * bound chat, an unknown task_id (or fresh=true) starts a NEW chat on the
   * home page, and no task_id falls back to the workspace-level saved chat.
   * Returns the conversation URL actually used. One chat per task; the same
   * task must always reuse its chat so review context survives.
   */
  async openConversation(
    chatUrl?: string,
    opts: { taskId?: string; fresh?: boolean } = {}
  ): Promise<string> {
    const page = await this.ensurePage();
    const taskId = opts.taskId?.trim() || null;
    this.activeTaskId = taskId;

    let target: string | null = null;
    if (chatUrl) {
      target = normalizeChatUrl(chatUrl);
      if (!target) throw new ControlPlaneError("INVALID_URL", `Not a ChatGPT URL: ${chatUrl}`);
    } else {
      const bound = resolveChatTarget(this.workspaceId, {
        taskId: taskId ?? undefined,
        fresh: opts.fresh,
      });
      target = bound ? normalizeChatUrl(bound) : null;
    }
    if (!target) target = CHATGPT_HOME;

    const onHome = /^[a-z]+:\/\/(?:www\.)?chatgpt\.com\/?$/.test(page.url());
    if (page.url() === target || (target === CHATGPT_HOME && onHome)) {
      // Already there — do not goto the URL we are on.
    } else {
      // The anchor belongs to the old conversation; it is meaningless here.
      this.replyAnchor = null;
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    if (!(await this.isLoggedIn(page))) {
      // Give the user a visible window to log in; the caller decides when to retry.
      this.events.onNotice?.(
        "ChatGPT 需要登录。已打开浏览器窗口，请完成登录后重试。"
      );
      throw new ControlPlaneError(
        "NOT_LOGGED_IN",
        "ChatGPT is showing a login wall. Log in in the opened browser window, then retry."
      );
    }
    const url = page.url().startsWith(CHATGPT_HOME) ? page.url() : target;
    this.bindConversationUrl(url);
    return url;
  }

  /** Persist the conversation binding for the active task (no-op on home). */
  private bindConversationUrl(rawUrl: string): void {
    const url = normalizeChatUrl(rawUrl);
    if (!url) return;
    applyChatBinding(this.workspaceId, url, this.activeTaskId);
  }

  /**
   * Insert one [C2C] message into the composer and submit it, then confirm
   * the send by reading the message back from the conversation log.
   */
  async sendMessage(text: string): Promise<SendResult> {
    const page = await this.ensurePage();
    if (!(await this.isLoggedIn(page))) {
      throw new ControlPlaneError("NOT_LOGGED_IN", "Log in to ChatGPT first (open_conversation).");
    }

    const composer = page.locator(this.site.selectors.composer).first();
    try {
      await composer.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      throw new ControlPlaneError(
        "CHATGPT_DOM_CHANGED",
        "Composer not found. ChatGPT layout may have changed; run awehitch doctor --control-plane."
      );
    }
    // Anchor for "new reply" detection: snapshot the reply log BEFORE sending
    // so waits can distinguish the incoming reply from the previous turn's.
    const assistant = page.locator(this.site.selectors.assistantTurn);
    const count = await assistant.count().catch(() => 0);
    const lastText = count > 0 ? ((await assistant.last().innerText().catch(() => "")) ?? "") : "";
    this.replyAnchor = { count, text: lastText };

    // Multi-line safe input: `type()` would press a plain Enter per "\n" and
    // fragment the message into several submits (issue #1).
    await composer.fill("");
    await composer.click();
    await typeMultiline(page, composer, text);

    // A brand-new chat only gets its permanent /c/<id> URL after the first
    // message lands. Capture it once so the task binding survives restarts;
    // on a wait timeout the next open/bind picks it up instead.
    await page.waitForURL(/chatgpt\.com\/c\//, { timeout: 10_000 }).catch(() => undefined);
    this.bindConversationUrl(page.url());

    // Honest confirmation: the full text must appear as the last user
    // message. An emptied composer proves nothing — it empties on the first
    // Enter even when the rest of the message was never sent.
    const confirmed = await this.waitForReadback(page, text);
    if (!confirmed) {
      throw new ControlPlaneError(
        "SEND_FAILED",
        "The last user message does not match the sent text (fragmented send or DOM change)."
      );
    }
    this.logger.info(`Control message sent (${text.split("\n")[1]?.trim() ?? "?"})`);
    return { sent: true, url: page.url() };
  }

  /** Wait (max ~10s) for the optimistic user-message render to appear. */
  private async waitForReadback(page: Page, text: string): Promise<boolean> {
    const expected = normalizeForCompare(text);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const got = await lastUserText(page, this.site.selectors.userTurn);
      if (got !== null && normalizeForCompare(got) === expected) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  /**
   * Read the latest assistant reply. Cheap DOM check; call in a loop.
   * `generating` means ChatGPT is still typing — keep polling, never resend.
   */
  async readReply(): Promise<ReplyView> {
    const { messageCount, ...view } = await this.readReplyWithCount();
    return view;
  }

  /** ReplyView plus the number of assistant messages on the page. */
  private async readReplyWithCount(): Promise<ReplyView & { messageCount: number }> {
    const page = await this.ensurePage();
    if (!(await this.isLoggedIn(page))) {
      return { status: "error", text: null, isControlMessage: false, state: null, messageCount: 0 };
    }

    const generating = await page
      .locator(this.site.selectors.generating)
      .count()
      .catch(() => 0);

    const assistant = page.locator(this.site.selectors.assistantTurn);
    const count = await assistant.count().catch(() => 0);
    if (count === 0) {
      return {
        status: generating > 0 ? "generating" : "timeout",
        text: null,
        isControlMessage: false,
        state: null,
        messageCount: 0,
      };
    }
    const text = (await assistant.last().innerText().catch(() => "")) ?? "";
    if (generating > 0) {
      return { status: "generating", text, isControlMessage: false, state: null, messageCount: count };
    }
    const isControlMessage = text.trimStart().startsWith("[C2C]");
    const state = isControlMessage ? text.match(/^STATE:\s*(\w+)/m)?.[1] ?? null : null;
    return { status: "replied", text, isControlMessage, state, messageCount: count };
  }

  /**
   * Wait for a reply with cheap DOM checks at 20-30s intervals, up to
   * `timeoutMs`. Only replies that are NEW relative to the last send (see
   * `replyAnchor`) are reported as `replied`; the pre-send reply shows up in
   * the `timeout` view instead — it is NOT the answer to the last message.
   * A timeout is reported honestly (`timeout` status) — it is NOT a failure
   * and must not trigger a resend by the caller.
   */
  async waitReply(opts: { timeoutMs?: number; expectState?: string } = {}): Promise<ReplyView> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { messageCount, ...reply } = await this.readReplyWithCount();
      const fresh =
        reply.status === "replied" && isFreshReply({ messageCount, text: reply.text }, this.replyAnchor);
      if (fresh) {
        if (!opts.expectState || reply.state === opts.expectState) return reply;
        // A fresh reply exists but is not the expected state — keep polling gently.
      }
      if (Date.now() >= deadline) {
        let note: string | undefined;
        if (reply.status === "replied") {
          note = fresh
            ? `a reply is present with STATE: ${reply.state ?? "?"} (expected ${opts.expectState})`
            : "the latest reply predates the last sent message; no new reply arrived";
        }
        return { ...reply, status: "timeout", note };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

/**
 * Login helper: opens the profile browser at the ChatGPT login page and
 * waits (max `timeoutMs`) until the login wall disappears.
 */
export async function interactiveLogin(workspaceId: string, timeoutMs = 5 * 60_000): Promise<boolean> {
  const driver = new ControlPlaneBrowser(workspaceId, {
    onNotice: (message) => process.stderr.write(`${message}\n`),
  });
  try {
    try {
      await driver.openConversation(CHATGPT_HOME);
    } catch (error) {
      // A login wall is exactly why this command exists: the browser window
      // is open now — swallow it and wait for the user to finish below.
      if (!(error instanceof ControlPlaneError) || error.code !== "NOT_LOGGED_IN") throw error;
    }
    const page = await driver.currentPage();
    const loginWall = loadSiteSelectors().site.selectors.loginWall;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const url = page.url();
      const onLogin = url.includes("/auth/login") || url.includes("auth.openai.com");
      if (!onLogin) {
        const marker = await page
          .locator(loginWall)
          .count()
          .catch(() => 0);
        if (marker === 0) return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    return false;
  } finally {
    await driver.close();
  }
}

/** Where the control-plane proxy writes its own diagnostics log. */
export function controlPlaneLogFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "logs")), `control-plane-${workspaceId}.log`);
}

/** Temp file helper for the CLI transport (agent -> proxy payload). */
export function tempDir(): string {
  return ensureDir(path.join(getStateDir(), "tmp", os.hostname()));
}
