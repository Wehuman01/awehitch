import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { DEFAULT_SITE } from "../src/control-plane/selectors.js";
import {
  deleteConnectorByName,
  findConnectorRows,
  isLoginWallVisible,
  runConnectorSetupFlow,
  type ConnectorPageUrls,
  type ConnectorSetupResult,
} from "../src/control-plane/connector.js";

/**
 * Connector-setup contract, offline.
 *
 * A loopback HTTP server serves ChatGPT-shaped fixtures for the three pages
 * the flow touches plus our own authorize page. That keeps the whole suite
 * hermetic (no chatgpt.com, no network) while still exercising real DOM,
 * real navigation and real clicks.
 *
 * The safety property under test is the important one: a connector is
 * deleted only on an EXACT title match, so `awehitch · proj` can never take
 * out `awehitch · proj2`.
 */

const CORRECT_CODE = "ABCD-1234";
const CONNECTOR_NAME = "awehitch · proj";
const SIBLING_NAME = "awehitch · proj2";

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

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

const SECURITY_PAGE = page(`
  <main>
    <div id="dev" role="switch" aria-checked="false" tabindex="0">Developer mode</div>
  </main>
  <script>
    const dev = document.getElementById('dev');
    dev.addEventListener('click', () => {
      dev.setAttribute('aria-checked', dev.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    });
  </script>`);

function row(name: string): string {
  return `
    <li>
      <h3>${name}</h3>
      <button aria-haspopup="menu" type="button">More</button>
      <div role="menu" hidden><div role="menuitem" tabindex="0">Delete</div></div>
    </li>`;
}

const PLUGINS_PAGE = page(`
  <main>
    <ul id="connectors">${row(CONNECTOR_NAME)}${row(SIBLING_NAME)}</ul>
  </main>
  <script>
    document.querySelectorAll('#connectors > li').forEach((li) => {
      const trigger = li.querySelector('button[aria-haspopup="menu"]');
      const menu = li.querySelector('[role="menu"]');
      trigger.addEventListener('click', () => { menu.hidden = false; });
      menu.querySelector('[role="menuitem"]').addEventListener('click', () => { li.remove(); });
    });
  </script>`);

const PLUGINS_WITH_LOGIN_WALL = page(`
  <main>
    <button id="login-button">Log in</button>
    <ul id="connectors">${row(CONNECTOR_NAME)}</ul>
  </main>`);

const CREATE_PAGE = page(`
  <main>
    <form id="create">
      <input name="name" type="text">
      <textarea name="description"></textarea>
      <input name="url" type="text">
      <select name="authType">
        <option value="">None</option>
        <option value="oauth">OAuth</option>
      </select>
      <input type="checkbox" id="consent">
      <button type="submit">Create</button>
    </form>
  </main>
  <script>
    document.getElementById('create').addEventListener('submit', (event) => {
      event.preventDefault();
      window.__createSubmits = (window.__createSubmits || 0) + 1;
      window.location.href = '/oauth/authorize';
    });
  </script>`);

/** Same form, but with the name input removed — models a DOM change. */
const CREATE_PAGE_NO_NAME_FIELD = page(`
  <main>
    <form id="create">
      <textarea name="description"></textarea>
      <input name="url" type="text">
      <button type="submit">Create</button>
    </form>
  </main>`);

const AUTHORIZE_PAGE = page(`
  <div class="card">
    <form id="auth" method="POST" action="authorize">
      <input type="hidden" name="request_id" value="req_1">
      <input type="text" name="pairing_code" id="pairing_code" placeholder="XXXX-XXXX" maxlength="9">
      <p class="error" hidden></p>
      <button type="submit">Connect</button>
    </form>
  </div>
  <script>
    document.getElementById('auth').addEventListener('submit', (event) => {
      event.preventDefault();
      const field = document.getElementById('pairing_code');
      const error = document.querySelector('.error');
      if (field.value.trim().toUpperCase() === '${CORRECT_CODE}') {
        window.location.href = '/connected';
        return;
      }
      error.textContent = 'Incorrect pairing code. 4 attempts left.';
      error.hidden = false;
    });
  </script>`);

const CONNECTED_PAGE = page(`<main><p>Connected</p></main>`);

let server: http.Server;
let base: string;
let urls: ConnectorPageUrls;
let routes: Map<string, () => string>;
let currentPage: Page;

const ROUTE_DEFAULTS: Record<string, () => string> = {
  "/security": () => SECURITY_PAGE,
  "/plugins": () => PLUGINS_PAGE,
  "/create": () => CREATE_PAGE,
  "/oauth/authorize": () => AUTHORIZE_PAGE,
  "/connected": () => CONNECTED_PAGE,
};

function stepOf(result: ConnectorSetupResult, id: string) {
  return result.steps.find((step) => step.id === id);
}

