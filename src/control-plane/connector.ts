import type { Locator, Page, Response as PlaywrightResponse } from "playwright";
import {
  loadSiteSelectors,
  resolveConnectorTarget,
  type ConnectorTarget,
  type SiteSelectors,
} from "./selectors.js";
import {
  CHATGPT_CONNECTORS_SETTINGS_URL,
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
} from "../config/endpoint.js";
import { ControlPlaneBrowser } from "./browser.js";

/**
 * Connector setup: the step that used to be "guide the user click by click".
 *
 * Why this exists — the original Codex-only design could drive ChatGPT's
 * settings UI through Codex's built-in browser, so the connector was created
 * for the user. Harnesses without a browser (opencode, zcode) had to fall
 * back to teaching the user. awehitch already ships a Playwright control
 * plane with a persistent, logged-in ChatGPT profile, so the same flow can
 * run there instead — for every harness.
 *
 * Three rules shape this module:
 *
 * 1. **Never guess a destructive action.** A row is deleted only when its
 *    title matches the connector name EXACTLY (normalized). Substring
 *    matching would let `awehitch · proj` delete `awehitch · proj2`.
 * 2. **Fail honestly and usefully.** A missing element is reported as
 *    `CONNECTOR_DOM_CHANGED` naming the exact selector key, plus a manual
 *    fallback payload — so a broken selector degrades to today's behaviour
 *    instead of leaving the user stuck.
 * 3. **Verify against real state, not the DOM.** Success is "the bridge has
 *    an authorized token", not "a badge looked green".
 *
 * ChatGPT is a SPA: after `domcontentloaded` the settings modal and the
 * create form render a few seconds later. Every navigate therefore carries a
 * `waitFor` marker (an element that only exists on the rendered page); a
 * marker that never appears is a DOM change, reported as such. The authorize
 * page is served by OUR bridge (`src/auth/oauth.ts`), so its selectors are
 * exact. `<stateDir>/control-plane/selectors.json` overrides any selector
 * without a rebuild.
 */

export const DEFAULT_CONNECTOR_DESCRIPTION =
  "Securely connect ChatGPT to the current workspace for planning and review.";

export interface ConnectorPageUrls {
  developerMode: string;
  /** The settings modal's connector list (this workspace's own connectors). */
  connectors: string;
  /** The app directory — used as the login-wall probe surface. */
  plugins: string;
  createConnector: string;
}

export const CONNECTOR_PAGE_URLS: ConnectorPageUrls = {
  developerMode: CHATGPT_DEVELOPER_MODE_URL,
  connectors: CHATGPT_CONNECTORS_SETTINGS_URL,
  plugins: CHATGPT_PLUGINS_URL,
  createConnector: CHATGPT_CREATE_CONNECTOR_URL,
};

export type ConnectorErrorCode =
  | "CONNECTOR_DOM_CHANGED"
  | "CONNECTOR_NEEDS_HUMAN"
  | "CONNECTOR_PAIRING_REJECTED"
  | "CONNECTOR_NAME_CONFLICT"
  | "CONNECTOR_FAILED";

export class ConnectorSetupError extends Error {
  constructor(
    public code: ConnectorErrorCode,
    message: string,
    public target?: ConnectorTarget
  ) {
    super(message);
    this.name = "ConnectorSetupError";
  }
}

export type ConnectorStepId = "login" | "developer-mode" | "delete" | "create" | "authorize" | "verify";

export type ConnectorStepStatus = "done" | "skipped" | "planned" | "needs-human" | "failed";

export interface ConnectorStep {
  id: ConnectorStepId;
  label: string;
  status: ConnectorStepStatus;
  detail?: string;
}

export interface ConnectorManualFallback {
  connectorName: string;
  mcpUrl: string;
  pairingCode: string;
  description: string;
  pages: ConnectorPageUrls;
  steps: string[];
}

export type ConnectorTargetProbe = Partial<
  Record<ConnectorTarget, { selector: string | null; count: number }>
>;

export interface ConnectorSetupResult {
  ok: boolean;
  dryRun: boolean;
  steps: ConnectorStep[];
  /**
   * The connector title this run actually used. Normally the requested one;
   * ChatGPT reserves dev-connector names forever (uninstalling does not free
   * them), so a conflict makes the flow retry under a bumped name — callers
   * must persist this value for stable re-runs.
   */
  connectorName?: string;
  probe?: ConnectorTargetProbe;
  /** Required targets that did not resolve. Informational for `--dry-run`. */
  unresolved?: ConnectorTarget[];
  manualFallback?: ConnectorManualFallback;
  error?: { code: ConnectorErrorCode; message: string; target?: ConnectorTarget };
}

export interface ConnectorSetupSpec {
  connectorName: string;
  mcpUrl: string;
  pairingCode: string;
  description?: string;
}

