# Contributing to awehitch

## Setup

```bash
git clone https://github.com/Wehuman01/awehitch.git awehitch
cd awehitch
corepack pnpm install
corepack pnpm run verify   # typecheck + tests — exactly what CI runs
```

Tests run offline (loopback fixtures; real Chromium where it matters). If verify
turns flaky, find the network call in the failing test — do not raise timeouts.
The repo is pnpm-managed; do not run bare `npm install` here (it would create a
`package-lock.json` and reshuffle `node_modules`).

## Engineering Taste

Prefer solutions that are simple, clear, decoupled, honest, focused, and
durable.

- Simple: make the smallest change that solves the real problem.
- Clear: optimize for the next reader, not for cleverness.
- Decoupled: keep boundaries clean, but do not add abstractions without a real need.
- Honest: make complexity, state, side effects, assumptions, and failure modes visible; do not hide complexity or create extra complexity.
- Focused: preserve boundaries between modules, and keep top-level convenience commands minimal.
- Durable: choose behavior that is easy to maintain, test, and extend.
- First principles: identify the real problem, hard constraints, and known facts before reaching for patterns, abstractions, or prior solutions.

## Architecture

```
              ┌───────────────────────────┐
              │    ChatGPT Web / Sol      │
              │  Reason / Plan / Review   │
              └──────────┬──────────▲─────┘
                         │          │
                MCP      │          │ [C2C] control messages (< 1 KB)
             Data Plane   │          │ Control Plane
                         ▼          │
              ┌─────────────────────┐
              │    awehitch Bridge    │
              │  MCP Server          │
              │  OAuth AS + PRM      │
              │  Pairing Manager     │
              │  Tunnel Manager      │
              │  Admin API (local)   │
              └────────┬────────────┘
                       │ reads + direct-mode writes
                       ▼
              ┌─────────────────────┐
              │   Local Workspace    │
              └────────▲────────────┘
                       │ edit / shell / git / test
              ┌────────┴─────────────┐
              │  Agent (codex / …)   │
              └────────▲─────────────┘
                       │ stdio MCP (5 semantic tools)
              ┌────────┴─────────────┐
              │ Control-Plane Proxy  │  ← the decoupling layer
              └─────────────────────┘
```

Principles:

- **ChatGPT thinks — and by default acts.** Direct mode (`chatgptMode`,
  default `write-exec`) lets ChatGPT patch files and run gated commands
  itself; the bridge never re-implements a coding harness beyond those two
  constrained write paths.
- **Control plane decoupled from the harness.** Any harness that can call MCP
  tools can run the whole loop — the bar is "can call tools", not "has a
  built-in browser".
- **Semantic tools, not a raw browser.** Five tools for the agent
  (`awehitch_open_chat`, `awehitch_send_state`, `awehitch_send_handoff`,
  `awehitch_wait_reply`, `awehitch_read_reply`) plus read-only
  `awehitch_chat_info`. Polling is cheap (20–30 s), timeout ≠ failure, one tab,
  never resend, one chat per task.
- **MCP = data plane**: ChatGPT pulls files/diffs/search itself, plus the two
  direct-mode write tools (`apply_patch`, `run_command`) — present unless the
  workspace opts into `readonly`; no other write surface exists.
- **Workspace is the security boundary**: one bridge = one workspace = one
  token audience.

