import type { Locator, Page } from "playwright";
import {
  loadSiteSelectors,
  resolveConnectorTarget,
  type ConnectorTarget,
  type SiteSelectors,
} from "./selectors.js";
import {
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
 * The authorize page is served by OUR bridge (`src/auth/oauth.ts`), so its
 * selectors are exact. The ChatGPT-side form has no stable test ids across
 * locales — `--dry-run` resolves every target and reports what matched, and
 * `<stateDir>/control-plane/selectors.json` overrides any of them without a
 * rebuild.
 */

export const DEFAULT_CONNECTOR_DESCRIPTION =
  "Securely connect ChatGPT to the current workspace for planning and review.";

export interface ConnectorPageUrls {
  developerMode: string;
  plugins: string;
  createConnector: string;
}

export const CONNECTOR_PAGE_URLS: ConnectorPageUrls = {
  developerMode: CHATGPT_DEVELOPER_MODE_URL,
  plugins: CHATGPT_PLUGINS_URL,
  createConnector: CHATGPT_CREATE_CONNECTOR_URL,
};

export type ConnectorErrorCode =
  | "CONNECTOR_DOM_CHANGED"
  | "CONNECTOR_NEEDS_HUMAN"
  | "CONNECTOR_PAIRING_REJECTED"
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
  navigate: (url: string) => Promise<void>;
  dryRun: boolean;
  loginTimeoutMs: number;
  authorizeTimeoutMs: number;
  /** How long to wait for the bridge to report an authorized token. */
  verifyTimeoutMs: number;
  onNotice?: (message: string) => void;
  /** Real verification: does the bridge hold an authorized token yet? */
  verifyAuthorized?: () => Promise<boolean>;
}