export interface ConnectorSetupContext {
  page: Page;
  site: SiteSelectors;
  urls: ConnectorPageUrls;
  /**
   * Navigate and optionally wait for a rendered-page marker. ChatGPT is a
   * SPA — without the marker the probes would race the React render.
   */
  navigate: (url: string, waitFor?: string) => Promise<void>;
  dryRun: boolean;
  loginTimeoutMs: number;
  authorizeTimeoutMs: number;
  /** How long to wait for the bridge to report an authorized token. */
  verifyTimeoutMs: number;
  /** How long to wait for the create modal to close after submitting. */
  createTimeoutMs: number;
  onNotice?: (message: string) => void;
  /** Real verification: does the bridge hold an authorized token yet? */
  verifyAuthorized?: () => Promise<boolean>;
}

/** Targets the automation cannot work without, per step. */
const STEP_TARGETS: Record<ConnectorStepId, ConnectorTarget[]> = {
  login: [],
  "developer-mode": ["developerModeToggle"],
  delete: ["connectorRow", "connectorRowName"],
  create: [
    "nameField",
    "descriptionField",
    "serverUrlField",
    "authSelect",
    "authOAuthOption",
    "consentCheckbox",
    "createButton",
  ],
  authorize: ["pairingCodeField", "authorizeButton", "pairingError"],
  verify: ["connectedMarker"],
};

/** Rendered-page markers per step, for the SPA settle wait in `navigate`. */
const STEP_MARKERS = {
  settings: "[data-testid='modal-settings']",
  createModal: "#custom-connector-name",
} as const;

const REQUIRED_TARGETS: ConnectorTarget[] = [
  "connectorRow",
  "connectorRowName",
  "connectButton",
  "signInButton",
  "nameField",
  "serverUrlField",
  "createButton",
  "pairingCodeField",
  "authorizeButton",
];

const STEP_LABELS: Record<ConnectorStepId, string> = {
  login: "Log in to ChatGPT",
  "developer-mode": "Enable developer mode",
  delete: "Delete the old connector with the same name",
  create: "Create the connector",
  authorize: "Enter the pairing code",
  verify: "Verify authorization",
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- primitives

/**
 * Normalize a connector title for exact comparison: collapse whitespace,
 * drop the zero-width characters ChatGPT inserts, case-fold. Substring
 * matching is deliberately NOT used — see rule 1 in the module doc.
 */
export function normalizeConnectorName(name: string): string {
  return name
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Next candidate title after ChatGPT rejected one as already taken: "X" →
 * "X 2", "X 2" → "X 3". ChatGPT reserves dev-connector names forever (its
 * "Uninstall" removes the installation, not the connector), so recreating a
 * repair under the old title always 409s — a fresh title is the only path.
 */
export function bumpConnectorName(name: string): string {
  const match = /^(.*) (\d+)$/.exec(name.trim());
  if (match) return `${match[1]} ${Number(match[2]) + 1}`;
  return `${name.trim()} 2`;
}

async function targetSelector(
  page: Page,
  site: SiteSelectors,
  target: ConnectorTarget
): Promise<string | null> {
  const hit = await resolveConnectorTarget(page, site.connector, target);
  return hit?.selector ?? null;
}

/** First matching element for a target, or null when nothing matches. */
async function targetLocator(
  page: Page,
  site: SiteSelectors,
  target: ConnectorTarget
): Promise<Locator | null> {
  const selector = await targetSelector(page, site, target);
  return selector ? page.locator(selector).first() : null;
}

async function requireTarget(
  page: Page,
  site: SiteSelectors,
  target: ConnectorTarget
): Promise<Locator> {
  const locator = await targetLocator(page, site, target);
  if (!locator) {
    throw new ConnectorSetupError(
      "CONNECTOR_DOM_CHANGED",
      `Could not find the element for "${target}" on the page (ChatGPT UI may have changed).` +
        `Override connector.${target} in selectors.json and retry.`,
      target
    );
  }
  return locator;
}

export function isAuthorizeUrl(url: string): boolean {
  return url.includes("/oauth/authorize");
}

/** True while ChatGPT is showing a login wall on the current page. */
export async function isLoginWallVisible(page: Page, site: SiteSelectors): Promise<boolean> {
  const url = page.url();
  if (url.includes("/auth/login") || url.includes("auth.openai.com")) return true;
  const count = await page.locator(site.selectors.loginWall).count().catch(() => 0);
  return count > 0;
}

/**
 * Wait for the user to finish logging in. Returns false on timeout — the
 * caller turns that into a `needs-human` step, never a silent skip.
 */
export async function waitForLogin(
  page: Page,
  site: SiteSelectors,
  timeoutMs: number,
  onNotice?: (message: string) => void
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let noticed = false;
  for (;;) {
    if (!(await isLoginWallVisible(page, site))) return true;
    if (!noticed) {
      onNotice?.("ChatGPT needs a login: finish signing in in the opened browser window and I will continue automatically.");
      noticed = true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(3_000);
  }
}

/** Read a toggle's state across the shapes ChatGPT uses (switch/checkbox/button). */
async function isToggleOn(locator: Locator): Promise<boolean> {
  const aria = await locator.getAttribute("aria-checked").catch(() => null);
  if (aria === "true") return true;
  if (aria === "false") return false;
  const checked = await locator.isChecked().catch(() => null);
  if (checked !== null) return checked;
  const state = await locator.getAttribute("data-state").catch(() => null);
  return state === "checked" || state === "on";
}

// ---------------------------------------------------------------- steps

/**
 * Turn on Developer mode if it is off. A missing switch is NOT reported as
 * "off": on an account that already has it enabled the page may not render
 * one, and the connector form is the real gate — it errors out if the flag
 * is required and missing.
 */
export async function ensureDeveloperMode(
  page: Page,
  site: SiteSelectors
): Promise<{ status: ConnectorStepStatus; detail: string }> {
  const toggle = await targetLocator(page, site, "developerModeToggle");
  if (!toggle) {
    return { status: "skipped", detail: "No developer-mode toggle on the page (may already be on)" };
  }
  if (await isToggleOn(toggle)) return { status: "done", detail: "Developer mode is already on" };
  await toggle.click().catch(() => undefined);
  await sleep(500);
  if (await isToggleOn(toggle)) return { status: "done", detail: "Developer mode enabled" };
  // ChatGPT may gate the switch behind a risk-confirmation dialog.
  const confirm = await targetLocator(page, site, "confirmToggle");
  if (confirm && (await confirm.isVisible().catch(() => false))) {
    await confirm.click().catch(() => undefined);
    await sleep(500);
    if (await isToggleOn(toggle)) return { status: "done", detail: "Enabled developer mode in the confirmation dialog" };
  }
  return { status: "skipped", detail: "Clicked the developer-mode toggle but could not confirm state" };
}

export interface ConnectorRowMatch {
  /** Rows whose title matches the connector name exactly. */
  rows: Locator[];
  /** Total connector rows seen on the page (0 means the list never rendered). */
  totalRows: number;
  /** More than one exact match — refuse to act rather than guess. */
  ambiguous: boolean;
}

/** Find the connector row(s) whose title equals `connectorName` exactly. */
export async function findConnectorRows(
  page: Page,
  site: SiteSelectors,
  connectorName: string
): Promise<ConnectorRowMatch> {
  const rowSelector = await targetSelector(page, site, "connectorRow");
  const nameSelector = await targetSelector(page, site, "connectorRowName");
  if (!rowSelector || !nameSelector) return { rows: [], totalRows: 0, ambiguous: false };

  const rows = page.locator(rowSelector);
  const totalRows = await rows.count().catch(() => 0);
  const wanted = normalizeConnectorName(connectorName);
  const matches: Locator[] = [];
  for (let index = 0; index < totalRows; index++) {
    const row = rows.nth(index);
    const name = row.locator(nameSelector).first();
    if ((await name.count().catch(() => 0)) === 0) continue;
    const text = ((await name.innerText().catch(() => "")) ?? "").trim();
    if (normalizeConnectorName(text) === wanted) matches.push(row);
  }
  return { rows: matches, totalRows, ambiguous: matches.length > 1 };
}

/** Count rows the current connectorRow selector can see right now. */
async function rowCount(page: Page, site: SiteSelectors): Promise<number> {
  const rowSelector = await targetSelector(page, site, "connectorRow");
  return rowSelector ? page.locator(rowSelector).count().catch(() => 0) : 0;
}

/**
 * The settings modal can render a second or two before its list fills in.
 * Wait briefly for the first row; returning 0 means the list really did not
 * render (or the row selector broke) — the caller reports that honestly.
 */
async function waitForConnectorRows(
  page: Page,
  site: SiteSelectors,
  timeoutMs = 6_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await rowCount(page, site)) > 0) return;
    if (Date.now() >= deadline) return;
    await sleep(500);
  }
}

