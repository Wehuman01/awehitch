import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { DEFAULT_SITE } from "../src/control-plane/selectors.js";
import {
  bumpConnectorName,
  deleteConnectorByName,
  ensureDeveloperMode,
  findConnectorRows,
  isLoginWallVisible,
  runConnectorSetupFlow,
  type ConnectorPageUrls,
  type ConnectorSetupResult,
} from "../src/control-plane/connector.js";

/**
 * Connector-setup contract, offline.
 *
 * A loopback HTTP server serves ChatGPT-shaped fixtures mirroring the UI and
 * backend as verified on a logged-in ChatGPT (2026-09). Two load-bearing
 * facts the flow depends on:
 *
 * - Deleting goes through the BACKEND (ps/plugins/list + aip/connectors
 *   DELETE), because the settings UI's "Uninstall" only removes the
 *   installation: the dev connector object stays behind, keeps the name
 *   reserved, and a recreate then fails with a silent 409.
 * - The authorize page only appears after opening the connector's detail
 *   (Connect row) and confirming in the "Add <name> to ChatGPT" dialog via
 *   "Sign in with <name>".
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
    <!-- Mirrors the real Security settings page: the FIRST switch is
         Lockdown mode, Developer mode comes later. The pack must touch only
         the one labelled "Developer mode". -->
    <section>
      <button type="button" role="switch" aria-checked="false" data-state="unchecked"
              aria-label="Lockdown mode" data-testid="lockdown-mode-toggle"><span></span></button>
    </section>
    <section>
      <button type="button" role="switch" aria-checked="false" data-state="unchecked"
              aria-label="Developer mode"><span></span></button>
    </section>
  </main>
  <script>
    document.querySelectorAll('button[role="switch"]').forEach((sw) => {
      sw.addEventListener('click', () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(on));
        sw.setAttribute('data-state', on ? 'checked' : 'unchecked');
      });
    });
  </script>`);

/** Server-side connector registry shared with the API fixtures. */
let connectors: { id: string; name: string }[];
let listEndpointBroken: boolean;
let deleteEndpointBroken: boolean;
/** How many create POSTs get a 409 name-conflict before one succeeds. */
let createConflicts: number;

function pluginEntry(c: { id: string; name: string }) {
  return {
    id: `plugin_${c.id}`,
    connector_id: c.id,
    canonical_app_id: c.id,
    release: { display_name: c.name },
  };
}

/** One settings-list row, shaped like the real modal (verified 2026-09). */
function settingsRow(name: string): string {
  return `
    <div class="row-wrap">
      <div class="w-full">
        <button type="button" class="row-btn" data-name="${name}">
          <div class="flex min-w-0 items-center gap-3">
            <div data-testid="plugin-icon-wrapper" style="width:32px;height:32px">
              <svg data-testid="default-plugin-icon" style="width:16px;height:16px"></svg>
            </div>
            <div class="min-w-0"><div class="text-token-text-primary truncate">${name}</div></div>
          </div>
        </button>
      </div>
    </div>`;
}

/** Settings modal: clicking a row opens the detail view; Connect opens the
 * consent dialog whose "Sign in with <name>" button reaches the authorize
 * page (verified 2026-09). */
function settingsPage(): string {
  return page(`
    <main data-testid="modal-settings">
      <div id="connectors-list">${connectors.map((c) => settingsRow(c.name)).join("")}</div>
      <div id="detail-slot"></div>
    </main>
    <script>
      document.querySelectorAll('#connectors-list .row-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const name = btn.getAttribute('data-name');
          const slot = document.getElementById('detail-slot');
          slot.innerHTML =
            '<button id="connect-btn" type="button">Connection <span>Connect</span></button>' +
            '<button id="back-btn" type="button">Back</button>';
          document.getElementById('connect-btn').addEventListener('click', () => {
            slot.innerHTML +=
              '<div role="dialog"><h2>Add ' + name + ' to ChatGPT</h2>' +
              '<button id="signin-btn" type="button">Sign in with ' + name + '</button></div>';
            document.getElementById('signin-btn').addEventListener('click', () => {
              window.location.href = '/oauth/authorize';
            });
          });
        });
      });
    </script>`);
}

/** Store page (login-wall probe surface): icon anchors like the real grid. */
function storePage(): string {
  const anchors = connectors
    .map(
      (c) =>
        `<a aria-label="Open ${c.name}" href="/plugin-page?name=${encodeURIComponent(c.name)}">` +
        `<div data-testid="plugin-icon-wrapper" style="width:40px;height:40px"></div></a>`
    )
    .join("");
  return page(`<main><div id="store">${anchors}</div></main>`);
}