/** Targets the automation cannot work without, per step. */
const STEP_TARGETS: Record<ConnectorStepId, ConnectorTarget[]> = {
  login: [],
  "developer-mode": ["developerModeToggle"],
  delete: ["connectorRow", "connectorRowName", "rowMenu", "menuDelete", "confirmDelete"],
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

const REQUIRED_TARGETS: ConnectorTarget[] = [
  "connectorRow",
  "connectorRowName",
  "menuDelete",
  "nameField",
  "serverUrlField",
  "createButton",
  "pairingCodeField",
  "authorizeButton",
];

const STEP_LABELS: Record<ConnectorStepId, string> = {
  login: "登录 ChatGPT",
  "developer-mode": "开发人员模式",
  delete: "删除同名旧连接器",
  create: "创建连接器",
  authorize: "输入配对码",
  verify: "验证授权",
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
      `页面上找不到「${target}」对应的元素（ChatGPT 界面可能已改版）。` +
        `可在 selectors.json 里覆盖 connector.${target} 后重试。`,
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
      onNotice?.("ChatGPT 需要登录：请在弹出的浏览器窗口里完成登录，我会自动继续。");
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
    return { status: "skipped", detail: "页面上没有开发人员模式开关（可能已开启）" };
  }
  if (await isToggleOn(toggle)) return { status: "done", detail: "开发人员模式已开启" };
  await toggle.click().catch(() => undefined);
  await sleep(500);
  if (await isToggleOn(toggle)) return { status: "done", detail: "已开启开发人员模式" };
  return { status: "skipped", detail: "已点击开发人员模式开关，但未能确认状态" };
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

/**
 * Delete THIS workspace's connector, if present. Never clicks "Reconnect":
 * when the tunnel address changes the old URL is dead and that page hangs on
 * "This site cannot be reached", which reads to the user as a broken tool.
 */
export async function deleteConnectorByName(
  page: Page,
  site: SiteSelectors,
  connectorName: string
): Promise<{ status: ConnectorStepStatus; detail: string }> {
  const match = await findConnectorRows(page, site, connectorName);
  if (match.totalRows === 0) {
    throw new ConnectorSetupError(
      "CONNECTOR_DOM_CHANGED",
      "连接器列表里一个条目都没有找到，可能页面还没加载完或界面已改版。",
      "connectorRow"
    );
  }
  if (match.rows.length === 0) {
    return { status: "skipped", detail: `没有名为「${connectorName}」的连接器，无需删除` };
  }
  if (match.ambiguous) {
    throw new ConnectorSetupError(
      "CONNECTOR_DOM_CHANGED",
      `发现 ${match.rows.length} 个标题完全相同的「${connectorName}」连接器，为避免误删其它项目的连接已停止操作，请手动清理。`,
      "connectorRowName"
    );
  }

  const row = match.rows[0];
  const rowMenuSelector = await targetSelector(page, site, "rowMenu");
  if (rowMenuSelector) {
    const menu = row.locator(rowMenuSelector).first();
    if ((await menu.count().catch(() => 0)) > 0) {
      await menu.click().catch(() => undefined);
      await sleep(400);
    }
  }

  const deleteSelector = await targetSelector(page, site, "menuDelete");
  if (!deleteSelector) {
    throw new ConnectorSetupError(
      "CONNECTOR_DOM_CHANGED",
      "找不到删除连接器的入口。可在 selectors.json 里覆盖 connector.menuDelete 后重试。",
      "menuDelete"
    );
  }
  // Prefer the entry inside this row; fall back to a page-level menu item
  // (some layouts render the menu in a portal outside the row).
  const scoped = row.locator(deleteSelector).first();
  const item = (await scoped.count().catch(() => 0)) > 0 ? scoped : page.locator(deleteSelector).first();
  if ((await item.count().catch(() => 0)) === 0) {
    throw new ConnectorSetupError(
      "CONNECTOR_DOM_CHANGED",
      "菜单打开了但没看到「删除」项。可在 selectors.json 里覆盖 connector.menuDelete 后重试。",
      "menuDelete"
    );
  }
  await item.click();
  await sleep(400);

  const confirm = await targetLocator(page, site, "confirmDelete");
  if (confirm) {
    await confirm.click().catch(() => undefined);
    await sleep(600);
  }

  const after = await findConnectorRows(page, site, connectorName);
  if (after.rows.length > 0) {
    return { status: "failed", detail: `「${connectorName}」仍然存在，删除可能没有生效` };
  }
  return { status: "done", detail: `已删除「${connectorName}」` };
}

async function fillField(locator: Locator, value: string): Promise<void> {
  await locator.click({ timeout: 10_000 });
  await locator.fill("").catch(() => undefined);
  await locator.fill(value);
}

/** Set Authentication to OAuth, whether it is a native <select> or a custom menu. */
async function selectOAuth(page: Page, site: SiteSelectors): Promise<string> {
  const control = await targetLocator(page, site, "authSelect");
  if (!control) return "未找到身份验证选项，按默认值继续";
  const tag = await control.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
  if (tag === "select") {
    const option = await targetLocator(page, site, "authOAuthOption");
    const value = option ? await option.getAttribute("value").catch(() => null) : null;
    try {
      if (value) await control.selectOption(value);
      else await control.selectOption({ label: "OAuth" });
      return "身份验证已设为 OAuth";
    } catch {
      return "身份验证下拉里没有 OAuth 选项，按默认值继续";
    }
  }
  await control.click().catch(() => undefined);
  await sleep(400);
  const option = await targetLocator(page, site, "authOAuthOption");
  if (!option) return "身份验证控件已打开，但没找到 OAuth 选项";
  await option.click();
  return "身份验证已设为 OAuth";
}

/** Fill and submit the create-connector form. */
export async function fillConnectorForm(
  page: Page,
  site: SiteSelectors,
  spec: { connectorName: string; mcpUrl: string; description: string }
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

  await (await requireTarget(page, site, "createButton")).click();
  return { status: "done", detail: `已提交「${spec.connectorName}」· ${authDetail}` };
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
    if (!isAuthorizeUrl(page.url())) return { status: "done", detail: "配对码已通过，ChatGPT 已获得授权" };
    const error = await readPairingError(page, site);
    if (error) return { status: "failed", detail: error };
    if (Date.now() >= deadline) {
      return { status: "failed", detail: "提交配对码后授权页没有变化" };
    }
    await sleep(500);
  }
}

// ---------------------------------------------------------------- flow