/**
 * List THIS account's dev connectors that carry EXACTLY this title
 * (normalized), returning their connector ids. Runs inside the logged-in
 * page so the session cookie authenticates the call.
 *
 * Why the backend API and not the settings UI: ChatGPT's "Uninstall" only
 * removes the installation — the dev connector object stays behind and keeps
 * the name reserved, so a recreate then fails with a silent 409 ("Connector
 * with name '…' already exists"; the UI shows nothing). DELETE on the
 * connector object is the only verified way to free the name.
 */
async function findConnectorBackendIds(page: Page, connectorName: string): Promise<string[]> {
  return page.evaluate(async (wanted) => {
    const normalize = (value?: string): string =>
      (value ?? "")
        .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const session = await fetch("/api/auth/session").then((r) => r.json()).catch(() => null);
    const headers: Record<string, string> = { accept: "application/json" };
    if (session?.accessToken) headers.authorization = `Bearer ${session.accessToken}`;
    const response = await fetch("/backend-api/ps/plugins/list?scope=USER&limit=50", { headers });
    if (!response.ok) throw new Error(`plugins/list returned HTTP ${response.status}`);
    const data = (await response.json()) as {
      plugins?: { connector_id?: string; canonical_app_id?: string; id?: string; release?: { display_name?: string } }[];
    };
    return (data.plugins ?? [])
      .filter((p) => normalize(p.release?.display_name) === normalize(wanted))
      .map((p) => p.connector_id ?? p.canonical_app_id ?? p.id ?? "")
      .filter((id) => id !== "");
  }, connectorName);
}