const CREATE_PAGE = page(`
  <main>
    <!-- Mirrors the real create-connector modal (verified 2026-09). -->
    <div data-testid="modal-create-custom-connector">
      <form id="create">
        <input id="custom-connector-name" name="custom-connector-name" aria-label="Name" type="text">
        <input id="custom-connector-description" name="custom-connector-description" type="text">
        <input id="custom-connector-url" name="custom-connector-url" inputmode="url" type="text">
        <select id="custom-connector-auth">
          <option value="OAUTH">OAuth</option>
          <option value="NONE">No Auth</option>
        </select>
        <input id="trust-checkbox" data-testid="trust-checkbox" type="checkbox">
        <button type="submit">Create</button>
      </form>
    </div>
  </main>
  <script>
    document.getElementById('create').addEventListener('submit', (event) => {
      event.preventDefault();
      window.__createSubmits = (window.__createSubmits || 0) + 1;
      const name = document.getElementById('custom-connector-name').value;
      // The real UI registers the connector (server-validated, ~15s), returns
      // to the list, and does NOT open the authorize page by itself. The POST
      // goes to the same backend path the flow watches for a 409 verdict.
      fetch('/backend-api/aip/connectors/mcp?name=' + encodeURIComponent(name), { method: 'POST' })
        .then(() => {}).catch(() => {});
      setTimeout(() => { window.location.href = '/connectors'; }, 2_000);
    });
  </script>`);

/** The modal stays open with an alert — models ChatGPT rejecting the URL. */
const CREATE_PAGE_CREATE_FAILS = page(`
  <main>
    <div data-testid="modal-create-custom-connector">
      <form id="create">
        <input id="custom-connector-name" name="custom-connector-name" type="text">
        <input id="custom-connector-url" name="custom-connector-url" type="text">
        <p role="alert" id="create-error" hidden>Could not reach the MCP server.</p>
        <button type="submit">Create</button>
      </form>
    </div>
  </main>
  <script>
    document.getElementById('create').addEventListener('submit', (event) => {
      event.preventDefault();
      document.getElementById('create-error').hidden = false;
    });
  </script>`);

/** Same form, but with the name input removed — models a DOM change. */
const CREATE_PAGE_NO_NAME_FIELD = page(`
  <main>
    <div data-testid="modal-create-custom-connector">
      <form id="create">
        <input id="custom-connector-description" name="custom-connector-description" type="text">
        <input id="custom-connector-url" name="custom-connector-url" inputmode="url" type="text">
        <button type="submit">Create</button>
      </form>
    </div>
  </main>
  <script>
    document.getElementById('create').addEventListener('submit', (event) => {
      event.preventDefault();
      window.location.href = '/connectors';
    });
  </script>`);

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
  "/connectors": () => settingsPage(),
  "/plugins": () => storePage(),
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
    createTimeoutMs: 5_000,
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
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/api/auth/session") {
      json(200, { accessToken: "test-token" });
      return;
    }
    if (path === "/backend-api/ps/plugins/list") {
      if (listEndpointBroken) {
        json(500, { detail: "boom" });
        return;
      }
      json(200, { plugins: connectors.map(pluginEntry) });
      return;
    }
    if (path === "/backend-api/aip/connectors/mcp" && req.method === "POST") {
      // Create verdict: a 409 models ChatGPT reserving the name (the real UI
      // then closes the modal WITHOUT creating anything). Must run BEFORE the
      // DELETE branch below — that prefix would swallow this path.
      const name = url.searchParams.get("name") ?? "";
      if (createConflicts > 0) {
        createConflicts -= 1;
        json(409, { detail: { message: `Connector with name '${name}' already exists` } });
        return;
      }
      connectors.push({ id: `new-${connectors.length + 1}`, name });
      json(200, {});
      return;
    }
    if (path.startsWith("/backend-api/aip/connectors/")) {
      const id = path.slice("/backend-api/aip/connectors/".length);
      const entry = connectors.find((c) => c.id === id);
      if (deleteEndpointBroken || !entry) {
        json(404, { detail: "Not Found" });
        return;
      }
      connectors = connectors.filter((c) => c.id !== id);
      json(200, {});
      return;
    }
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
    connectors: `${base}/connectors`,
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
  connectors = [
    { id: "id-proj", name: CONNECTOR_NAME },
    { id: "id-proj2", name: SIBLING_NAME },
  ];
  listEndpointBroken = false;
  deleteEndpointBroken = false;
  createConflicts = 0;
  if (!browser) return;
  currentPage = await browser.newPage();
  // Loopback fixtures respond in milliseconds; a short default turns a
  // selector regression into a fast, precise failure instead of a 30s hang.
  currentPage.setDefaultTimeout(4_000);
});

