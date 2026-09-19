import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { ControlPlaneBrowser } from "../src/control-plane/browser.js";
import {
  applyChatBinding,
  readControlPlaneState,
} from "../src/control-plane/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  stateDir = makeTmpDir("control-plane-browser");
  previousStateDir = process.env.AWEHITCH_STATE_DIR;
  process.env.AWEHITCH_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.AWEHITCH_STATE_DIR;
  else process.env.AWEHITCH_STATE_DIR = previousStateDir;
  cleanup(stateDir);
});

const WS = "ws-driver";

/** Minimal fake Page: only the surface the driver methods under test touch. */
function fakePage(url: string): Page {
  const state: { url: string } = { url };
  return {
    url: () => state.url,
    isClosed: () => false,
    close: async () => undefined,
    goto: vi.fn(async (target: string) => {
      state.url = target;
    }),
    // Every selector probe returns 0 matches: no login wall, nothing
    // generating, no assistant turn → readReply reports an honest timeout.
    locator: vi.fn(() => ({ count: async () => 0 })),
  } as unknown as Page;
}

function driverFor(page: Page, harness?: string): ControlPlaneBrowser {
  const d = new ControlPlaneBrowser(WS, {}, undefined, harness);
  // Bypass lazy launch: hand the driver a live tab and no shared ref so
  // dropSharedRef early-returns and nothing touches Playwright.
  (d as unknown as { page: Page }).page = page;
  (d as unknown as { sharedRef: null }).sharedRef = null;
  return d;
}

describe("close() persists the open conversation", () => {
  it("binds the active task's /c/ URL before the tab goes away", async () => {
    const page = fakePage("https://chatgpt.com/c/abc-123");
    const d = driverFor(page);
    (d as unknown as { activeTaskId: string }).activeTaskId = "weather";

    await d.close();

    const saved = readControlPlaneState(WS);
    expect(saved?.chatUrl).toBe("https://chatgpt.com/c/abc-123");
    expect(saved?.taskChats?.weather).toBe("https://chatgpt.com/c/abc-123");
  });

  it("binds nothing when the page is on the home page", async () => {
    const page = fakePage("https://chatgpt.com/");
    const d = driverFor(page);
    (d as unknown as { activeTaskId: string }).activeTaskId = "weather";

    await d.close();

    expect(readControlPlaneState(WS)).toBeNull();
  });

  it("does not throw and binds nothing when the page is already closed", async () => {
    const page = {
      url: () => "https://chatgpt.com/c/abc-123",
      isClosed: () => true,
      close: async () => undefined,
    } as unknown as Page;
    const d = driverFor(page);
    (d as unknown as { activeTaskId: string }).activeTaskId = "weather";

    await d.close();

    expect(readControlPlaneState(WS)).toBeNull();
  });
});

describe("ensureConversationOpen recovers a blank tab after relaunch", () => {
  it("reopens the saved workspace chat when the tab is blank", async () => {
    applyChatBinding(WS, "https://chatgpt.com/c/saved", "other");
    const page = fakePage("about:blank");
    const d = driverFor(page);

    await (d as unknown as { ensureConversationOpen: (p: Page) => Promise<void> }).ensureConversationOpen(page);

    expect((page.goto as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "https://chatgpt.com/c/saved"
    );
  });

  it("falls back to the home page when no chat is saved", async () => {
    const page = fakePage("about:blank");
    const d = driverFor(page);

    await (d as unknown as { ensureConversationOpen: (p: Page) => Promise<void> }).ensureConversationOpen(page);

    expect((page.goto as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "https://chatgpt.com/"
    );
  });

  it("leaves a tab already on http(s) untouched (no goto)", async () => {
    const page = fakePage("https://chatgpt.com/");
    const d = driverFor(page);

    await (d as unknown as { ensureConversationOpen: (p: Page) => Promise<void> }).ensureConversationOpen(page);

    expect(page.goto as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("scopes recovery to the harness slice", async () => {
    applyChatBinding(WS, "https://chatgpt.com/c/zcode", null, "zcode");
    applyChatBinding(WS, "https://chatgpt.com/c/codex", null, "codex");
    const page = fakePage("about:blank");
    const d = driverFor(page, "codex");

    await (d as unknown as { ensureConversationOpen: (p: Page) => Promise<void> }).ensureConversationOpen(page);

    expect((page.goto as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "https://chatgpt.com/c/codex"
    );
  });
});

describe("readReply persists the conversation URL on every poll", () => {
  it("binds the active task's URL while polling for a reply", async () => {
    const page = fakePage("https://chatgpt.com/c/poll-1");
    const d = driverFor(page);
    (d as unknown as { activeTaskId: string }).activeTaskId = "weather";

    const view = await d.readReply();

    // No assistant turns on the fake page → honest timeout, not a failure.
    expect(view.status).toBe("timeout");
    const saved = readControlPlaneState(WS);
    expect(saved?.taskChats?.weather).toBe("https://chatgpt.com/c/poll-1");
  });
});

describe("listRecentConversations waits for the client-rendered sidebar", () => {
  it("scrapes after the sidebar link appears, not at domcontentloaded", async () => {
    const handle = { getAttribute: async (name: string) => (name === "href" ? "/c/abc-123" : null) };
    let hydrated = false;
    const page = {
      url: () => "https://chatgpt.com/",
      isClosed: () => false,
      close: async () => undefined,
      goto: vi.fn(),
      locator: vi.fn(() => ({
        count: async () => 0,
        elementHandles: async () => (hydrated ? [handle] : []),
      })),
      waitForSelector: vi.fn(async () => {
        hydrated = true; // the wait is what makes the links appear
        return handle;
      }),
    } as unknown as Page;
    const d = driverFor(page);

    await expect(d.listRecentConversations(3)).resolves.toEqual(["https://chatgpt.com/c/abc-123"]);
    expect((page as unknown as { waitForSelector: ReturnType<typeof vi.fn> }).waitForSelector).toHaveBeenCalled();
  });

  it("returns an honest empty list when the sidebar never renders", async () => {
    const page = {
      url: () => "https://chatgpt.com/",
      isClosed: () => false,
      close: async () => undefined,
      goto: vi.fn(),
      locator: vi.fn(() => ({ count: async () => 0, elementHandles: async () => [] })),
      waitForSelector: vi.fn(async () => {
        throw new Error("Timeout 15000ms exceeded");
      }),
    } as unknown as Page;
    const d = driverFor(page);

    await expect(d.listRecentConversations(3)).resolves.toEqual([]);
  });
});