function manualSteps(spec: ConnectorSetupSpec, urls: ConnectorPageUrls, description: string): string[] {
  return [
    `打开 ${urls.developerMode} ，确认「开发人员模式」已开启。`,
    `打开 ${urls.plugins} 。若已有名为「${spec.connectorName}」的连接器，删除它（不要点「重新连接」）。`,
    `打开 ${urls.createConnector} ，新建连接器：名称「${spec.connectorName}」、描述「${description}」、服务器 URL「${spec.mcpUrl}」、身份验证选 OAuth。`,
    `点「创建」后，在授权页输入配对码：${spec.pairingCode}`,
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

  const fallback = (): ConnectorManualFallback => ({
    connectorName: spec.connectorName,
    mcpUrl: spec.mcpUrl,
    pairingCode: spec.pairingCode,
    description,
    pages: ctx.urls,
    steps: manualSteps(spec, ctx.urls, description),
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
          "控制面浏览器当前未登录 ChatGPT。先运行 awehitch login，再跑 dry-run 才能看到页面结构。"
        );
      }
      const loggedIn = await waitForLogin(ctx.page, ctx.site, ctx.loginTimeoutMs, ctx.onNotice);
      if (!loggedIn) {
        throw new ConnectorSetupError(
          "CONNECTOR_NEEDS_HUMAN",
          "等待 ChatGPT 登录超时。请先运行 awehitch login 完成登录，再重试。"
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
    await ctx.navigate(ctx.urls.developerMode);
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
    await ctx.navigate(ctx.urls.plugins);
    if (ctx.dryRun) {
      await dryProbe("delete");
      const match = await findConnectorRows(ctx.page, ctx.site, spec.connectorName);
      steps.push({
        id: "delete",
        label: STEP_LABELS.delete,
        status: "planned",
        detail: `页面上共 ${match.totalRows} 个连接器，其中 ${match.rows.length} 个与本项目同名`,
      });
    } else {
      const result = await deleteConnectorByName(ctx.page, ctx.site, spec.connectorName);
      if (result.status === "failed") {
        steps.push({ id: "delete", label: STEP_LABELS.delete, status: "failed", detail: result.detail });
        return {
          ok: false,
          dryRun: false,
          steps,
          manualFallback: fallback(),
          error: { code: "CONNECTOR_FAILED", message: result.detail, target: "menuDelete" },
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
    await ctx.navigate(ctx.urls.createConnector);
    if (ctx.dryRun) {
      await dryProbe("create");
      steps.push({ id: "create", label: STEP_LABELS.create, status: "planned", detail: "dry-run 未提交表单" });
    } else {
      const result = await fillConnectorForm(ctx.page, ctx.site, {
        connectorName: spec.connectorName,
        mcpUrl: spec.mcpUrl,
        description,
      });
      steps.push({
        id: "create",
        label: STEP_LABELS.create,
        status: result.status,
        detail: result.detail,
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
        detail: "dry-run 未提交表单，授权页不会出现，该页元素无法在此探测",
      });
    } else {
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
            detail: "ChatGPT 已授权，无需输入配对码",
          });
        } else {
          throw new ConnectorSetupError(
            "CONNECTOR_DOM_CHANGED",
            "提交连接器表单后没有出现授权页，连接器可能没有创建成功。请检查页面上的报错，或手动在授权页输入配对码。"
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
        detail: unresolved.length === 0 ? "必需元素都能定位" : `未定位到：${unresolved.join("、")}`,
      });
      return { ok: true, dryRun: true, steps, probe, unresolved };
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
          detail: "ChatGPT 还没有拿到授权令牌",
        });
        return {
          ok: false,
          dryRun: false,
          steps,
          manualFallback: fallback(),
          error: { code: "CONNECTOR_FAILED", message: "授权没有完成，Bridge 里没有新的令牌。" },
        };
      }
      steps.push({
        id: "verify",
        label: STEP_LABELS.verify,
        status: "done",
        detail: "Bridge 已收到授权令牌",
      });
    } else {
      steps.push({
        id: "verify",
        label: STEP_LABELS.verify,
        status: "skipped",
        detail: "未提供授权状态查询，跳过",
      });
    }
  } catch (error) {
    return failed("verify", error);
  }

  const ok = steps.every((step) => step.status === "done" || step.status === "skipped");
  return { ok, dryRun: false, steps, manualFallback: ok ? undefined : fallback() };
}

export interface RunConnectorSetupOptions extends ConnectorSetupSpec {
  workspaceId: string;
  dryRun: boolean;
  loginTimeoutMs?: number;
  authorizeTimeoutMs?: number;
  verifyTimeoutMs?: number;
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
        navigate: async (url) => {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        },
        dryRun: opts.dryRun,
        loginTimeoutMs: opts.loginTimeoutMs ?? 5 * 60_000,
        authorizeTimeoutMs: opts.authorizeTimeoutMs ?? 60_000,
        verifyTimeoutMs: opts.verifyTimeoutMs ?? 30_000,
        onNotice: opts.onNotice,
        verifyAuthorized: opts.verifyAuthorized,
      },
      opts
    );
  } finally {
    await driver.close().catch(() => undefined);
  }
}