Module map (`src/`):

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | Data-plane MCP server (read tools + direct-mode `apply_patch` / `run_command` + `dispatch_agent`), stateless Streamable HTTP |
| `control-plane/` | Playwright driver over the ChatGPT conversation + stdio MCP server (5 semantic tools); per-session browser profiles from a slot pool (`slot.ts`) behind cross-process locks, per-task chat bindings merged under a short lock |
| `auth/` | OAuth 2.1 AS: discovery (RFC 8414), DCR (RFC 7591), code + PKCE (S256), refresh rotation, revocation (RFC 7009); tokens stored as SHA-256 hashes |
| `pairing/` | Pairing-code lifecycle: CSPRNG, TTL, attempt limits, IP rate limit (keyed on the unforgeable last XFF hop), one-time use |
| `workspace/` | Canonical-path containment, sensitive-file policy, `.c2cignore`, pagination, search, git status/diff |
| `adapters/` | Harness integration (see below); thin, never import each other |
| `tunnel/` | `TunnelProvider` + Cloudflare Quick / Named implementations |
| `execution/` | JSONL execution records + sanitized optional command output |
| `process/` | Daemon spawn/reuse (one bridge per machine: `up` stops the previous workspace's bridge and switches), per-workspace exclusive lock, pid-identity-checked shutdown |
| `session/` | Resume checkpoints + HANDOFF composition |
| `cli/` | Commands; `--json` everywhere for the skills |
| `config/`, `logger/`, `fs/` | State dir, secret-redacting logger, atomic writes |

Lifecycles: data-plane call → tunnel → `/mcp` → bearer middleware → tool →
workspace gate (containment → ignore rules → pagination). Control-plane call →
stdio MCP → Playwright (dedicated profile) → DOM → JSON reply view.
Authorization: 401 + `resource_metadata` → AS metadata → DCR → authorize (HTML
pairing page) → code → token (PKCE). Ports: prefer 48765, loopback only, fall
back to ephemeral on conflict. Bridge state files are pid-identity-checked
before any kill; concurrent `up` calls spawn at most one bridge.

## The [C2C] protocol

Control messages carry **state, never content** (< 1 KB, no diffs/logs/file
bodies); the data plane (MCP) carries content. The agent-facing flow — boot
prompt, message templates, tool usage — lives in `skill/SKILL.md.template`;
the rendered skill is the protocol's consumer, so protocol changes must update
the template.

```
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

| State | Sender | Meaning |
| --- | --- | --- |
| INIT | agent | New task; asks ChatGPT to inspect + plan |
| PLAN | ChatGPT | Executable plan for the next iteration |
| EXECUTING | agent | (optional) execution in progress |
| EXECUTED | agent | Iteration finished; metadata only |
| DONE / BLOCKED / ERROR | ChatGPT / either | Terminal states (BLOCKED carries a reason) |
| HANDOFF | agent | Continuation brief to a replacement chat |

Invariants: no `RESUME` state — restarts read the **local checkpoint**
(`protocolState`, `waitingFor`, goal, issues, next step); HANDOFF is composed
from that checkpoint, never from logs; record the iteration
(`awehitch record …`) **before** sending EXECUTED; `maxIterations` defaults to
12 (`.c2c.json`) and pauses for the user when reached; never re-pair just to
resume.

## Harness adapters

| | codex | opencode | zcode |
| --- | --- | --- | --- |
| Config home | `CODEX_HOME` → `~/.codex` | `OPENCODE_CONFIG_DIR` → `XDG_CONFIG_HOME/opencode` → `~/.config/opencode` (`OPENCODE_CONFIG` is a *file* path — never used as a directory) | `ZCODE_HOME` → `~/.zcode/cli` |
| MCP entry | `config.toml` `[mcp_servers.awehitch]` | `opencode.json` `"mcp".awehitch` (JSONC-aware upsert, comments preserved) | `config.json` `mcpServers.awehitch` |
| Skill | `~/.codex/skills/awehitch/SKILL.md` | `<config home>/skills/awehitch/SKILL.md` | `<config home>/skills/awehitch/SKILL.md` + agents file |
| Sandbox | `writable_roots` append (verbatim entries, atomic write) | none needed | none needed |

All writes to user-owned config files go through the atomic temp+rename helper
(`src/fs/atomic.ts`) and append only our own entries — user text survives
byte-for-byte. Adding a harness: one adapter file in `src/adapters/` (~150
lines) registering the control-plane MCP entry, installing the rendered skill
and handling sandbox specifics; adapters must not import each other. If an
adapter needs more than ~300 lines, the abstraction is wrong.

## Connector automation (`connector-setup`)

Flow: login → developer mode → delete stale connector (exact title match,
backend `DELETE aip/connectors/<id>` — "Uninstall" is not deletion) → create →
pairing → verify. Verification is real state (bridge `tokenCount` grew), not a
page badge. Safety properties: exact-title match never deletes a sibling;
never clicks Reconnect (reclaimed URLs are dead); the delete step is
best-effort — `plugins/list` 5xx is retried briefly, and a list that stays
unreadable skips cleanup (create retries under a fresh title if the old one
is reserved) instead of dead-ending the run; every failure returns a
`manualFallback` with address + pairing code + steps; only the pairing code is
ever typed into a page. Only an HTTP 409 counts as a name conflict — other
failures surface the status instead of triggering a rename. Headless Chrome is
stopped by Cloudflare Turnstile; the driver is headful on purpose.

ChatGPT has no stable test ids across locales, so every connector target holds
a candidate selector list. `awehitch connector-setup --dry-run` reports which
selector matched; overrides live in `<stateDir>/control-plane/selectors.json`
and replace a target's whole list. Error codes: `CONNECTOR_NEEDS_HUMAN`,
`CONNECTOR_DOM_CHANGED` (names the target), `CONNECTOR_PAIRING_REJECTED`,
`CONNECTOR_FAILED`.

## Security model

Trust boundaries: (1) workspace root — one bridge, one workspace, tokens bound
to `workspace_id`; (2) workspace content is untrusted (prompt injection never
grants capabilities); (3) the model never sees long-lived credentials; (4) the
ChatGPT DOM is untrusted territory — selector drift fails closed with
`CHATGPT_DOM_CHANGED`.

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | Bearer token required (401 without, 403 wrong workspace) |
| Pairing brute force | ~40-bit codes, 5 attempts, one-time, 5-min TTL, per-IP limit keyed on the unforgeable last XFF hop |
| Code interception / CSRF | PKCE S256 mandatory; one-time codes bound to client + redirect URI; `state` round-tripped |
| Token theft | Opaque high-entropy tokens, SHA-256 at rest, 1 h access TTL, rotating refresh tokens, revocation |
| Workspace traversal / symlinks | `realpath` canonicalization + containment; case-folding on macOS/Windows; rejects `..`, null bytes, backslash tricks |
| Sensitive files | Deny-by-default (`.env*`, `.envrc`, keys, SSH, cloud creds, keychains, `.git/`); reads/listings/search/diff share one gate; `.env.example` allowed |
| Oversize DoS | Line/byte caps on read/diff/search |
| Tunnel exposure | Loopback-only bind; public surface is OAuth-protected HTTPS via the tunnel |
| Admin API | Loopback + random admin token (0600 file); proxy-header requests rejected; probes get 404 |
| Unauthenticated flooding | Pending authorize pages capped (50); DCR clients capped (200, reset by `awehitch unpair`); tunnel-side registration rate limit |
| Error leakage / torn writes | Opaque JSON errors (details stay in logs); atomic temp+rename config writes; append-only upserts |
| Scope escalation | Intersection-only scope grants; all-unknown requests get `invalid_scope` |
| Log/output leakage | Redacting logger; execution output sanitized (tokens/paths redacted, private keys withheld) |

ChatGPT can never write files, delete files, run shell commands, commit, or
install packages — those tools do not exist on the server.

## Release

`awecontrib bump <version> --note "…"` edits `package.json` and prepends
`docs/CHANGELOG.md`. Release: promote `dev` → `main`, tag `v*`; CI runs verify,
extracts the release notes from the changelog section and publishes to npm.
