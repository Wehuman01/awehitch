import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  lastUserText,
  normalizeForCompare,
  typeMultiline,
} from "../src/control-plane/composer.js";
import { DEFAULT_SITE } from "../src/control-plane/selectors.js";

/**
 * Offline DOM contract tests for the composer path (issue #1).
 *
 * A real headless Chromium loads a fixture that models the one behavior the
 * P0 bug hinged on: plain Enter SUBMITS, Shift+Enter inserts a newline. If
 * Playwright browsers are not installed the suite skips loudly.
 */
const browser: Browser | null = await (async () => {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    // Playwright's own download may be missing/older — the system Chrome is
    // the same binary the control-plane driver prefers anyway.
    try {
      return await chromium.launch({ headless: true, channel: "chrome" });
    } catch {
      return null;
    }
  }
})();

const FIXTURE = `<!doctype html><html><body>
  <main>
    <div id="log"></div>
    <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
  </main>
  <script>
    const composer = document.querySelector('#prompt-textarea');
    const log = document.querySelector('#log');
    composer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (composer.innerText.trim() === '') return;
        const turn = document.createElement('div');
        turn.setAttribute('data-message-author-role', 'user');
        turn.textContent = composer.innerText;
        log.appendChild(turn);
        composer.innerHTML = '';
      }
    });
  </script>
</body></html>`;

const PROTOCOL_MESSAGE = `[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
Implement dark mode.

INSTRUCTION:
Inspect the workspace and produce a PLAN.`;

describe.skipIf(!browser)("composer DOM contract (headless chromium)", () => {
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

  it("sends a multi-line [C2C] message as ONE user turn, not fragments", async () => {
    const composer = page.locator(DEFAULT_SITE.selectors.composer).first();
    await composer.click();
    await typeMultiline(page, composer, PROTOCOL_MESSAGE);

    const turns = page.locator(DEFAULT_SITE.selectors.userTurn);
    expect(await turns.count()).toBe(1);
    const got = await lastUserText(page, DEFAULT_SITE.selectors.userTurn);
    expect(got).not.toBeNull();
    expect(normalizeForCompare(got ?? "")).toBe(normalizeForCompare(PROTOCOL_MESSAGE));
    // Line-structure preservation is intentionally NOT asserted here: this
    // minimal contenteditable renders <br> as spaces in innerText, while the
    // real composer renders paragraphs. The driver's whitespace-normalized
    // readback (normalizeForCompare) is what makes the check portable — and
    // fragmented Enters would fail the full-text equality above anyway.
  });

  it("reads back the sent text as the LAST user message", async () => {
    const composer = page.locator(DEFAULT_SITE.selectors.composer).first();
    await composer.click();
    await typeMultiline(page, composer, "[C2C]\nSTATE: EXECUTED\nTASK_ID: c2c_f81a");
    const got = await lastUserText(page, DEFAULT_SITE.selectors.userTurn);
    expect(normalizeForCompare(got ?? "")).toBe(
      normalizeForCompare("[C2C]\nSTATE: EXECUTED\nTASK_ID: c2c_f81a")
    );
  });

  it("keeps an empty send from creating a turn", async () => {
    const composer = page.locator(DEFAULT_SITE.selectors.composer).first();
    await composer.click();
    await typeMultiline(page, composer, "\n\n");
    // Two Shift+Enters and a final Enter on an empty composer: the fixture
    // (like ChatGPT) refuses empty submits.
    expect(await page.locator(DEFAULT_SITE.selectors.userTurn).count()).toBe(2); // turns from the tests above
  });
});