/**
 * Delete THIS workspace's connector, if present, by exact title.
 * Never clicks "Reconnect": when the tunnel address changes the old URL is
 * dead and that page hangs on "This site cannot be reached", which reads to
 * the user as a broken tool.
 *
 * Runs entirely against the backend (see findConnectorBackendIds for why):
 * exact-name match on the server's own display_name, refuse duplicates, then
 * DELETE and confirm with a fresh list. The page must be on chatgpt.com so
 * the session cookie is sent.
 */
export async function deleteConnectorByName(
  page: Page,
  connectorName: string
): Promise<{ status: ConnectorStepStatus; detail: string }> {
  const ids = await findConnectorBackendIds(page, connectorName).catch((error: unknown) => {
    throw new ConnectorSetupError(
      "CONNECTOR_FAILED",
      `Failed to query the connector list: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  if (ids.length === 0) {
    return { status: "skipped", detail: `No connector named "${connectorName}" to delete` };
  }
  if (ids.length > 1) {
    throw new ConnectorSetupError(
      "CONNECTOR_FAILED",
      `Found ${ids.length} connectors titled exactly "${connectorName}". Stopped to avoid deleting another project's connector; clean them up manually.`
    );
  }

  const deleted = await page.evaluate(async (id) => {
    const session = await fetch("/api/auth/session").then((r) => r.json()).catch(() => null);
    const headers: Record<string, string> = { accept: "application/json" };
    if (session?.accessToken) headers.authorization = `Bearer ${session.accessToken}`;
    const response = await fetch(`/backend-api/aip/connectors/${id}`, {
      method: "DELETE",
      headers,
    });
    return { ok: response.ok, status: response.status };
  }, ids[0]);
  if (!deleted.ok) {
    return {
      status: "failed",
      detail: `Delete request for "${connectorName}" was rejected (HTTP ${deleted.status}); clean up manually and retry`,
    };
  }

  // Confirm with a fresh list; deletion can take a moment to propagate.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const remaining = await findConnectorBackendIds(page, connectorName).catch(() => ids);
    if (remaining.length === 0) {
      return { status: "done", detail: `Deleted "${connectorName}"` };
    }
    if (Date.now() >= deadline) {
      return { status: "failed", detail: `"${connectorName}" is still present; the delete may not have taken effect` };
    }
    await sleep(1_000);
  }
}

async function fillField(locator: Locator, value: string): Promise<void> {
  await locator.click({ timeout: 10_000 });
  await locator.fill("").catch(() => undefined);
  await locator.fill(value);
}

/** Set Authentication to OAuth, whether it is a native <select> or a custom menu. */
async function selectOAuth(page: Page, site: SiteSelectors): Promise<string> {
  const control = await targetLocator(page, site, "authSelect");
  if (!control) return "No authentication control found; continuing with the default";
  const tag = await control.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
  if (tag === "select") {
    const option = await targetLocator(page, site, "authOAuthOption");
    const value = option ? await option.getAttribute("value").catch(() => null) : null;
    try {
      if (value) await control.selectOption(value);
      else await control.selectOption({ label: "OAuth" });
      return "Authentication set to OAuth";
    } catch {
      return "Authentication dropdown has no OAuth option; continuing with the default";
    }
  }
  await control.click().catch(() => undefined);
  await sleep(400);
  const option = await targetLocator(page, site, "authOAuthOption");
  if (!option) return "Authentication control opened but no OAuth option was found";
  await option.click();
  return "Authentication set to OAuth";
}

