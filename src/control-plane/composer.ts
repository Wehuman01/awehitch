import type { Locator, Page } from "playwright";

/**
 * Multi-line input and readback for the ChatGPT composer.
 *
 * `locator.type()` presses a plain Enter for every "\n" — and plain Enter
 * SUBMITS in ChatGPT — so a multi-line [C2C] message fragments into several
 * partial sends (issue #1). The safe path: insert each line as text (input
 * events only, no keydown), join lines with Shift+Enter, and press a single
 * plain Enter at the very end to submit.
 *
 * A whole-text `insertText(text)` is NOT safe either: it collapses the
 * consecutive blank lines the protocol format relies on. Line by line.
 */
export async function typeMultiline(page: Page, composer: Locator, text: string): Promise<void> {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press("Shift+Enter");
    if (lines[i]) await page.keyboard.insertText(lines[i]);
  }
  await page.keyboard.press("Enter");
}

/**
 * Normalize text for send readback: strip zero-width characters ChatGPT's
 * editor inserts and fold whitespace, so DOM rendering differences (blank
 * lines, <br> vs paragraphs) cannot fake a mismatch.
 */
export function normalizeForCompare(text: string): string {
  return text
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Latest user message text on the page, or null when none exists yet. */
export async function lastUserText(page: Page, userSelector: string): Promise<string | null> {
  const turn = page.locator(userSelector).last();
  const count = await turn.count().catch(() => 0);
  if (count === 0) return null;
  return (await turn.innerText().catch(() => "")) ?? "";
}
