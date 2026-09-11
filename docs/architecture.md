# Architecture

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
              │    awemind Bridge    │
              │  MCP Server (RO)     │
              │  OAuth AS + PRM      │
              │  Pairing Manager     │
              │  Tunnel Manager      │
              │  Admin API (local)   │
              └──────────┬──────────┘
                         │  read-only
                         ▼
              ┌─────────────────────┐
              │   Local Workspace    │
              └────────────────▲────┘
                                 │ edit / shell / git / test
              ┌──────────────────┴─────────────────┐
              │  Agent (codex / opencode / zcode)  │
              └──────────────────▲─────────────────┘
                                 │ stdio MCP (4 semantic tools)
              ┌──────────────────┴─────────────────┐
              │  Control-Plane Proxy (Playwright) │  ← the new layer
              └──────────────────────────────────┘
```

## Principles

- **ChatGPT thinks. The agent works.** The bridge never re-implements a coding harness.
- **Control plane is decoupled from the harness.** The original Codex-only design
  bound the ChatGPT conversation to Codex's built-in browser
  (`setupBrowserRuntime()` / `agent.browsers.get("iab")`). awemind moves that
  into a standalone **control-plane proxy**: a local stdio MCP server wrapping
  a dedicated-profile Playwright browser. Any harness that can call tools can
  now use the whole loop — the bar drops from "has a built-in browser" to
  "can call MCP tools".
- **Semantic tools, not a raw browser.** The model never drives the browser
  directly. It gets exactly four tools (`awemind_open_chat`,
  `awemind_send_state`, `awemind_wait_reply`, `awemind_read_reply`) plus a
  read-only `awemind_chat_info`. Hard-wired rules from the original skill:
  cheap DOM polling every 20–30 s, timeout ≠ failure, one tab, never resend.
- **MCP = data plane**: ChatGPT pulls files/diffs/search results itself.
- **Read-only by design**: no write/exec tools exist at all.
- **Workspace is the security boundary**: one bridge = one workspace = one
  token audience.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | Data-plane McpServer with 9 read-only tools; stateless Streamable HTTP transport |
| `control-plane/` | **New.** Playwright driver over the ChatGPT conversation + stdio MCP server exposing the 4 semantic tools; per-workspace browser profile and chat binding |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment, sensitive-file policy, `.c2cignore`, paginated read/list, ripgrep search with Node fallback, git status/diff with pagination |
| `adapters/` | Harness integration: codex (skills dir + config.toml MCP + sandbox writable_roots), opencode (skills dir + opencode.json MCP), zcode (config.json mcpServers + skill). Thin; never import each other |
| `tunnel/` | `TunnelProvider` interface + Cloudflare Quick and workspace-configured Named Tunnel implementations |
| `execution/` | JSONL execution records plus optional sanitized command output (`execution_output`) |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `session/` | ChatGPT conversation + Project binding + resume checkpoints |
| `cli/` | `awemind` commands; `--json` everywhere for the skills |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger |

## Request lifecycles

**Data-plane MCP call**: ChatGPT → tunnel (https) → bridge `/mcp` → bearer
middleware (401/403) → stateless StreamableHTTP transport → tool handler →
workspace layer (path containment → ignore rules → pagination) → JSON result.

**Control-plane tool call**: agent → stdio MCP → control-plane server →
Playwright (dedicated profile, persistent login) → ChatGPT page DOM → JSON
reply view (`status: generating | timeout | replied`, `state` from `[C2C]`).

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens.

**Ports**: prefer 48765, bind 127.0.0.1 only. On conflict, `/health` identifies
whether the occupant is an awemind bridge for the same workspace (reuse) or
not (fall back to an ephemeral port).

**Tunnel**: default is a Cloudflare Quick Tunnel; a workspace may choose a
named hostname once. When the public address changes, doctor tells the skill
to Delete + recreate that workspace's ChatGPT connector (never Reconnect).

## Adding a new harness

Write an adapter (~150 lines or less): one file in `src/adapters/` that
registers the control-plane stdio MCP entry, installs the rendered skill
(`skill/SKILL.md.template`), and handles that harness's sandbox specifics.
Adapters must not import each other — only the shared `control-plane` and
`config` modules. If an adapter needs more than 300 lines, the abstraction is
wrong.
