import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { getStateDir } from "../config/paths.js";

/**
 * Declarative site description for the control-plane driver.
 *
 * ChatGPT DOM selectors live here — not inline in the driver — so a layout
 * change can be repaired by shipping a new selector pack (an override file
 * in the state dir) without touching driver logic or rebuilding. The driver
 * always has compiled defaults to fall back on; overrides are per-key.
 */

export interface SiteSelectors {
  id: string;
  version: string;
  matches: string[];
  selectors: {
    composer: string;
    assistantTurn: string;
    userTurn: string;
    generating: string;
    loginWall: string;
  };
}

export const DEFAULT_SITE: SiteSelectors = {
  id: "chatgpt",
  version: "chatgpt-1",
  matches: ["https://chatgpt.com/*"],
  selectors: {
    composer: "#prompt-textarea, div[contenteditable='true'][role='textbox']",
    assistantTurn: "[data-message-author-role='assistant']",
    userTurn: "[data-message-author-role='user']",
    generating: "button[data-testid='stop-button'], [data-testid='composer-stop-button']",
    loginWall: "#login-button, a[href*='/auth/login']",
  },
};

const SELECTOR_KEYS = Object.keys(DEFAULT_SITE.selectors) as (keyof SiteSelectors["selectors"])[];

export function selectorsOverrideFile(): string {
  return path.join(getStateDir(), "control-plane", "selectors.json");
}

export interface LoadedSelectors {
  site: SiteSelectors;
  source: "default" | "override";
  problems: string[];
}

/**
 * Load the active selector pack: compiled defaults, overridden per key by
 * <stateDir>/control-plane/selectors.json when that file is present. Invalid
 * overrides never break the driver — the offending key keeps its default and
 * the problem is reported (doctor surfaces it).
 */
export function loadSiteSelectors(): LoadedSelectors {
  const file = selectorsOverrideFile();
  if (!fs.existsSync(file)) return { site: DEFAULT_SITE, source: "default", problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return {
      site: DEFAULT_SITE,
      source: "default",
      problems: [`selectors.json 不是合法 JSON：${(error as Error).message}`],
    };
  }
  const raw = (parsed ?? {}) as Record<string, unknown>;
  const override = (raw.selectors ?? {}) as Record<string, unknown>;
  const selectors = { ...DEFAULT_SITE.selectors };
  const problems: string[] = [];
  for (const key of SELECTOR_KEYS) {
    const value = override[key];
    if (value === undefined) continue; // partial overrides are fine
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`selectors.json 的 ${key} 必须是非空字符串，已沿用默认值`);
      continue;
    }
    selectors[key] = value.trim();
  }
  const version = typeof raw.version === "string" && raw.version.trim() ? raw.version.trim() : DEFAULT_SITE.version;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : DEFAULT_SITE.id;
  return {
    site: { ...DEFAULT_SITE, id, version, selectors },
    source: "override",
    problems,
  };
}

export type SelectorProbe = Record<string, { found: boolean; count: number }>;

/** Count hits for every selector on a live page (doctor DOM probe). */
export async function probeSelectors(page: Page, site: SiteSelectors): Promise<SelectorProbe> {
  const probe: SelectorProbe = {};
  for (const key of SELECTOR_KEYS) {
    const count = await page.locator(site.selectors[key]).count().catch(() => 0);
    probe[key] = { found: count > 0, count };
  }
  return probe;
}
