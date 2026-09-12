# Connector setup

`awehitch connector-setup` creates or repairs the ChatGPT connector for one
workspace, automatically, in the control-plane browser.

## Why it exists

The Codex-only ancestor of this project (`codex-with-chatgpt`) could drive
ChatGPT's settings UI through Codex's built-in browser, so the connector was
created for the user. Harnesses without a browser — opencode, zcode — had to
fall back to teaching the user, which meant copying a URL and a pairing code by
hand.

awehitch already ships a Playwright control plane with a persistent,
logged-in ChatGPT profile, so the same flow runs there — for every harness.
The control plane owns the conversation; this command owns the connector.

## What it does

```
login → developer mode → delete stale connector → create → pairing → verify
```

| Step | What happens |
| --- | --- |
| `login` | Opens the ChatGPT plugins page in the persistent profile. If a login wall is showing, it waits for you to finish and then continues. |
| `developer-mode` | Turns Developer mode on if the page shows it off. A missing switch is never reported as "off". |
| `delete` | Removes a connector with **exactly** this workspace's title. Never clicks Reconnect. |
| `create` | Fills name / description / server URL, sets Authentication to OAuth, ticks the consent box if there is one, submits. |
| `authorize` | Types the pairing code on the authorize page and submits. |
| `verify` | Asks the bridge whether an authorized token appeared. |

Verify is the only success check, and it is real state (`tokenCount` grew),
not a green badge on a page.

## Safety properties

- **Exact title match, never substring.** `awehitch · proj` must not delete
  `awehitch · proj2`. Titles are matched after collapsing whitespace,
  stripping zero-width characters and case-folding. Two rows with the same
  title are treated as ambiguous: the run stops rather than picking one.
- **Never Reconnect.** When the tunnel address is reclaimed the old URL is
  dead, and Reconnect hangs on "This site cannot be reached".
- **Fails into the manual path, never into a dead end.** On any failure the
  result carries `manualFallback` with the real address, pairing code, page
  URLs and step list, so the agent can still guide you through it.
- **The only thing typed into a page is the pairing code.**

## Browser profile

This command opens its **own** Chrome window. It does not use — and never
touches — your everyday Chrome, so nothing of yours is logged in there and no
credentials are read from it.

The profile lives in the state dir and is **shared by every workspace on the
machine** — one ChatGPT login, not one per project:

```
~/Library/Application Support/awehitch/control-plane/browser-profile/shared/
%LOCALAPPDATA%\awehitch\control-plane\browser-profile\shared\
```

Log in once:

```bash
awehitch login -w /path/to/any/project
```

After that the session persists and every workspace's control plane and
`connector-setup` reuse it. `connector-setup` also waits for you if it hits a
login wall, so the explicit `awehitch login` is mostly a convenience.

**One holder at a time.** A Chromium profile directory cannot be opened by two
processes at once, so the profile is guarded by a lock. While a workspace is
actually driving ChatGPT it holds the browser; sessions close it after a few
idle minutes and relaunch it when needed. If you do collide with a live
holder, the error names the holding pid and workspace instead of failing with
a Playwright stack trace — stop that session (or wait for it to idle out) and
retry. Fully parallel driving across workspaces would need a browser-host
daemon; deliberately not built.

Upgrading from a pre-sharing version: old per-workspace profile directories
under `browser-profile/` are ignored; run `awehitch login` once.

## Selectors

The authorize page is served by our own bridge (`src/auth/oauth.ts`), so
`pairingCodeField`, `authorizeButton` and `pairingError` are exact.

The ChatGPT-side pages have no stable test ids across locales, so every
connector target carries a **list of candidate selectors**, tried in order.
When ChatGPT changes its layout, repair it without rebuilding:

```
awehitch connector-setup -w <workspace> --dry-run
```

`--dry-run` navigates the three pages, resolves every target and reports which
selector matched — and changes nothing. Any target it reports as unmatched can
be overridden in `<stateDir>/control-plane/selectors.json`:

```json
{
  "id": "chatgpt",
  "version": "chatgpt-1",
  "connector": {
    "serverUrlField": ["input[name='mcpServerUrl']"]
  }
}
```

An override replaces that target's whole candidate list, so a repair is one
known-good selector rather than a patch to a guess. Invalid overrides fall back
to the compiled default per target; `awehitch doctor` reports the problems.

## Output

All commands accept `--json`. A failure returns:

```json
{
  "ok": false,
  "error": { "code": "CONNECTOR_DOM_CHANGED", "message": "...", "target": "nameField" },
  "manualFallback": { "connectorName": "...", "mcpUrl": "...", "pairingCode": "...", "steps": ["..."] }
}
```

Codes:

| Code | Meaning |
| --- | --- |
| `CONNECTOR_NEEDS_HUMAN` | ChatGPT is behind a login wall (or the wait timed out). |
| `CONNECTOR_DOM_CHANGED` | An element could not be located; `target` names it. |
| `CONNECTOR_PAIRING_REJECTED` | The pairing code was refused or expired. |
| `CONNECTOR_FAILED` | Something else; the message says what. |

## TODO — verified against a logged-in ChatGPT (2026-09)

The create-connector form selectors (`nameField`, `descriptionField`,
`serverUrlField`, `authSelect`, `authOAuthOption`, `consentCheckbox`,
`createButton`) and `developerModeToggle` are now verified against a real,
logged-in ChatGPT — the create modal exposes stable ids
(`#custom-connector-name`, `#custom-connector-url`, `#custom-connector-auth`,
`#trust-checkbox`).

Still to verify on a live account:

1. `connectorRowName` / `rowMenu` / `menuDelete` — the row shape of an
   **existing custom connector**. A first run creates the connector; the
   second run exercises the delete path against that real row.
2. `confirmDelete` — only appears when a delete is actually confirmed.

Two things to know while doing this:

- **Headless will not work.** Headless Chrome is stopped by the Cloudflare
  Turnstile challenge on `chatgpt.com`. The driver is headful on purpose; do
  not "fix" it into headless.
- The authorize page (`pairingCodeField`, `authorizeButton`, `pairingError`)
  is ours, so those defaults are exact and do not need touching.
- ChatGPT is a SPA: every step waits for a rendered-page marker after
  navigation. A missing marker is reported as `CONNECTOR_DOM_CHANGED`.

## Agent contract

The skill runs this command instead of walking the user through the settings
pages. Only `CONNECTOR_NEEDS_HUMAN` should interrupt the user, and then with
exactly one action.
