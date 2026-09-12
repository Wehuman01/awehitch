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
 *
 * Two groups live in one pack:
 *
 * - `selectors` — the conversation surface (composer, turns, login wall).
 * - `connector` — the connectors settings surface used by `connector-setup`.
 *   Every entry is a LIST of candidate selectors tried in order, because the
 *   connector UI has no stable test ids across locales. Text-based candidates
 *   are substring matches, so name lookups additionally verify the exact
 *   connector title in JS (see `control-plane/connector.ts`) — a selector can
 *   never be trusted to prove "this row is MY connector".
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
  connector: ConnectorSelectorPack;
}

export const CONNECTOR_TARGETS = [
  "developerModeToggle",
  "confirmToggle",
  "connectorRow",
  "connectorRowName",
  "rowMenu",
  "pluginActions",
  "menuDelete",
  "confirmDelete",
  "connectButton",
  "signInButton",
  "nameField",
  "descriptionField",
  "serverUrlField",
  "authSelect",
  "authOAuthOption",
  "consentCheckbox",
  "createButton",
  "pairingCodeField",
  "authorizeButton",
  "pairingError",
  "connectedMarker",
] as const;

export type ConnectorTarget = (typeof CONNECTOR_TARGETS)[number];

export type ConnectorSelectorPack = Record<ConnectorTarget, string[]>;

