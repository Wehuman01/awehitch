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
import { ensureDir, getStateDir } from "../config/paths.js";
import { Logger, nullLogger } from "../logger/index.js";

/**
 * Control-plane browser driver.
 *
 * Wraps the ChatGPT web conversation used for [C2C] state messages and
 * exposes it as four semantic operations. The rules below are hard-won
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

export class ControlPlaneBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  /** Task whose conversation is currently open; bindings apply to it. */
  private activeTaskId: string | null = null;
  private readonly logger: Logger;

  constructor(
    private readonly workspaceId: string,
    private readonly events: DriverEvents = {},
    logger?: Logger
  ) {
    this.logger = logger ?? nullLogger;
  }

  /** Lazy-launch a dedicated-profile Chromium. Uses system Chrome when present. */
  private async ensurePage(): Promise<Page> {
    if (this.page && this.page.isClosed()) {
      this.page = null;
      this.context = null;
    }
    if (this.page) return this.page;

    const profile = browserProfileDir(this.workspaceId);
    fs.mkdirSync(profile, { recursive: true });
    const launchOptions = {
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    };
    try {
      // Prefer the user's real Chrome (no extra download, existing login).
      this.context = await chromium.launchPersistentContext(profile, {
        ...launchOptions,
        channel: "chrome",
      });
    } catch {
      this.context = await chromium.launchPersistentContext(profile, launchOptions);
    }
    const pages = this.context.pages();
    this.page = pages[0] ?? (await this.context.newPage());
    return this.page;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
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
      .locator("#login-button, a[href*='/auth/login']")
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

  /** The composer is contenteditable in current ChatGPT; fill + submit. */
  async sendMessage(text: string): Promise<SendResult> {
    const page = await this.ensurePage();
    if (!(await this.isLoggedIn(page))) {
      throw new ControlPlaneError("NOT_LOGGED_IN", "Log in to ChatGPT first (open_conversation).");
    }

    const composer = page
      .locator("#prompt-textarea, div[contenteditable='true'][role='textbox']")
      .first();
    try {
      await composer.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      throw new ControlPlaneError(
        "CHATGPT_DOM_CHANGED",
        "Composer not found. ChatGPT layout may have changed; run awehitch doctor."
      );
    }
    await composer.fill("");
    await composer.type(text, { delay: 10 });
    await page.keyboard.press("Enter");

    // A brand-new chat only gets its permanent /c/<id> URL after the first
    // message lands. Capture it once so the task binding survives restarts;
    // on a wait timeout the next open/bind picks it up instead.
    await page.waitForURL(/chatgpt\.com\/c\//, { timeout: 10_000 }).catch(() => undefined);
    this.bindConversationUrl(page.url());

    // Cheap confirmation: the composer empties and the message appears in the log.
    const sent = await composer
      .evaluate((node) => (node as HTMLElement).innerText.trim().length === 0)
      .catch(() => false);
    this.logger.info(`Control message sent (${text.split("\n")[1]?.trim() ?? "?"})`);
    return { sent, url: page.url() };
  }

  /**
   * Read the latest assistant reply. Cheap DOM check; call in a loop.
   * `generating` means ChatGPT is still typing — keep polling, never resend.
   */
  async readReply(): Promise<ReplyView> {
    const page = await this.ensurePage();
    if (!(await this.isLoggedIn(page))) {
      return { status: "error", text: null, isControlMessage: false, state: null };
    }

    const generating = await page
      .locator("button[data-testid='stop-button'], [data-testid='composer-stop-button']")
      .count()
      .catch(() => 0);

    const message = page.locator("[data-message-author-role='assistant']").last();
    const count = await message.count().catch(() => 0);
    if (count === 0) {
      return {
        status: generating > 0 ? "generating" : "timeout",
        text: null,
        isControlMessage: false,
        state: null,
      };
    }
    const text = (await message.innerText().catch(() => "")) ?? "";
    if (generating > 0) {
      return { status: "generating", text, isControlMessage: false, state: null };
    }
    const isControlMessage = text.trimStart().startsWith("[C2C]");
    const state = isControlMessage ? text.match(/^STATE:\s*(\w+)/m)?.[1] ?? null : null;
    return { status: "replied", text, isControlMessage, state };
  }

  /**
   * Wait for a reply with cheap DOM checks at 20-30s intervals, up to
   * `timeoutMs`. A timeout is reported honestly (`timeout` status) — it is
   * NOT a failure and must not trigger a resend by the caller.
   */
  async waitReply(opts: { timeoutMs?: number; expectState?: string } = {}): Promise<ReplyView> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const reply = await this.readReply();
      if (reply.status === "replied") {
        if (!opts.expectState || reply.state === opts.expectState) return reply;
        // A reply exists but is not the expected state — keep polling gently.
      }
      if (Date.now() >= deadline) return { ...reply, status: "timeout" };
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
    await driver.openConversation(CHATGPT_HOME);
    const page = await driver.currentPage();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const url = page.url();
      const onLogin = url.includes("/auth/login") || url.includes("auth.openai.com");
      if (!onLogin) {
        const marker = await page
          .locator("#login-button, a[href*='/auth/login']")
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