/** Fill and submit the create-connector form, then verify it took effect. */
export async function fillConnectorForm(
  page: Page,
  site: SiteSelectors,
  spec: { connectorName: string; mcpUrl: string; description: string },
  createTimeoutMs = 45_000
): Promise<{ status: ConnectorStepStatus; detail: string }> {
  await fillField(await requireTarget(page, site, "nameField"), spec.connectorName);

  const description = await targetLocator(page, site, "descriptionField");
  if (description) await fillField(description, spec.description);

  await fillField(await requireTarget(page, site, "serverUrlField"), spec.mcpUrl);

  const authDetail = await selectOAuth(page, site);

  // Some layouts gate submit behind a consent checkbox.
  const consent = await targetLocator(page, site, "consentCheckbox");
  if (consent) {
    const alreadyChecked = await consent.isChecked().catch(() => true);
    if (!alreadyChecked) await consent.check().catch(() => consent.click().catch(() => undefined));
  }

  // The create POST's status is the only reliable verdict: a 409 ("name
  // already exists") can close the modal with no row created, and a silent
  // dead click once looked "done" and cost 60s of confusion (run-2 lesson).
  const conflictRef: { current: { status: number; message: string } | null } = { current: null };
  let resolveVerdict!: () => void;
  const verdictSeen = new Promise<void>((resolve) => {
    resolveVerdict = resolve;
  });
  const watchCreateResponses = (response: PlaywrightResponse): void => {
    if (!response.url().includes("/backend-api/aip/connectors/mcp")) return;
    if (response.status() >= 200 && response.status() < 300) {
      resolveVerdict();
      return;
    }
    conflictRef.current = { status: response.status(), message: "" };
    void response
      .text()
      .then((body) => {
        const conflict = conflictRef.current;
        if (conflict && !conflict.message) {
          try {
            conflict.message = (JSON.parse(body)?.detail?.message ?? body).slice(0, 200);
          } catch {
            conflict.message = body.slice(0, 200);
          }
        }
      })
      .catch(() => undefined)
      .finally(() => resolveVerdict());
  };
  page.on("response", watchCreateResponses);

  try {
    const createDeadline = Date.now() + createTimeoutMs;
    await (await requireTarget(page, site, "createButton")).click();
    // The modal can vanish mid-navigation before the POST response arrives,
    // so never decide before the verdict lands (or the timeout fires).
    await Promise.race([verdictSeen, sleep(createTimeoutMs)]);

    // Creation is server-side validated and slow (~15s observed); the modal
    // stays open until it finishes.
    while ((await page.locator("#custom-connector-name").count().catch(() => 0)) > 0) {
      if (Date.now() >= createDeadline) {
        const alert = page
          .locator("[data-testid='modal-create-custom-connector'] [role='alert']")
          .first();
        const alertText =
          (await alert.count().catch(() => 0)) > 0
            ? ((await alert.innerText().catch(() => "")) ?? "").trim()
            : "";
        throw new ConnectorSetupError(
          "CONNECTOR_FAILED",
          alertText
            ? `Connector form submitted but not created; page error: ${alertText}`
            : "The create dialog stayed open after submit, so the connector was not created. Check the page error (often: ChatGPT cannot reach the server URL) and retry."
        );
      }
      await sleep(500);
    }
  } finally {
    page.off("response", watchCreateResponses);
  }

  const conflict = conflictRef.current;
  if (conflict) {
    throw new ConnectorSetupError(
      "CONNECTOR_NAME_CONFLICT",
      `ChatGPT rejected the create (HTTP ${conflict.status}): ${conflict.message || "name already taken"}`
    );
  }

  return { status: "done", detail: `Submitted "${spec.connectorName}" · ${authDetail}` };
}

/**
 * Trigger the OAuth authorize page after creation. Verified ChatGPT route
 * (2026-09): submitting the create form returns to the connector list;
 * opening the connector's settings detail shows a "Connect" row, and clicking
 * it opens a consent dialog whose "Sign in with <name>" button is what
 * actually navigates to the authorize page.
 */
async function openConnectorAndConnect(
  ctx: ConnectorSetupContext,
  connectorName: string
): Promise<void> {
  await ctx.navigate(ctx.urls.connectors, STEP_MARKERS.settings);
  await waitForConnectorRows(ctx.page, ctx.site);
  // The freshly created connector can take a while to show up in the list
  // (server-side propagation + SPA cache); poll with fresh navigations.
  const rowDeadline = Date.now() + 30_000;
  let match = await findConnectorRows(ctx.page, ctx.site, connectorName);
  while (match.rows.length === 0 && Date.now() < rowDeadline) {
    await sleep(2_500);
    await ctx.navigate(ctx.urls.connectors, STEP_MARKERS.settings).catch(() => undefined);
    match = await findConnectorRows(ctx.page, ctx.site, connectorName);
  }
  if (match.rows.length === 0) {
    // The create modal closed, yet the connector is not in the list: the
    // submit died silently. Fail here instead of burning the authorize wait.
    throw new ConnectorSetupError(
      "CONNECTOR_FAILED",
      "Connector create did not take effect: \"" + connectorName + "\" is missing from the list. Retry; if it keeps failing, create it manually."
    );
  }
  if (match.ambiguous) {
    throw new ConnectorSetupError(
      "CONNECTOR_DOM_CHANGED",
      `Found ${match.rows.length} connectors titled exactly "${connectorName}". Clean them up manually and retry.`,
      "connectorRowName"
    );
  }
  await match.rows[0].locator("button").first().click().catch(() => undefined);
  await sleep(1_500);

  const connect = await targetLocator(ctx.page, ctx.site, "connectButton");
  if (connect && (await connect.count().catch(() => 0)) > 0) {
    await connect.click().catch(() => undefined);
    await sleep(1_200);
  }
  // The consent dialog ("Add <name> to ChatGPT") carries the real trigger.
  const signIn = await targetLocator(ctx.page, ctx.site, "signInButton");
  if (signIn && (await signIn.count().catch(() => 0)) > 0) {
    await signIn.click().catch(() => undefined);
  }
}

/**
 * Wait for the authorize page. It may open in the same tab or a popup, so
 * both are checked. Returns null when one never appears.
 *
 * `alreadyAuthorized` short-circuits the wait using real state: ChatGPT may
 * have granted access without ever prompting for a pairing code (an existing
 * grant). Without it every such run would sit here for the whole timeout.
 */
export async function waitForAuthorizePage(
  page: Page,
  timeoutMs: number,
  alreadyAuthorized?: () => Promise<boolean>
): Promise<Page | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isAuthorizeUrl(page.url())) return page;
    for (const candidate of page.context().pages()) {
      if (isAuthorizeUrl(candidate.url())) return candidate;
    }
    if (alreadyAuthorized && (await alreadyAuthorized().catch(() => false))) return null;
    if (Date.now() >= deadline) return null;
    await sleep(500);
  }
}

