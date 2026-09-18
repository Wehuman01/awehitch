<div align="center">
  <h1>awehitch: Hitch the ChatGPT Web Brain to Any Coding Agent</h1>
  <p><strong>ChatGPT thinks. Your agent works.</strong></p>
  <p>Use the ChatGPT web subscription you already pay for as the planning and review layer — while any coding agent (codex / opencode / zcode) keeps full ownership of execution.</p>
  <p>
    <strong>English</strong> ·
    <a href="./README_cn.md">简体中文</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-0.2.7-7C3AED?style=flat-square" alt="Version">
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
git clone https://github.com/Wehuman01/awehitch.git awehitch
cd awehitch
corepack pnpm install && corepack pnpm build
```

Requirements: Node.js >= 20, git. `cloudflared` for the public connection (auto-detected). A Chrome-based browser for the control plane.

## Quick Start

Recommended: hang **one** awehitch on your home directory. Every project under it just works — no per-project setup.

```bash
cd ~
awehitch up
```

`up` runs in the **foreground**: service logs stream right into your terminal and `Ctrl+C` stops awehitch. Prefer a background daemon? `awehitch up -d` — logs then go to `~/Library/Application Support/awehitch/logs/` (`awehitch logs` reads them back).

One connector now covers everything under your home directory. The sensitive-file policy still denies `.env*`, keys, SSH and cloud credentials; add your own denials in `~/.c2cignore`. Projects that are their own git repos get independent diff review automatically — ChatGPT scopes git tools to the project directory. Want a tighter boundary instead? Connect a single directory with `awehitch up -w /path/to/project`.

Or let your coding agent (codex / opencode / zcode) do it:

```text
Please run awehitch and set it up for me automatically.
```

Pairing and connector creation are fully automatic. The only action that may need you: logging in to ChatGPT in the popped-up window. After setup, everyday use requires zero commands.

Then use your agent normally: "Plan XXX for me using ChatGPT". Casual asks work too — "ask ChatGPT …" / "问问 ChatGPT …"; the agent starts the service on demand when it is not running.

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
- **Parallel by harness** — every harness gets its own ChatGPT browser profile (seeded from the first logged-in profile, so one login covers all), its own chat bindings and its own C2C checkpoint. codex / opencode / zcode can therefore run planning loops at the same time; contention only remains between two sessions of the *same* harness.
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
                           # foreground by default (Ctrl+C stops it); -d/--daemon for background
awehitch off               # disconnect (revoke access + stop local service; delete the ChatGPT plugin manually if desired)
awehitch status            # which awehitch service is mounted on this machine, and whether it is alive
awehitch doctor            # diagnose and auto-repair (--no-fix for a strictly read-only check)
awehitch tunnel            # inspect or choose the public connection (temporary / stable hostname)
```

`awehitch up [-w <path>]` automatically identifies the project, establishes a secure public connection, auto-detects installed coding agents (codex / opencode / zcode) and connects them, and opens a browser to create the ChatGPT connector when needed. The only manual step in the entire flow is logging into ChatGPT once in the popped-up window. The service runs in the foreground by default (logs in your terminal, Ctrl+C stops it); `-d/--daemon` runs it in the background with logs under the state dir. One bridge per machine: `up` in a different directory replaces the previous workspace's service. `--json` for agent use — it always runs in the background so a machine caller never blocks.

Agent/advanced commands (session / record / login / connector-setup / stop / pair / logs / …) are still available: `awehitch <command> --help`.

## Security

- One bridge per machine, serving exactly one workspace: running `up` for a different directory stops the previous bridge and switches. Every token is bound to the active workspace. The bridge binds 127.0.0.1 only — the public surface is HTTPS via the tunnel, protected by OAuth 2.1 + PKCE with dynamic client registration.
- ChatGPT gets read-only scopes only (`workspace.read`, `workspace.search`, `git.read`, `execution.read`, `offline_access`). Access tokens live 1 hour, refresh tokens rotate on every use, and only SHA-256 hashes are stored.
- Sensitive files (`.env*`, `.envrc`, keys, SSH, cloud credentials, the whole `.git/` directory…) are denied at every gate — reads, listings, search and diff. `.env.example` is allowed; add your own rules via `.c2cignore`.
- Pairing codes: ~40 bits, 5 attempts, one-time, 5-minute TTL, per-IP rate limit.
- ChatGPT can never write files, delete files, run shell commands, commit, or install packages — those tools do not exist on the server.

## Troubleshooting

First move, always: `awehitch doctor` (it repairs what it can; `--no-fix` is strictly read-only).

