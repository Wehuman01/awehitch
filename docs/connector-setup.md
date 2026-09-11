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

The profile lives in the state dir, one per workspace:

```
~/Library/Application Support/awehitch/control-plane/browser-profile/<workspace-id>/
%LOCALAPPDATA%\awehitch\control-plane\browser-profile\<workspace-id>\
```

So **each workspace needs one ChatGPT login**:

```bash
awehitch login -w /path/to/your/project
```

After that the session persists in that profile and both the control plane and
`connector-setup` reuse it. `connector-setup` also waits for you if it hits a
login wall, so the explicit `awehitch login` is mostly a convenience.

Per-workspace profiles are deliberate: it keeps one project's session separate
from another's, and lets two workspaces run at once (a browser profile can
only be held by one process at a time). The cost is logging in once per
workspace.

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

## TODO — not verified yet

The ChatGPT-side form selectors are **best-effort defaults**. They were not
validated against a logged-in ChatGPT: the only live run so far happened on a
profile that was not logged in, so `nameField`, `serverUrlField`,
`createButton`, `connectorRowName` and `menuDelete` came back unresolved. That
is expected, and it is what `--dry-run` exists to surface — but they need
filling in before this is trustworthy:

1. `awehitch login -w <a real project you are logged into>`
2. `awehitch connector-setup -w <that project> --dry-run --json`
3. For every target reported as unmatched, find the real element and write it
   into `<stateDir>/control-plane/selectors.json` under `connector.<target>`.
4. Re-run `--dry-run` until `unresolved` is empty, then run it for real.

Two things to know while doing this:

- **Headless will not work.** Headless Chrome is stopped by the Cloudflare
  Turnstile challenge on `chatgpt.com/plugins`. The driver is headful on
  purpose; do not "fix" it into headless.
- The authorize page (`pairingCodeField`, `authorizeButton`, `pairingError`)
  is ours, so those defaults are exact and do not need touching.

## Agent contract

The skill runs this command instead of walking the user through the settings
pages. Only `CONNECTOR_NEEDS_HUMAN` should interrupt the user, and then with
exactly one action.