/** The authorize page's inline error text, or null when there is none. */
export async function readPairingError(page: Page, site: SiteSelectors): Promise<string | null> {
  const el = await targetLocator(page, site, "pairingError");
  if (!el) return null;
  const text = ((await el.innerText().catch(() => "")) ?? "").trim();
  return text || null;
}

/**
 * Type the pairing code on our own authorize page and submit.
 *
 * This page is ours, so the outcome is unambiguous: success redirects away
 * from `/oauth/authorize`, failure re-renders with an error message.
 */
export async function submitPairingCode(
  page: Page,
  site: SiteSelectors,
  code: string,
  timeoutMs: number
): Promise<{ status: ConnectorStepStatus; detail: string }> {
  const field = await requireTarget(page, site, "pairingCodeField");
  await field.fill("");
  await field.fill(code);
  await (await requireTarget(page, site, "authorizeButton")).click();

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAuthorizeUrl(page.url())) return { status: "done", detail: "Pairing code accepted; ChatGPT is authorized" };
    const error = await readPairingError(page, site);
    if (error) return { status: "failed", detail: error };
    if (Date.now() >= deadline) {
      return { status: "failed", detail: "The authorize page did not change after submitting the pairing code" };
    }
    await sleep(500);
  }
}

// ---------------------------------------------------------------- flow

function manualSteps(
  connectorName: string,
  spec: ConnectorSetupSpec,
  urls: ConnectorPageUrls,
  description: string
): string[] {
  return [
    `Open ${urls.developerMode} and confirm Developer mode is on.`,
    `Open ${urls.connectors}. If a connector named "${connectorName}" already exists, delete it (do not click Reconnect).`,
    `Open ${urls.createConnector} and create a connector: name "${connectorName}", description "${description}", server URL "${spec.mcpUrl}", authentication OAuth.`,
    `After clicking Create, enter the pairing code on the authorize page: ${spec.pairingCode}`,
  ];
}

/**
 * Run the whole connector setup against an already-open page.
 *
 * Split out from browser launching so it can be driven by an offline fixture
 * in tests, and so a caller that already has a page can reuse it.
 */