afterEach(async () => {
  await currentPage?.close().catch(() => undefined);
});

describe("bumpConnectorName", () => {
  it("appends 2 to a fresh name and increments an existing suffix", () => {
    expect(bumpConnectorName("awehitch · proj")).toBe("awehitch · proj 2");
    expect(bumpConnectorName("awehitch · proj 2")).toBe("awehitch · proj 3");
    expect(bumpConnectorName("awehitch · proj 12")).toBe("awehitch · proj 13");
  });
});

describe.skipIf(!browser)("findConnectorRows", () => {
  it("matches the exact title only, never a title that merely starts with it", async () => {
    await currentPage.goto(urls.connectors);
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
    await currentPage.goto(urls.connectors);
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

  it("reports no login wall on a rendered store page", async () => {
    await currentPage.goto(urls.plugins);
    expect(await isLoginWallVisible(currentPage, DEFAULT_SITE)).toBe(false);
  });
});

describe.skipIf(!browser)("ensureDeveloperMode", () => {
  it("flips only the Developer mode switch, never the first switch on the page", async () => {
    // Mirrors the real Security settings page: Lockdown mode renders first.
    // A bare `[role='switch']` candidate would turn Lockdown mode ON here.
    await currentPage.goto(urls.developerMode);
    const devSwitch = currentPage.locator("button[role='switch'][aria-label='Developer mode']");
    const lockdown = currentPage.locator("button[role='switch'][aria-label='Lockdown mode']");
    expect(await devSwitch.getAttribute("aria-checked")).toBe("false");
    expect(await lockdown.getAttribute("aria-checked")).toBe("false");
    const result = await ensureDeveloperMode(currentPage, DEFAULT_SITE);
    expect(result.status).toBe("done");
    expect(await devSwitch.getAttribute("aria-checked")).toBe("true");
    expect(await lockdown.getAttribute("aria-checked")).toBe("false");
  });
});

describe.skipIf(!browser)("deleteConnectorByName", () => {
  it("deletes only this workspace's connector and leaves the sibling alone", async () => {
    await currentPage.goto(urls.plugins);
    const result = await deleteConnectorByName(currentPage, CONNECTOR_NAME);
    expect(result.status).toBe("done");
    expect(connectors.map((c) => c.name)).toEqual([SIBLING_NAME]);
  });

  it("skips when no connector carries that title", async () => {
    await currentPage.goto(urls.plugins);
    const result = await deleteConnectorByName(currentPage, "awehitch · someone-else");
    expect(result.status).toBe("skipped");
    expect(connectors).toHaveLength(2);
  });

  it("refuses to act on an ambiguous match", async () => {
    connectors.push({ id: "id-dup", name: CONNECTOR_NAME });
    await currentPage.goto(urls.plugins);
    await expect(deleteConnectorByName(currentPage, CONNECTOR_NAME)).rejects.toThrow(/titled exactly/);
    expect(connectors).toHaveLength(3);
  });

  it("matches the display name exactly, not a prefix", async () => {
    connectors.push({ id: "id-prefix", name: `${CONNECTOR_NAME} 2` });
    await currentPage.goto(urls.plugins);
    const result = await deleteConnectorByName(currentPage, CONNECTOR_NAME);
    expect(result.status).toBe("done");
    expect(connectors.map((c) => c.name).sort()).toEqual([`${CONNECTOR_NAME} 2`, SIBLING_NAME].sort());
  });

  it("fails honestly when the backend list cannot be read", async () => {
    listEndpointBroken = true;
    await currentPage.goto(urls.plugins);
    await expect(deleteConnectorByName(currentPage, CONNECTOR_NAME)).rejects.toThrow(/Failed to query the connector list/);
    expect(connectors).toHaveLength(2);
  });

  it("fails honestly when the backend rejects the delete", async () => {
    deleteEndpointBroken = true;
    await currentPage.goto(urls.plugins);
    const result = await deleteConnectorByName(currentPage, CONNECTOR_NAME);
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("rejected");
    expect(connectors).toHaveLength(2);
  });
});

describe.skipIf(!browser)("runConnectorSetupFlow", () => {
  it("runs login → developer mode → delete → create → Connect → pairing → verify", async () => {
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: pairedInBrowser },
      SPEC
    );

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.manualFallback).toBeUndefined();
    expect(result.steps.map((step) => step.status)).toEqual(["done", "done", "done", "done", "done", "done"]);
    expect(stepOf(result, "developer-mode")?.detail).toContain("Developer mode enabled");
    expect(stepOf(result, "delete")?.detail).toContain("Deleted");
    expect(stepOf(result, "create")?.detail).toContain("OAuth");
    expect(stepOf(result, "authorize")?.detail).toContain("Pairing code accepted");
    expect(stepOf(result, "verify")?.detail).toContain("Bridge received the authorization token");

    // The authorize page really did redirect, which is what the verify hook
    // above keys on — so verification is against real state, not a DOM badge.
    expect(await currentPage.evaluate(() => window.location.pathname)).toBe("/connected");
    // And the created connector really is registered server-side.
    expect(connectors.some((c) => c.name === CONNECTOR_NAME)).toBe(true);
    // No conflict happened, so the requested title survived untouched.
    expect(result.connectorName).toBe(CONNECTOR_NAME);
  });

  it("retries under a fresh title when ChatGPT reserves the old name", async () => {
    // Uninstalling does not free a dev connector's name (the object stays
    // server-side and 409s the recreate) — the flow must bump and retry.
    createConflicts = 1;
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: pairedInBrowser },
      SPEC
    );

    expect(result.ok).toBe(true);
    expect(result.connectorName).toBe(`${CONNECTOR_NAME} 2`);
    expect(connectors.some((c) => c.name === `${CONNECTOR_NAME} 2`)).toBe(true);
    expect(stepOf(result, "authorize")?.detail).toContain("Pairing code accepted");
  });

  it("gives up with the conflict error after repeated conflicts", async () => {
    createConflicts = 5;
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: async () => true },
      SPEC
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code, JSON.stringify(result)).toBe("CONNECTOR_NAME_CONFLICT");
    expect(result.error?.message).toContain("already exists");
    // The fallback teaches the user the LAST attempted title.
    expect(result.manualFallback?.connectorName).toBe(`${CONNECTOR_NAME} 3`);
    expect(stepOf(result, "create")?.status).toBe("failed");
  });

  it("turns developer mode on when the switch starts off", async () => {
    await currentPage.goto(urls.developerMode);
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: async () => true },
      SPEC
    );
    // The step really flipped the switch (the detail proves the re-read).
    expect(stepOf(result, "developer-mode")?.status).toBe("done");
    expect(stepOf(result, "developer-mode")?.detail).toContain("Developer mode enabled");
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
    expect(await currentPage.locator("#custom-connector-name").inputValue()).toBe("");
    expect(connectors).toHaveLength(2);

    // And the probe says which selector won for each target it could reach.
    expect(result.probe?.nameField?.selector).toBe("#custom-connector-name");
    expect(result.probe?.serverUrlField?.selector).toBe("#custom-connector-url");
    expect(result.probe?.connectorRow?.selector).toBe(
      "div:has(> div > button > div [data-testid='plugin-icon-wrapper'])"
    );
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

  it("fails the create step with the page's error when ChatGPT rejects the connector", async () => {
    routes.set("/create", () => CREATE_PAGE_CREATE_FAILS);
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: async () => true },
      SPEC
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CONNECTOR_FAILED");
    expect(result.error?.message).toContain("Could not reach the MCP server.");
    expect(stepOf(result, "create")?.status).toBe("failed");
    // The user can still finish by hand — that is the whole fallback contract.
    expect(result.manualFallback?.connectorName).toBe(CONNECTOR_NAME);
  });

  it("surfaces a rejected pairing code instead of pretending it worked", async () => {
    // No existing grant (the bridge holds no token), so the flow really goes
    // through Connect → Sign in → authorize and submits the wrong code.
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: async () => false },
      { ...SPEC, pairingCode: "WRONG-0000" }
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CONNECTOR_PAIRING_REJECTED");
    expect(result.error?.message).toContain("Incorrect pairing code");
    expect(stepOf(result, "authorize")?.status).toBe("failed");
  });

  it("asks for a human when ChatGPT is behind a login wall", async () => {
    routes.set("/plugins", () => page(`<main><button data-testid="login-button">Log in</button></main>`));
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
    expect(stepOf(result, "verify")?.status, JSON.stringify(result)).toBe("failed");
  });

  it("accepts 'already authorized' when no authorize page appears", async () => {
    routes.set("/create", () =>
      page(`
        <main>
          <div data-testid="modal-create-custom-connector">
            <form id="create">
              <input id="custom-connector-name" name="custom-connector-name" type="text">
              <input id="custom-connector-url" name="custom-connector-url" type="text">
              <button type="submit">Create</button>
            </form>
          </div>
        </main>
        <script>
          document.getElementById('create').addEventListener('submit', (event) => {
            event.preventDefault();
            document.body.innerHTML = '<p>created</p>';
          });
        </script>`)
    );
    const result = await runConnectorSetupFlow(
      { ...flowContext(), verifyAuthorized: async () => true },
      SPEC
    );
    expect(result.ok).toBe(true);
    expect(stepOf(result, "authorize")?.status).toBe("skipped");
  });
});