- **Bridge not running** — run `awehitch up` (doctor starts it too); logs via `awehitch logs --verbose`. If doctor says the state is *uncertain*, wait and re-run — do not start a second bridge.
- **Address expired / connector broken** — doctor sets `chatgptRepair.needed`: **Delete** this workspace's connector and create it again with the new address. Never click Reconnect — the old URL is dead.
- **Connector setup automation fails (`CONNECTOR_DOM_CHANGED`)** — the ChatGPT page changed under us. `awehitch up` then prints the exact manual steps (developer mode, delete the stale connector, create form with name and server URL, pairing code): follow them in your browser, then re-run `awehitch up`. Prefer being guided every time: `awehitch prefs set --setup-mode manual`. To see which page element stopped resolving first: `awehitch connector-setup --dry-run`.
- **`plugins/list` answered HTTP 5xx during connector setup** — a transient ChatGPT backend hiccup; the cleanup step retries on its own and skips itself if the list stays down, so setup continues. If a stale same-name connector lingers afterwards, rerun once to clean it up.
- **Pairing code invalid** — codes are one-time and expire in ~5 minutes: `awehitch pair` mints a fresh one.
- **401 on every tool call** — the token expired and refresh failed: authorize again in ChatGPT with a fresh pairing code.
- **cloudflared missing** — `brew install cloudflared` (macOS) / `winget install Cloudflare.cloudflared` (Windows); custom location via `AWEHITCH_CLOUDFLARED_PATH`.
- **ACCESS_DENIED_SENSITIVE_FILE** — working as intended (see Security).
- **Completely stuck** — `awehitch stop -w <path>` then `awehitch up -w <path>` rebuilds bridge, tunnel and pairing. Use `awehitch off` only for a full disconnect — it also revokes ChatGPT's tokens.

## Awesome Ecosystem

awehitch is part of a growing family of "awesome" tools — CLI-first, local-first, and operable by AI agents.

### CLI Tools

- **[aweskill](https://aweskill.wehuman.top/)** — CLI-first skill package manager supporting 48+ AI coding agents.
- **[aweswitch](https://github.com/wehuman01/aweswitch)** — Agent profile switcher for Claude Code, Codex, and OpenCode.
- **[awerouter](https://github.com/wehuman01/awerouter)** — Smart router that splits requests between Flash and Pro models using structural signals, cutting unnecessary model spend.
- **[awecompress](https://github.com/wehuman01/awecompress)** — Transparent context-compression proxy for coding agents: frozen summaries for long sessions, stackable with awerouter.
- **[aweshelf](https://github.com/wehuman01/aweshelf)** — Bookmark, categorize, and restore AI coding sessions; pairs with aweswitch to save profiles and launch with one command.
- **[aweshare](https://github.com/wehuman01/aweshare)** — Share local Ollama/vLLM backends, domestic coding plans, or authorized OpenAI/Anthropic subscriptions through a self-hosted hub — a sharing economy for tokens.
- **[awewarm](https://github.com/wehuman01/awewarm)** — Subscription window warmer that keeps AI coding-plan windows active, for local setups and through a remote hub server.
- **[awewarm-hub](https://github.com/wehuman01/awewarm-hub)** — Multi-tenant hub server for awewarm: invites, tenant capacity limits, and shared warm-up windows.
- **[awescholar](https://github.com/wehuman01/awescholar)** — AI-agent-operable scientific literature discovery and curation. Search, annotate, filter, and report on academic papers.
- **[awecontrib](https://github.com/wehuman01/awecontrib)** — One verify entry per repo: writes a small `verify` file and a minimal CI, so local and CI run the exact same checks.

### Desktop Apps

- **[awefork](https://github.com/wehuman01/awefork)** — Desktop workbench that turns AI coding-agent sessions into a tree: fork any turn, keep every branch. Pairs with aweswitch — launch a session with a profile, then fork its history.
- **[awedot](https://awedot.wehuman.top/)** — A floating orb at your screen edge keeps track of the current AI session: bookmark it in one click, resume anytime, and pair with aweswitch to pin the agent's config (e.g., relaunch with the GLM model).

### Project Collections

- **[Awesome AI Meets Biology](https://github.com/Webioinfo01/Awesome-AI-Meets-Biology)** — A curated survey of AI applications in biology, bioinformatics, and biomedical research. Powered by awescholar.
- **[Awesome AI Virtual Tumor](https://github.com/Webioinfo01/Awesome-AI-Virtual-Tumor)** — A curated collection of state-of-the-art AI systems for virtual tumor modeling and simulation: static models, dynamic models, agents, benchmarks, and reviews.
- **[AgentX](https://github.com/Webioinfo01/agentx-hub)** — A community directory of scientific research AI agents: verified-run reviews, live GitHub metrics, and monthly reports, curated through awescholar's validated pipeline.

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