export async function runConnectorSetupFlow(
  ctx: ConnectorSetupContext,
  spec: ConnectorSetupSpec
): Promise<ConnectorSetupResult> {
  const description = spec.description ?? DEFAULT_CONNECTOR_DESCRIPTION;
  const steps: ConnectorStep[] = [];
  const probe: ConnectorTargetProbe = {};
  const probeTargets = new Set<ConnectorTarget>();
  // The title this run actually creates under. ChatGPT reserves dev-connector
  // names forever, so a 409 makes create retry under a bumped title — every
  // later step (authorize lookup, manual fallback) must follow it.
  let currentName = spec.connectorName;

  const fallback = (): ConnectorManualFallback => ({
    connectorName: currentName,
    mcpUrl: spec.mcpUrl,
    pairingCode: spec.pairingCode,
    description,
    pages: ctx.urls,
    steps: manualSteps(currentName, spec, ctx.urls, description),
  });

  const dryProbe = async (stepId: ConnectorStepId): Promise<void> => {
    for (const target of STEP_TARGETS[stepId]) {
      probeTargets.add(target);
      const hit = await resolveConnectorTarget(ctx.page, ctx.site.connector, target);
      probe[target] = hit ? { selector: hit.selector, count: hit.count } : { selector: null, count: 0 };
    }
  };

  const failed = (stepId: ConnectorStepId, error: unknown): ConnectorSetupResult => {
    const connectorError =
      error instanceof ConnectorSetupError
        ? error
        : new ConnectorSetupError("CONNECTOR_FAILED", (error as Error)?.message ?? String(error));
    const status: ConnectorStepStatus =
      connectorError.code === "CONNECTOR_NEEDS_HUMAN" ? "needs-human" : "failed";
    steps.push({ id: stepId, label: STEP_LABELS[stepId], status, detail: connectorError.message });
    return {
      ok: false,
      dryRun: ctx.dryRun,
      steps,
      probe: ctx.dryRun ? probe : undefined,
      manualFallback: fallback(),
      error: {
        code: connectorError.code,
        message: connectorError.message,
        target: connectorError.target,
      },
    };
  };

  // 1. Login ---------------------------------------------------------------
  try {
    await ctx.navigate(ctx.urls.plugins);
    if (await isLoginWallVisible(ctx.page, ctx.site)) {
      if (ctx.dryRun) {
        throw new ConnectorSetupError(
          "CONNECTOR_NEEDS_HUMAN",
          "The control-plane browser is not logged in to ChatGPT. Run `awehitch login` first, then dry-run to inspect the page."
        );
      }
      const loggedIn = await waitForLogin(ctx.page, ctx.site, ctx.loginTimeoutMs, ctx.onNotice);
      if (!loggedIn) {
        throw new ConnectorSetupError(
          "CONNECTOR_NEEDS_HUMAN",
          "Timed out waiting for the ChatGPT login. Run `awehitch login` first, then retry."
        );
      }
      await ctx.navigate(ctx.urls.plugins);
    }
    steps.push({ id: "login", label: STEP_LABELS.login, status: "done" });
  } catch (error) {
    return failed("login", error);
  }

  // 2. Developer mode ------------------------------------------------------
  try {
    await ctx.navigate(ctx.urls.developerMode, STEP_MARKERS.settings);
    if (ctx.dryRun) {
      await dryProbe("developer-mode");
      steps.push({ id: "developer-mode", label: STEP_LABELS["developer-mode"], status: "planned" });
    } else {
      const result = await ensureDeveloperMode(ctx.page, ctx.site);
      steps.push({
        id: "developer-mode",
        label: STEP_LABELS["developer-mode"],
        status: result.status,
        detail: result.detail,
      });
    }
  } catch (error) {
    return failed("developer-mode", error);
  }

  // 3. Delete a stale connector with the same title ------------------------
  try {
    if (ctx.dryRun) {
      await ctx.navigate(ctx.urls.connectors, STEP_MARKERS.settings);
      await waitForConnectorRows(ctx.page, ctx.site);
      await dryProbe("delete");
      const match = await findConnectorRows(ctx.page, ctx.site, spec.connectorName);
      steps.push({
        id: "delete",
        label: STEP_LABELS.delete,
        status: "planned",
        detail: `${match.totalRows} connectors on the page; ${match.rows.length} share this project's name`,
      });
    } else {
      // Backend-driven (no UI): the settings Uninstall only removes the
      // installation and leaves the connector object — and its name — behind,
      // which would 409 the recreate below.
      const result = await deleteConnectorByName(ctx.page, spec.connectorName);
      if (result.status === "failed") {
        steps.push({ id: "delete", label: STEP_LABELS.delete, status: "failed", detail: result.detail });
        return {
          ok: false,
          dryRun: false,
          steps,
          manualFallback: fallback(),
          error: { code: "CONNECTOR_FAILED", message: result.detail },
        };
      }
      steps.push({
        id: "delete",
        label: STEP_LABELS.delete,
        status: result.status,
        detail: result.detail,
      });
    }
  } catch (error) {
    return failed("delete", error);
  }

  // 4. Create --------------------------------------------------------------
  try {
    await ctx.navigate(ctx.urls.createConnector, STEP_MARKERS.createModal);
    if (ctx.dryRun) {
      await dryProbe("create");
      steps.push({ id: "create", label: STEP_LABELS.create, status: "planned", detail: "dry-run did not submit the form" });
    } else {
      // ChatGPT reserves dev-connector names forever, so a stale name can
      // 409 even after the old connector is gone from every UI surface.
      // Retry under a bumped title before giving up.
      let result: { status: ConnectorStepStatus; detail: string } | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await fillConnectorForm(
            ctx.page,
            ctx.site,
            {
              connectorName: currentName,
              mcpUrl: spec.mcpUrl,
              description,
            },
            ctx.createTimeoutMs
          );
          break;
        } catch (error) {
          const isConflict =
            error instanceof ConnectorSetupError && error.code === "CONNECTOR_NAME_CONFLICT";
          if (!isConflict || attempt === 3) throw error;
          const next = bumpConnectorName(currentName);
          ctx.onNotice?.(
            `Connector name "${currentName}" is taken by ChatGPT; retrying as "${next}".`
          );
          currentName = next;
          await ctx.navigate(ctx.urls.createConnector, STEP_MARKERS.createModal);
        }
      }
      steps.push({
        id: "create",
        label: STEP_LABELS.create,
        status: result!.status,
        detail: result!.detail,
      });
    }
  } catch (error) {
    return failed("create", error);
  }

  // 5. Pairing code on our own authorize page ------------------------------
  try {
    if (ctx.dryRun) {
      // The authorize page only exists after a real submit, so its elements
      // cannot be probed here. Probing them on the create page would report
      // a false "not found", which is worse than saying so.
      steps.push({
        id: "authorize",
        label: STEP_LABELS.authorize,
        status: "planned",
        detail: "dry-run did not submit the form, so the authorize page never appears and cannot be probed here",
      });
    } else {
      // An existing grant can skip the prompt entirely; check real state
      // before driving the UI. Otherwise the authorize page only shows up
      // after opening the connector and clicking Connect (see run 1's
      // lesson: waiting passively times out — ChatGPT never opens it).
      if (ctx.verifyAuthorized && (await ctx.verifyAuthorized().catch(() => false))) {
        steps.push({
          id: "authorize",
          label: STEP_LABELS.authorize,
          status: "skipped",
          detail: "ChatGPT is already authorized; no pairing code needed",
        });
      } else {
        await openConnectorAndConnect(ctx, currentName);
        const authorizePage = await waitForAuthorizePage(
          ctx.page,
          ctx.authorizeTimeoutMs,
          ctx.verifyAuthorized
        );
        if (!authorizePage) {
          // No authorize page: either ChatGPT authorized without a prompt
          // (already granted) or the form never submitted. Real state decides.
          if (ctx.verifyAuthorized && (await ctx.verifyAuthorized())) {
            steps.push({
              id: "authorize",
              label: STEP_LABELS.authorize,
              status: "skipped",
              detail: "ChatGPT is already authorized; no pairing code needed",
            });
          } else {
            throw new ConnectorSetupError(
              "CONNECTOR_DOM_CHANGED",
              "No authorize page after clicking Connect; the connector may not have been created. Check the page error or enter the pairing code manually."
            );
          }
        } else {
          const result = await submitPairingCode(
            authorizePage,
            ctx.site,
            spec.pairingCode,
            ctx.authorizeTimeoutMs
          );
          if (result.status !== "done") {
            steps.push({
              id: "authorize",
              label: STEP_LABELS.authorize,
              status: "failed",
              detail: result.detail,
            });
            return {
              ok: false,
              dryRun: false,
              steps,
              manualFallback: fallback(),
              error: { code: "CONNECTOR_PAIRING_REJECTED", message: result.detail },
            };
          }
          steps.push({
            id: "authorize",
            label: STEP_LABELS.authorize,
            status: "done",
            detail: result.detail,
          });
        }
      }
    }
  } catch (error) {
    return failed("authorize", error);
  }

  // 6. Verify against the bridge, not the DOM ------------------------------
  try {
    if (ctx.dryRun) {
      // Only targets actually probed can be reported as unresolved — the
      // authorize page was never reached, so it must not count as a miss.
      const unresolved = REQUIRED_TARGETS.filter(
        (target) => target in probe && probe[target]?.selector === null
      );
      steps.push({
        id: "verify",
        label: STEP_LABELS.verify,
        status: "planned",
        detail: unresolved.length === 0 ? "All required elements resolved" : `Unresolved: ${unresolved.join(", ")}`,
      });
      return { ok: true, dryRun: true, steps, connectorName: currentName, probe, unresolved };
    }
    if (ctx.verifyAuthorized) {
      const deadline = Date.now() + ctx.verifyTimeoutMs;
      let authorized = false;
      for (;;) {
        authorized = await ctx.verifyAuthorized().catch(() => false);
        if (authorized || Date.now() >= deadline) break;
        await sleep(1_500);
      }
      if (!authorized) {
        steps.push({
          id: "verify",
          label: STEP_LABELS.verify,
          status: "failed",
          detail: "ChatGPT has not received an authorization token yet",
        });
        return {
          ok: false,
          dryRun: false,
          steps,
          manualFallback: fallback(),
          error: { code: "CONNECTOR_FAILED", message: "Authorization did not finish; the bridge has no new token." },
        };
      }
      steps.push({
        id: "verify",
        label: STEP_LABELS.verify,
        status: "done",
        detail: "Bridge received the authorization token",
      });
    } else {
      steps.push({
        id: "verify",
        label: STEP_LABELS.verify,
        status: "skipped",
        detail: "No authorization-status check provided; skipped",
      });
    }
  } catch (error) {
    return failed("verify", error);
  }

  const ok = steps.every((step) => step.status === "done" || step.status === "skipped");
  return { ok, dryRun: false, steps, connectorName: currentName, manualFallback: ok ? undefined : fallback() };
}