export const DEFAULT_SITE: SiteSelectors = {
  id: "chatgpt",
  version: "chatgpt-1",
  matches: ["https://chatgpt.com/*"],
  selectors: {
    composer: "#prompt-textarea, div[contenteditable='true'][role='textbox']",
    assistantTurn: "[data-message-author-role='assistant']",
    userTurn: "[data-message-author-role='user']",
    generating: "button[data-testid='stop-button'], [data-testid='composer-stop-button']",
    // A logged-out ChatGPT renders the login CTA as a data-testid button (and
    // often without the old id), so all of these must be checked — missing it
    // makes a logged-out browser look logged in, and the connector flow then
    // "succeeds" against a page that never rendered.
    loginWall:
      "#login-button, [data-testid='login-button'], button[data-testid='login-button'], a[href*='/auth/login'], [data-testid='signup-button']",
  },
  connector: {
    // Verified against a logged-in ChatGPT (2026-09): the Security settings
    // switch carries aria-label="Developer mode". A bare [role='switch'] is
    // NOT safe here — the first switch on that page is "Lockdown mode".
    developerModeToggle: [
      "button[role='switch'][aria-label='Developer mode']",
      "button[role='switch'][aria-label*='eveloper' i]",
    ],
    // One entry in the settings modal's connector list. Verified shape: a row
    // div wrapping a button whose icon is a plugin-icon-wrapper.
    connectorRow: [
      "div:has(> div > button > div [data-testid='plugin-icon-wrapper'])",
      "[data-testid='connector-row']",
      "li",
    ],
    connectorRowName: [
      "div.min-w-0 > div.truncate",
      "[data-testid='connector-name']",
      "h3",
      "h4",
      "[role='heading']",
    ],
    rowMenu: [
      // Legacy: the current ChatGPT UI has no in-row menu for custom
      // connectors (verified 2026-09). Kept so old selectors.json overrides
      // still load; the delete flow uses the plugin detail page instead.
      "button[aria-haspopup='menu']",
      "button[data-testid*='menu' i]",
      "button[aria-label*='options' i]",
      "button[aria-label*='more' i]",
    ],
    // Legacy: the detail page's "Plugin actions" kebab and its Uninstall
    // item (verified 2026-09) are NOT used by the delete flow anymore —
    // Uninstall only removes the installation and leaves the connector
    // object (and its name) behind, so a recreate 409s. Kept so old
    // selectors.json overrides still load.
    pluginActions: [
      "button[aria-label='Plugin actions']",
      "button[aria-label*='actions' i]",
      "button[aria-haspopup='menu']",
    ],
    menuDelete: [
      "[role='menuitem']:has-text('Uninstall')",
      "[role='menuitem']:has-text('Delete')",
      "[role='menuitem']:has-text('删除')",
      "[role='menuitem']:has-text('Remove')",
    ],
    confirmDelete: [
      "[role='dialog'] button:has-text('Delete')",
      "[role='alertdialog'] button:has-text('Delete')",
      "[role='dialog'] button:has-text('删除')",
      "[role='alertdialog'] button:has-text('删除')",
      "[role='dialog'] button:has-text('Confirm')",
    ],
    // The create-connector modal. Verified ids (stable, not radix-generated).
    nameField: [
      "#custom-connector-name",
      "input[name='custom-connector-name']",
      "input[aria-label='Name']",
    ],
    descriptionField: [
      "#custom-connector-description",
      "input[name='custom-connector-description']",
      "textarea[name='description']",
      "input[name='description']",
    ],
    serverUrlField: [
      "#custom-connector-url",
      "input[name='custom-connector-url']",
      "input[inputmode='url']",
      "input[name='url']",
    ],
    authSelect: [
      "#custom-connector-auth",
      "select[name='custom-connector-auth']",
      "[data-testid='modal-create-custom-connector'] select",
      "select[name='authType']",
      "select[name='authentication']",
    ],
    authOAuthOption: [
      "option[value='OAUTH']",
      "option[value='oauth']",
      "option:has-text('OAuth')",
      "[role='option']:has-text('OAuth')",
    ],
    consentCheckbox: [
      "#trust-checkbox",
      "[data-testid='trust-checkbox']",
      "input[type='checkbox']",
      "[role='checkbox']",
    ],
    createButton: [
      "[data-testid='modal-create-custom-connector'] button[type='submit']",
      "form button[type='submit']:has-text('Create')",
      "button[type='submit']:has-text('Create')",
      "button:has-text('创建')",
      "button:has-text('Add')",
    ],
    // ChatGPT may ask for confirmation when developer mode is switched on
    // ("elevated risk"). Only clicked when the toggle did not flip by itself.
    confirmToggle: [
      "[role='alertdialog'] button:has-text('Enable')",
      "[role='dialog'] button:has-text('Enable')",
      "[role='alertdialog'] button:has-text('Confirm')",
      "[role='dialog'] button:has-text('Confirm')",
      "[role='alertdialog'] button:has-text('开启')",
      "[role='dialog'] button:has-text('确认')",
    ],
    // The authorize page below is served by OUR bridge (src/auth/oauth.ts),
    // so these two are exact — no guessing. They are first in the list on
    // purpose: a false negative here is the most confusing failure mode.
    pairingCodeField: [
      "#pairing_code",
      "input[name='pairing_code']",
      "input[name='code']",
      "input[autocomplete='one-time-code']",
      "input[inputmode='numeric']",
    ],
    authorizeButton: [
      "form button[type='submit']",
      "button[type='submit']",
      "button:has-text('Connect')",
      "button:has-text('Authorize')",
      "button:has-text('授权')",
    ],
    pairingError: [
      ".error",
      "[role='alert']",
      "[data-testid*='error' i]",
    ],
    // The settings-modal detail view gates OAuth on this row: after creating
    // a connector, ChatGPT returns to the list and the authorize page only
    // appears once this button is clicked (verified 2026-09).
    connectButton: ["button:has-text('Connect')", "button:has-text('连接')"],
    // Verified 2026-09: clicking Connect opens a consent dialog ("Add <name>
    // to ChatGPT"); the authorize page opens only via its "Sign in with
    // <name>" button.
    signInButton: [
      "[role='dialog'] button:has-text('Sign in with')",
      "[role='alertdialog'] button:has-text('Sign in with')",
      "[role='dialog'] button:has-text('Sign in')",
      "[role='alertdialog'] button:has-text('Sign in')",
      "[role='dialog'] button:has-text('登录')",
    ],
    connectedMarker: [
      "[data-testid*='connected' i]",
      "[aria-label*='Connected' i]",
      ":text('Connected')",
      ":text('已连接')",
    ],
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
 *
 * A connector target override replaces that target's whole candidate list, so
 * a repair is a single known-good selector rather than a patch to a guess.
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

  const connector = { ...DEFAULT_SITE.connector };
  const connectorOverride = (raw.connector ?? {}) as Record<string, unknown>;
  for (const target of CONNECTOR_TARGETS) {
    const value = connectorOverride[target];
    if (value === undefined) continue;
    const list = Array.isArray(value) ? value : [value];
    const cleaned = list
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (cleaned.length === 0) {
      problems.push(`selectors.json 的 connector.${target} 必须是非空字符串或字符串数组，已沿用默认值`);
      continue;
    }
    connector[target] = cleaned;
  }

  const version = typeof raw.version === "string" && raw.version.trim() ? raw.version.trim() : DEFAULT_SITE.version;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : DEFAULT_SITE.id;
  return {
    site: { ...DEFAULT_SITE, id, version, selectors, connector },
    source: "override",
    problems,
  };
}

export type SelectorProbe = Record<string, { found: boolean; count: number }>;

/** Count hits for every conversation selector on a live page (doctor DOM probe). */
export async function probeSelectors(page: Page, site: SiteSelectors): Promise<SelectorProbe> {
  const probe: SelectorProbe = {};
  for (const key of SELECTOR_KEYS) {
    const count = await page.locator(site.selectors[key]).count().catch(() => 0);
    probe[key] = { found: count > 0, count };
  }
  return probe;
}

/**
 * Resolve one connector target to the first candidate selector that matches.
 * Returns the winning selector so failures can name it precisely, and so
 * `--dry-run` can show the user what actually resolved.
 */
export async function resolveConnectorTarget(
  page: Page,
  pack: ConnectorSelectorPack,
  target: ConnectorTarget
): Promise<{ selector: string; count: number } | null> {
  for (const candidate of pack[target]) {
    const count = await page.locator(candidate).count().catch(() => 0);
    if (count > 0) return { selector: candidate, count };
  }
  return null;
}

