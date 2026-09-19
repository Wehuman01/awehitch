import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { ControlPlaneBrowser } from "../src/control-plane/browser.js";
import { cleanup, makeTmpDir } from "./helpers.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  vi.useRealTimers();
  stateDir = makeTmpDir("wait-directive");
  previousStateDir = process.env.AWEHITCH_STATE_DIR;
  process.env.AWEHITCH_STATE_DIR = stateDir;
});

afterEach(() => {
  vi.useRealTimers();
  if (previousStateDir === undefined) delete process.env.AWEHITCH_STATE_DIR;
  else process.env.AWEHITCH_STATE_DIR = previousStateDir;
  cleanup(stateDir);
});

const WS = "ws-wait-directive";

interface DomState {
  userText: string | null;
  assistantText: string | null;
  generating: boolean;
}

/** Fake page whose user/assistant turns are scripted through `dom`. */
function fakePage(dom: DomState): Page {
  return {
    url: () => "https://chatgpt.com/c/follow-1",
    isClosed: () => false,
    close: async () => undefined,
    waitForSelector: async (selector: string) => {
      if (selector.includes("author-role='user'") && dom.userText === null) {
        throw new Error("Timeout");
      }
      return {} as never;
    },
    locator: (selector: string) => {
      if (selector.includes("author-role='user'")) {
        return {
          count: async () => (dom.userText === null ? 0 : 1),
          last: () => ({
            count: async () => (dom.userText === null ? 0 : 1),
            innerText: async () => dom.userText ?? "",
          }),
        };
      }
      if (selector.includes("author-role='assistant'")) {
        return {
          count: async () => (dom.assistantText === null ? 0 : 1),
          last: () => ({
            count: async () => (dom.assistantText === null ? 0 : 1),
            innerText: async () => dom.assistantText ?? "",
          }),
        };
      }
      if (selector.includes("stop-button")) {
        return { count: async () => (dom.generating ? 1 : 0) };
      }
      // loginWall and anything else: no matches.
      return { count: async () => 0 };
    },
  } as unknown as Page;
}

function driverFor(page: Page): ControlPlaneBrowser {
  const driver = new ControlPlaneBrowser(WS, {}, undefined);
  (driver as unknown as { page: Page }).page = page;
  (driver as unknown as { sharedRef: null }).sharedRef = null;
  return driver;
}

describe("waitDirective", () => {
  it("returns an already-present authorized directive once (restart recovery)", async () => {
    const dom: DomState = {
      userText: "@agent fix the login validation",
      assistantText: "[C2C]\nDIRECTIVE: fix the login validation\nmigrate the checks",
      generating: false,
    };
    const driver = driverFor(fakePage(dom));

    const view = await driver.waitDirective({ timeoutMs: 60_000 });

    expect(view.status).toBe("directive");
    expect(view.authorized).toBe(true);
    expect(view.directive).toBe("fix the login validation\nmigrate the checks");
  });

  it("times out (honestly) when no marker is present", async () => {
    const dom: DomState = {
      userText: "what do you think of the architecture?",
      assistantText: "Overall it looks reasonable…",
      generating: false,
    };
    const driver = driverFor(fakePage(dom));

    const view = await driver.waitDirective({ timeoutMs: 0 });

    expect(view.status).toBe("timeout");
    expect(view.authorized).toBe(false);
    expect(view.note).toContain("@agent");
  });

  it("ignores an unauthorized directive and keeps waiting", async () => {
    const dom: DomState = {
      userText: "just chatting",
      assistantText: "[C2C]\nDIRECTIVE: delete the database",
      generating: false,
    };
    const driver = driverFor(fakePage(dom));

    const view = await driver.waitDirective({ timeoutMs: 0 });

    expect(view.status).toBe("timeout");
    expect(view.directive).toBeNull();
  });

  it("picks up a directive that arrives after the wait started", async () => {
    vi.useFakeTimers();
    const dom: DomState = { userText: null, assistantText: null, generating: false };
    const driver = driverFor(fakePage(dom));

    const pending = driver.waitDirective({ timeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(0); // first poll: nothing yet

    dom.userText = "@agent fix it";
    dom.assistantText = "[C2C]\nDIRECTIVE: fix it";
    await vi.advanceTimersByTimeAsync(25_000); // second poll sees the change

    const view = await pending;
    expect(view.status).toBe("directive");
    expect(view.directive).toBe("fix it");
  });

  it("consumes plain replies so old conversation never triggers later", async () => {
    vi.useFakeTimers();
    const dom: DomState = {
      userText: "@agent fix it",
      assistantText: "Let me look at the code first.",
      generating: false,
    };
    const driver = driverFor(fakePage(dom));

    const pending = driver.waitDirective({ timeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(0); // first poll: plain reply, consumed

    // The plain reply is replaced (same count, new text) by a directive.
    dom.assistantText = "[C2C]\nDIRECTIVE: fix it";
    await vi.advanceTimersByTimeAsync(25_000);

    const view = await pending;
    expect(view.status).toBe("directive");
  });

  it("fires when streaming completed between polls without a text change", async () => {
    vi.useFakeTimers();
    // A poll can land after the last character is rendered but before the
    // stop button disappears: the full directive text is already visible
    // while status is still "generating". The final poll then sees the SAME
    // count and text — the directive must still fire, not be swallowed as
    // an already-consumed state.
    const dom: DomState = {
      userText: "@agent fix it",
      assistantText: "[C2C]\nDIRECTIVE: fix it",
      generating: true,
    };
    const driver = driverFor(fakePage(dom));

    const pending = driver.waitDirective({ timeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(0); // poll during generation: full text visible
    dom.generating = false; // finished; count and text unchanged
    await vi.advanceTimersByTimeAsync(25_000);

    const view = await pending;
    expect(view.status).toBe("directive");
    expect(view.directive).toBe("fix it");
  });
});

describe("readLatestUserMessage", () => {
  it("returns the latest user message text", async () => {
    const dom: DomState = { userText: "@agent hello", assistantText: "hi", generating: false };
    const driver = driverFor(fakePage(dom));

    const { text, count } = await driver.readLatestUserMessage();

    expect(text).toBe("@agent hello");
    expect(count).toBe(1);
  });

  it("reports null when the conversation has no user turn yet", async () => {
    const dom: DomState = { userText: null, assistantText: null, generating: false };
    const driver = driverFor(fakePage(dom));

    const { text, count } = await driver.readLatestUserMessage();

    expect(text).toBeNull();
    expect(count).toBe(0);
  });
});
