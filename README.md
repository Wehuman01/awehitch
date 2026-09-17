<div align="center">
  <h1>awehitch: Hitch the ChatGPT Web Brain to Any Coding Agent</h1>
  <p><strong>ChatGPT thinks. Your agent works.</strong></p>
  <p>Use the ChatGPT web subscription you already pay for as the planning and review layer — while any coding agent (codex / opencode / zcode) keeps full ownership of execution.</p>
  <p>
    <strong>English</strong> ·
    <a href="./README_cn.md">简体中文</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-0.2.1-7C3AED?style=flat-square" alt="Version">
    <img src="https://img.shields.io/badge/node-%E2%89%A520-0EA5E9?style=flat-square" alt="Node">
  </p>
  <p>
    <img src="https://img.shields.io/badge/status-alpha-c96a3d?style=flat-square" alt="Status">
    <img src="https://img.shields.io/badge/install-npm-22C55E?style=flat-square" alt="npm install">
    <img src="https://img.shields.io/badge/platform-terminal-334155?style=flat-square" alt="Platform">
  </p>
</div>

> ChatGPT thinks. Your agent works.

awehitch hitches the ChatGPT web app onto any coding agent as its external brain: ChatGPT plans and reviews, the local agent executes. Your repository is never uploaded — ChatGPT reads exactly the lines it needs through a secure, OAuth-protected, **read-only** MCP connection to your workspace. No API keys, no reverse proxy.

## Install

```bash
npm install -g awehitch
```

Or from source:

```bash
git clone https://github.com/wehuman01/awehitch.git awehitch
cd awehitch
corepack pnpm install && corepack pnpm build
```

Requirements: Node.js >= 20, git. `cloudflared` for the public connection (auto-detected). A Chrome-based browser for the control plane.

## Quick Start

Tell your coding agent (codex / opencode / zcode):

```text
Please run awehitch and set it up for me automatically.
```

Or run the CLI yourself:

```bash
awehitch up -w /path/to/project
```

Pairing and connector creation are fully automatic. The only action that may need you: logging in to ChatGPT in the popped-up window. After setup, everyday use requires zero commands.

Then use your agent normally: "Plan XXX for me using ChatGPT".

## How it works

```
远端大脑（ChatGPT 网页）
      ↕  控制面：[C2C] 状态消息（<1 KB）
控制面代理（本地，Playwright → 5 个语义化 MCP 工具）
      ↕  工具调用（stdio MCP）
本地 Agent（codex / opencode / zcode）
      ↕  数据面：只读 MCP
awehitch Bridge（本地，工作区只读网关 + OAuth + 隧道）
```

- **Control plane** — the agent and ChatGPT exchange tiny structured `[C2C]` messages (`INIT → PLAN → EXECUTED → REVIEW → DONE`). A local **control-plane proxy** wraps the ChatGPT web conversation (Playwright, dedicated profile) into five semantic tools: `awehitch_open_chat`, `awehitch_send_state`, `awehitch_send_handoff`, `awehitch_wait_reply`, `awehitch_read_reply`. One chat per task: a new TASK_ID automatically opens a fresh chat, and resuming the same task (across review iterations and agent restarts) always reuses its bound chat; when the old chat is lost, `awehitch_send_handoff` composes the resume brief from the local checkpoint (never files, diffs, or logs). Cheap DOM polling (20–30 s), timeouts are not failures, one tab, never resend. This decouples the original Codex-only browser control plane from any specific harness — an agent just needs "can call tools".
- **Data plane** — ChatGPT pulls files, diffs, search results, test records itself through 9 read-only tools over an OAuth 2.1 + PKCE + dynamic-client-registration tunnel. Independent review: after EXECUTED, ChatGPT inspects the real git diff — it never trusts "all tests passed".
- **Adapters** — codex (`~/.codex/skills` + `config.toml` MCP + sandbox writable_roots), opencode (`~/.config/opencode` skill + `opencode.json` MCP), zcode (`~/.zcode/cli/config.json` mcpServers + skill). Each is thin; none import each other.

## Config

Per-workspace `.c2c.json`:

```jsonc
{
  "name": "my-project",      // workspace display name (connector title)
  "maxIterations": 12        // C2C loop limit before asking the user
}
```