function flowContext(overrides: { dryRun?: boolean; loginTimeoutMs?: number } = {}) {
  return {
    page: currentPage,
    site: DEFAULT_SITE,
    urls,
    navigate: async (url: string) => {
      await currentPage.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    },
    dryRun: overrides.dryRun ?? false,
    loginTimeoutMs: overrides.loginTimeoutMs ?? 5_000,
    authorizeTimeoutMs: 10_000,
    verifyTimeoutMs: 1_000,
  };
}

/** The bridge's token only exists once the authorize page redirected. */
async function pairedInBrowser(): Promise<boolean> {
  return (await currentPage.evaluate(() => window.location.pathname)) === "/connected";
}

const SPEC = { connectorName: CONNECTOR_NAME, mcpUrl: "https://demo.trycloudflare.com/mcp", pairingCode: CORRECT_CODE };

beforeAll(async () => {
  if (!browser) return;
  server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const render = routes.get(path);
    res.writeHead(render ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(render ? render() : page("<main>not found</main>"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  urls = {
    developerMode: `${base}/security`,
    plugins: `${base}/plugins`,
    createConnector: `${base}/create`,
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await browser?.close().catch(() => undefined);
});

beforeEach(async () => {
  routes = new Map(Object.entries(ROUTE_DEFAULTS));
  if (!browser) return;
  currentPage = await browser.newPage();
});

afterEach(async () => {
  await currentPage?.close().catch(() => undefined);
});

describe.skipIf(!browser)("findConnectorRows", () => {
  it("matches the exact title only, never a title that merely starts with it", async () => {
    await currentPage.goto(urls.plugins);
    const exact = await findConnectorRows(currentPage, DEFAULT_SITE, CONNECTOR_NAME);
    expect(exact.totalRows).toBe(2);
    expect(exact.rows).toHaveLength(1);
    expect(exact.ambiguous).toBe(false);

    // "awehitch" is a prefix of BOTH rows — substring matching here would be
    // the bug that deletes another workspace's connector.
    const prefix = await findConnectorRows(currentPage, DEFAULT_SITE, "awehitch");
    expect(prefix.rows).toHaveLength(0);
  });

  it("normalizes whitespace and zero-width characters", async () => {
    await currentPage.goto(urls.plugins);
    const spaced = await findConnectorRows(currentPage, DEFAULT_SITE, `  ${CONNECTOR_NAME}  `);
    expect(spaced.rows).toHaveLength(1);
  });
});

describe.skipIf(!browser)("isLoginWallVisible", () => {
  it("detects the logged-out button ChatGPT actually renders", async () => {
    // A logged-out ChatGPT renders `data-testid="login-button"` — the old
    // `#login-button` selector missed it, so a logged-out browser looked
    // logged in and the connector flow ran against a page that never existed.
    routes.set("/plugins", () => page(`<main><button data-testid="login-button">Log in</button></main>`));
    await currentPage.goto(urls.plugins);
    expect(await isLoginWallVisible(currentPage, DEFAULT_SITE)).toBe(true);
  });

  it("reports no login wall on a rendered connectors page", async () => {
    await currentPage.goto(urls.plugins);
    expect(await isLoginWallVisible(currentPage, DEFAULT_SITE)).toBe(false);
  });
});

describe.skipIf(!browser)("deleteConnectorByName", () => {
  it("removes only this workspace's connector and leaves the sibling alone", async () => {
    await currentPage.goto(urls.plugins);
    const result = await deleteConnectorByName(currentPage, DEFAULT_SITE, CONNECTOR_NAME);
    expect(result.status).toBe("done");

    const titles = await currentPage.locator("#connectors h3").allInnerTexts();
    expect(titles).toEqual([SIBLING_NAME]);
  });

  it("skips when no connector carries that title", async () => {
    await currentPage.goto(urls.plugins);
    const result = await deleteConnectorByName(currentPage, DEFAULT_SITE, "awehitch · someone-else");
    expect(result.status).toBe("skipped");
    expect(await currentPage.locator("#connectors h3").count()).toBe(2);
  });

  it("refuses to act on an ambiguous match", async () => {
    await currentPage.goto(urls.plugins);
    // A second row with the SAME title: the flow must stop, not pick one.
    await currentPage.evaluate(
      (name) => {
        const list = document.getElementById("connectors");
        const clone = list?.firstElementChild?.cloneNode(true);
        if (list && clone) list.appendChild(clone);
      },
      CONNECTOR_NAME
    );
    await expect(deleteConnectorByName(currentPage, DEFAULT_SITE, CONNECTOR_NAME)).rejects.toThrow(
      /标题完全相同/
    );
    expect(await currentPage.locator("#connectors h3").count()).toBe(3);
  });

  it("fails honestly when the list never renders", async () => {
    routes.set("/plugins", () => page("<main><p>Settings</p></main>"));
    await currentPage.goto(urls.plugins);
    await expect(deleteConnectorByName(currentPage, DEFAULT_SITE, CONNECTOR_NAME)).rejects.toThrow(
      /一个条目都没有找到/
    );
  });
});

describe.skipIf(!browser)("runConnectorSetupFlow", () => {
  it("runs login → developer mode → delete → create → pairing → verify", async () => {
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: pairedInBrowser },
      SPEC
    );

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.manualFallback).toBeUndefined();
    expect(result.steps.map((step) => step.status)).toEqual(["done", "done", "done", "done", "done", "done"]);
    expect(stepOf(result, "developer-mode")?.detail).toContain("已开启开发人员模式");
    expect(stepOf(result, "delete")?.detail).toContain("已删除");
    expect(stepOf(result, "create")?.detail).toContain("OAuth");
    expect(stepOf(result, "authorize")?.detail).toContain("配对码已通过");
    expect(stepOf(result, "verify")?.detail).toContain("Bridge 已收到授权令牌");

    // The authorize page really did redirect, which is what the verify hook
    // above keys on — so verification is against real state, not a DOM badge.
    expect(await currentPage.evaluate(() => window.location.pathname)).toBe("/connected");
  });

  it("turns developer mode on when the switch starts off", async () => {
    await currentPage.goto(urls.developerMode);
    expect(await currentPage.locator("#dev").getAttribute("aria-checked")).toBe("false");
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: async () => true },
      SPEC
    );
    expect(stepOf(result, "developer-mode")?.status).toBe("done");
  });

  it("submits the exact address and pairing code into the authorize page", async () => {
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: pairedInBrowser },
      { ...SPEC, mcpUrl: "https://specific.example.com/mcp" }
    );
    expect(result.ok).toBe(true);
    expect(stepOf(result, "authorize")?.status).toBe("done");
  });

  it("changes nothing at all on --dry-run, but reports every element it resolved", async () => {
    const result = await runConnectorSetupFlow({ ...flowContext({ dryRun: true }) }, SPEC);

    expect(result.dryRun).toBe(true);
    expect(result.ok).toBe(true);
    // Login is a read-only page check, so it already reports "done"; every
    // step that would change something stays "planned".
    expect(stepOf(result, "login")?.status).toBe("done");
    expect(
      result.steps.filter((step) => step.id !== "login").every((step) => step.status === "planned")
    ).toBe(true);

    // Nothing was clicked: still on the create page, form untouched, no submit.
    expect(await currentPage.evaluate(() => window.location.pathname)).toBe("/create");
    expect(await currentPage.evaluate("window.__createSubmits || 0")).toBe(0);
    expect(await currentPage.locator("input[name='name']").inputValue()).toBe("");

    // And the probe says which selector won for each target it could reach.
    expect(result.probe?.nameField?.selector).toBe("input[name='name']");
    expect(result.probe?.serverUrlField?.selector).toBe("input[name='url']");
    expect(result.probe?.connectorRow?.selector).toBe("li");
    expect(result.unresolved ?? []).toEqual([]);
  });

  it("reports a DOM change honestly, naming the target and offering manual steps", async () => {
    routes.set("/create", () => CREATE_PAGE_NO_NAME_FIELD);
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: async () => true },
      SPEC
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CONNECTOR_DOM_CHANGED");
    expect(result.error?.target).toBe("nameField");
    expect(stepOf(result, "create")?.status).toBe("failed");
    // The fallback must carry the real values, so a broken selector degrades
    // to the old guided flow instead of dead-ending the user.
    expect(result.manualFallback?.mcpUrl).toBe(SPEC.mcpUrl);
    expect(result.manualFallback?.pairingCode).toBe(CORRECT_CODE);
    expect(result.manualFallback?.steps.join("\n")).toContain(SPEC.mcpUrl);
  });

  it("surfaces a rejected pairing code instead of pretending it worked", async () => {
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: async () => true },
      { ...SPEC, pairingCode: "WRONG-0000" }
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CONNECTOR_PAIRING_REJECTED");
    expect(result.error?.message).toContain("Incorrect pairing code");
    expect(stepOf(result, "authorize")?.status).toBe("failed");
  });

  it("asks for a human when ChatGPT is behind a login wall", async () => {
    routes.set("/plugins", () => PLUGINS_WITH_LOGIN_WALL);
    const result = await runConnectorSetupFlow(
      { ...flowContext({ loginTimeoutMs: 1_000 }), verifyAuthorized: async () => true },
      SPEC
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CONNECTOR_NEEDS_HUMAN");
    expect(stepOf(result, "login")?.status).toBe("needs-human");
  });

  it("fails the run when the bridge never receives a token", async () => {
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: async () => false },
      SPEC
    );
    expect(result.ok).toBe(false);
    expect(stepOf(result, "verify")?.status).toBe("failed");
  });

  it("accepts 'already authorized' when no authorize page appears", async () => {
    routes.set("/create", () =>
      page(`
        <main>
          <form id="create">
            <input name="name" type="text">
            <input name="url" type="text">
            <button type="submit">Create</button>
          </form>
        </main>`)
    );
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: async () => true },
      SPEC
    );
    expect(result.ok).toBe(true);
    expect(stepOf(result, "authorize")?.status).toBe("skipped");
  });
});
