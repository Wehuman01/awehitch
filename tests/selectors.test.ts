import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import {
  DEFAULT_SITE,
  loadSiteSelectors,
  probeSelectors,
  selectorsOverrideFile,
} from "../src/control-plane/selectors.js";
import { cleanup, makeTmpDir } from "./helpers.js";

/**
 * Selector-pack contract: loader merge/validation plus a live-DOM probe
 * against a ChatGPT-shaped fixture, so a selector that no longer matches
 * fails here instead of in a coding session.
 */
const browser: Browser | null = await (async () => {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    try {
      return await chromium.launch({ headless: true, channel: "chrome" });
    } catch {
      return null;
    }
  }
})();

const FIXTURE = `<!doctype html><html><body>
  <main>
    <div id="log">
      <div data-message-author-role="user">[C2C] hi</div>
      <div data-message-author-role="assistant">[C2C] STATE: PLAN</div>
    </div>
    <button data-testid="composer-stop-button"></button>
    <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
    <button id="login-button">Log in</button>
  </main>
</body></html>`;

describe("loadSiteSelectors", () => {
  let stateDir: string;
  let previous: string | undefined;

  beforeEach(() => {
    stateDir = makeTmpDir("selectors-state");
    previous = process.env.AWEHITCH_STATE_DIR;
    process.env.AWEHITCH_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.AWEHITCH_STATE_DIR;
    else process.env.AWEHITCH_STATE_DIR = previous;
    cleanup(stateDir);
  });

  it("returns compiled defaults when no override file exists", () => {
    const loaded = loadSiteSelectors();
    expect(loaded.source).toBe("default");
    expect(loaded.problems).toEqual([]);
    expect(loaded.site.selectors).toEqual(DEFAULT_SITE.selectors);
  });

  it("merges a partial override over defaults", () => {
    fs.mkdirSync(path.dirname(selectorsOverrideFile()), { recursive: true });
    fs.writeFileSync(
      selectorsOverrideFile(),
      JSON.stringify({ id: "chatgpt", version: "chatgpt-2", selectors: { composer: "#new-composer" } })
    );
    const loaded = loadSiteSelectors();
    expect(loaded.source).toBe("override");
    expect(loaded.site.version).toBe("chatgpt-2");
    expect(loaded.site.selectors.composer).toBe("#new-composer");
    expect(loaded.site.selectors.assistantTurn).toBe(DEFAULT_SITE.selectors.assistantTurn);
    expect(loaded.problems).toEqual([]);
  });

  it("falls back per key on invalid values and broken JSON", () => {
    fs.mkdirSync(path.dirname(selectorsOverrideFile()), { recursive: true });
    fs.writeFileSync(selectorsOverrideFile(), JSON.stringify({ selectors: { composer: "  " } }));
    let loaded = loadSiteSelectors();
    expect(loaded.site.selectors.composer).toBe(DEFAULT_SITE.selectors.composer);
    expect(loaded.problems.join("")).toContain("composer");

    fs.writeFileSync(selectorsOverrideFile(), "{ not json");
    loaded = loadSiteSelectors();
    expect(loaded.site.selectors).toEqual(DEFAULT_SITE.selectors);
    expect(loaded.problems.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!browser)("probeSelectors against a ChatGPT-shaped fixture", () => {
  let page: Page;

  beforeAll(async () => {
    if (!browser) return;
    page = await browser.newPage();
    await page.setContent(FIXTURE);
  });

  afterAll(async () => {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  });

  it("hits every default selector", async () => {
    const probe = await probeSelectors(page, DEFAULT_SITE);
    for (const [key, result] of Object.entries(probe)) {
      expect(result.found, `${key} should hit the fixture`).toBe(true);
    }
  });

  it("reports a broken override key as not found", async () => {
    const probe = await probeSelectors(page, {
      ...DEFAULT_SITE,
      selectors: { ...DEFAULT_SITE.selectors, composer: "#does-not-exist" },
    });
    expect(probe.composer.found).toBe(false);
    expect(probe.assistantTurn.found).toBe(true);
  });
});