`.c2cignore` adds workspace-specific deny rules on top of the built-in sensitive-file policy (`.env*`, `.envrc`, keys, SSH, cloud credentials and the whole `.git/` directory are denied by default).

## Commands

```bash
awehitch up [-w <path>]    # idempotent "make sure I'm connected" (bare `awehitch` works too)
awehitch off               # disconnect (revoke access + stop local service; delete the ChatGPT plugin manually if desired)
```

`awehitch up [-w <path>]` automatically identifies the project, establishes a secure public connection, auto-detects installed coding agents (codex / opencode / zcode) and connects them, and opens a browser to create the ChatGPT connector when needed. The only manual step in the entire flow is logging into ChatGPT once in the popped-up window. `--json` for agent use.

Internal/advanced commands (start / stop / status / doctor / pair / tunnel / session / …) are still available: `awehitch <command> --help`.

## Security

- One bridge serves exactly one workspace; every token is bound to it. The bridge binds 127.0.0.1 only — the public surface is HTTPS via the tunnel, protected by OAuth 2.1 + PKCE with dynamic client registration.
- ChatGPT gets read-only scopes only (`workspace.read`, `workspace.search`, `git.read`, `execution.read`, `offline_access`). Access tokens live 1 hour, refresh tokens rotate on every use, and only SHA-256 hashes are stored.
- Sensitive files (`.env*`, `.envrc`, keys, SSH, cloud credentials, the whole `.git/` directory…) are denied at every gate — reads, listings, search and diff. `.env.example` is allowed; add your own rules via `.c2cignore`.
- Pairing codes: ~40 bits, 5 attempts, one-time, 5-minute TTL, per-IP rate limit.
- ChatGPT can never write files, delete files, run shell commands, commit, or install packages — those tools do not exist on the server.

## Troubleshooting

First move, always: `awehitch doctor` (it repairs what it can; `--no-fix` is strictly read-only).

- **Bridge not running** — `awehitch start`, or let doctor do it; logs via `awehitch logs --verbose`. If doctor says the state is *uncertain*, wait and re-run — do not start a second bridge.
- **Address expired / connector broken** — doctor sets `chatgptRepair.needed`: **Delete** this workspace's connector and create it again with the new address. Never click Reconnect — the old URL is dead.
- **`plugins/list` answered HTTP 5xx during connector setup** — a transient ChatGPT backend hiccup; the cleanup step retries on its own and skips itself if the list stays down, so setup continues. If a stale same-name connector lingers afterwards, rerun once to clean it up.
- **Pairing code invalid** — codes are one-time and expire in ~5 minutes: `awehitch pair` mints a fresh one.
- **401 on every tool call** — the token expired and refresh failed: authorize again in ChatGPT with a fresh pairing code.
- **cloudflared missing** — `brew install cloudflared` (macOS) / `winget install Cloudflare.cloudflared` (Windows); custom location via `AWEHITCH_CLOUDFLARED_PATH`.
- **ACCESS_DENIED_SENSITIVE_FILE** — working as intended (see Security).
- **Completely stuck** — `awehitch stop -w <path>` then `awehitch up -w <path>` rebuilds bridge, tunnel and pairing. Use `awehitch off` only for a full disconnect — it also revokes ChatGPT's tokens.

## Development

```bash
corepack pnpm install
corepack pnpm build     # -> dist/, exposes the awehitch bin
corepack pnpm test      # path security, OAuth, pairing, MCP e2e, adapters, connector setup
```

Architecture, the [C2C] protocol, harness adapters, the connector automation and the full security model live in [CONTRIBUTING.md](docs/CONTRIBUTING.md).

## Status & disclaimer

Alpha. The control plane depends on the current ChatGPT DOM; when it changes, `awehitch_wait_reply` fails honestly with `CHATGPT_DOM_CHANGED` — run `awehitch doctor --control-plane` to pinpoint the broken selector, or fix it via a selector override file in the state dir. The connector pages use the same pack: `awehitch connector-setup --dry-run` reports which connector selectors resolved, and anything missing degrades to a guided manual setup rather than a failure. Not affiliated with or endorsed by OpenAI.

Data plane adapted from [codex-with-chatgpt](https://github.com/mugpeng/codex-with-chatgpt) (forked from [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)) — MIT.

## License

[MIT](LICENSE)