export interface RunConnectorSetupOptions extends ConnectorSetupSpec {
  workspaceId: string;
  dryRun: boolean;
  loginTimeoutMs?: number;
  authorizeTimeoutMs?: number;
  verifyTimeoutMs?: number;
  /** How long to wait for the create modal to close after submitting. */
  createTimeoutMs?: number;
  site?: SiteSelectors;
  onNotice?: (message: string) => void;
  verifyAuthorized?: () => Promise<boolean>;
}

/**
 * Launch the control-plane browser (the persistent, already-logged-in
 * profile) and run the connector setup against it.
 */
export async function runConnectorSetup(opts: RunConnectorSetupOptions): Promise<ConnectorSetupResult> {
  const site = opts.site ?? loadSiteSelectors().site;
  const driver = new ControlPlaneBrowser(opts.workspaceId, { onNotice: opts.onNotice });
  try {
    const page = await driver.currentPage();
    return await runConnectorSetupFlow(
      {
        page,
        site,
        urls: CONNECTOR_PAGE_URLS,
        navigate: async (url, waitFor) => {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          if (!waitFor) return;
          try {
            await page.waitForSelector(waitFor, { state: "visible", timeout: 20_000 });
          } catch {
            throw new ConnectorSetupError(
              "CONNECTOR_DOM_CHANGED",
              `"${waitFor}" did not appear on ${url} after render; ChatGPT UI may have changed.`
            );
          }
        },
        dryRun: opts.dryRun,
        loginTimeoutMs: opts.loginTimeoutMs ?? 5 * 60_000,
        authorizeTimeoutMs: opts.authorizeTimeoutMs ?? 60_000,
        verifyTimeoutMs: opts.verifyTimeoutMs ?? 30_000,
        createTimeoutMs: opts.createTimeoutMs ?? 45_000,
        onNotice: opts.onNotice,
        verifyAuthorized: opts.verifyAuthorized,
      },
      opts
    );
  } finally {
    await driver.close().catch(() => undefined);
  }
}
