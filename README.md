<div align="center">
  <h1>awehitch: Hitch the ChatGPT Web Brain to Your Workspace</h1>
  <p><strong>ChatGPT thinks — and by default, it acts.</strong></p>
  <p>Use the ChatGPT web subscription you already pay for as a coding brain: in direct mode (the default) ChatGPT patches files and runs gated commands itself; with any coding agent (codex / opencode / zcode) it becomes the planning and review layer while the agent keeps full ownership of execution.</p>
  <p>
    <strong>English</strong> ·
    <a href="./README_cn.md">简体中文</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-0.3.2-7C3AED?style=flat-square" alt="Version">
    <img src="https://img.shields.io/badge/node-%E2%89%A520-0EA5E9?style=flat-square" alt="Node">
  </p>
  <p>
    <img src="https://img.shields.io/badge/status-alpha-c96a3d?style=flat-square" alt="Status">
    <img src="https://img.shields.io/badge/install-npm-22C55E?style=flat-square" alt="npm install">
    <img src="https://img.shields.io/badge/platform-terminal-334155?style=flat-square" alt="Platform">
  </p>
</div>

> ChatGPT thinks — and by default, it acts.

awehitch hitches the ChatGPT web app onto your machine as a coding brain. In **direct mode (the default)**, ChatGPT edits files with structured patches and runs gated commands itself, right in its own conversation; in **collaborative mode** it plans and reviews while a local agent executes. Your repository is never uploaded — ChatGPT reads exactly the lines it needs through a secure, OAuth-protected MCP connection to your workspace. No API keys, no reverse proxy.

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

No agent installed at all? That is the default experience: open your own ChatGPT conversation and just ask it to work on the connected workspace — it reads, patches and runs gated commands through the connector (direct mode, see below). Prefer an agent in the loop? Then use it normally: "@chatgpt plan XXX for me". Casual asks work too — "using ChatGPT …", "ask ChatGPT …" / "问问 ChatGPT …"; the agent starts the service on demand when it is not running.

## How it works

```
Remote brain (ChatGPT web)
      ↕  Control plane: [C2C] state messages (< 1 KB)      — collaborative mode
Control-plane proxy (local, Playwright → 8 semantic MCP tools)
      ↕  Tool calls (stdio MCP)
Local agent (codex / opencode / zcode)
      ↕  Data plane: direct-mode MCP (patches + gated commands;
         readonly when you opt out) — serves both modes
awehitch Bridge (local, workspace gateway + OAuth + tunnel)
```

- **Control plane** — the agent and ChatGPT exchange tiny structured `[C2C]` messages (`INIT → PLAN → EXECUTED → REVIEW → DONE`). A local **control-plane proxy** wraps the ChatGPT web conversation (Playwright, dedicated profile) into eight semantic tools: `awehitch_open_chat`, `awehitch_send_state`, `awehitch_send_handoff`, `awehitch_wait_reply`, `awehitch_read_reply`, `awehitch_chat_info`, plus dispatch tools `awehitch_check_dispatch` / `awehitch_wait_directive`. One chat per task: a new TASK_ID automatically opens a fresh chat, and resuming the same task (across review iterations and agent restarts) always reuses its bound chat; when the old chat is lost, `awehitch_send_handoff` composes the resume brief from the local checkpoint (never files, diffs, or logs). Cheap DOM polling (20–30 s), timeouts are not failures, one tab, never resend. This decouples the original Codex-only browser control plane from any specific harness — an agent just needs "can call tools".
- **Parallel by session** — every coding session gets its own ChatGPT conversation. Each harness has a small pool of browser profiles (seeded from the first logged-in profile, so one login covers all); a session claims a free slot at first use — slot 0 is the harness's own profile, extra concurrent sessions of the same harness (say, two opencode windows) get `<harness>-s1`, `-s2`… Task→chat bindings are merged under a short cross-process lock so a task always reopens its chat, while each session's current chat stays private. codex / opencode / zcode — and several instances of each — run planning loops at the same time. Raise the pool with `AWEHITCH_MAX_PARALLEL_SESSIONS` (default 2 per harness, max 16; each extra slot is one more Chromium window).
- **Data plane** — ChatGPT pulls files, diffs, search results, test records itself through the read tools over an OAuth 2.1 + PKCE + dynamic-client-registration tunnel, plus the direct-mode write tools `apply_patch` / `run_command` (present by default; absent only where `chatgptMode` is `readonly`) and the `dispatch_agent` tool (its own `dispatch.execute` scope) that starts a local agent when you ask for one. Independent review: after EXECUTED, ChatGPT inspects the real git diff — it never trusts "all tests passed".
- **Adapters** — codex (`~/.codex/skills` + `config.toml` MCP + sandbox writable_roots), opencode (`~/.config/opencode` skill + `opencode.json` MCP), zcode (`~/.zcode/cli/config.json` mcpServers + skill). Each is thin; none import each other.

### Direct mode (pure ChatGPT) — the default, three tiers

Out of the box, ChatGPT **acts directly**: in its own conversation it reads your workspace, edits files with structured patches and — at the default tier — runs gated commands. No local agent needed. The tier comes from `chatgptMode` (workspace `.c2c.json`, or the global `~/.c2c.json`); the default is `write-exec`. Tiers are monotonic; write tools are truthfully annotated (`readOnlyHint: false`):

| Tier | What ChatGPT can do |
| --- | --- |
| `readonly` | Read tools + `dispatch_agent`. Structurally read-only — the write tools do not exist server-side. The opt-out for observation-only. |
| `write` | Adds `apply_patch`: structured, atomic, rollback-safe multi-file patches (create / update / delete). An `update` requires `oldText` matching the current file exactly once; a stale patch is rejected whole. |
| `write-exec` (default) | Adds `run_command`: argv passed straight to spawn (no shell — pipes, expansion and redirection are structurally impossible), a minimal environment (no inherited secrets), network clients and privilege escalation denied, git's network subcommands (push/fetch/pull/clone) denied, 60 s timeout by default, capped output. |

What does not change in any tier: the sensitive-file policy (`.env*`, keys, SSH…) covers **writes** too — direct mode cannot touch them either; workspace boundaries and symlink checks stay; there is **no dangerous tier** — unlimited execution is a job for local sandboxed tools, and a remote web model deliberately does not get one. Write authority lives in your config file (never in something ChatGPT says), with matching OAuth scopes `workspace.write` / `exec.run`.

### Collaborative mode (with a local agent) — either side can start, no mode switch

The same machinery — bridge, tunnel, connector — serves one collaborative loop; which side initiates is a runtime fact, not two modes. The one invariant: **execution authority always comes from you**. Work from whichever side you like, even both at once:

- **Starting from the terminal** — you tell your coding agent "@chatgpt plan the login-page refactor" ("use ChatGPT to plan X" and other casual phrasings count too); the agent opens a per-task chat, exchanges `[C2C]` INIT → PLAN → EXECUTED → REVIEW → DONE with ChatGPT, and you watch in the terminal.
- **Starting from your own ChatGPT conversation** — you chat with ChatGPT in your own conversation (browser, desktop app — anywhere your account is logged in; the conversation is account-level). The agent binds that conversation via its `chatgpt.com/c/<id>` URL and waits with `awehitch_wait_directive`. It only acts when **your own message** carries the dispatch marker (default `@agent`) and ChatGPT answers with a `[C2C] DIRECTIVE:` — ChatGPT's text alone never authorizes execution.

Binding your conversation is all it takes — no config switch. `awehitch doctor` reports the dispatch marker.

Both sides share one @ syntax: **`@chatgpt` in your terminal hands the thinking to the brain; `@opencode` in your ChatGPT conversation hands the execution to the local agent.** An @-mention always means "the user personally named this" — on the agent side it is only a routing hint (harmless, casual phrasings accepted); on the ChatGPT side it is the one and only execution-authorization marker (strictly enforced).

No agent session needs to be running, either — ChatGPT can start one for you. In **any** of your ChatGPT conversations, @-mention an executor with a task in your own message (`@opencode fix the login page`, `@codex …`, `@zcode …`); ChatGPT then calls its `dispatch_agent` connector tool, the bridge spawns that agent in the registered workspace, and the run reports back into the same conversation for ChatGPT's review. The @-mention is a **server-enforced hard gate**: before spawning, the bridge opens the conversation and reads YOUR latest message — only a real @-mention of the executor there dispatches. An @ ChatGPT wrote into its task parameter, or its own guess that you "want execution", is refused (`DISPATCH_UNAUTHORIZED`) and it falls back to its data-plane tools (read-only or the chatgptMode tiers); an unreadable conversation is refused too (fail closed). One conversation gets one agent session — a second dispatch there is refused until the current run reports. Nothing polls in the background: the tool call is the trigger, your @-mention is the authorization. Prefer an explicit, pinned conversation with the full marker + DIRECTIVE protocol loop? `awehitch dispatch watch <url>` still does that; `dispatch stop` unpins it. The two styles coexist (the tool defers to a pinned conversation), but the safe rule stays "one executor per conversation". (When ChatGPT cannot tell which conversation it is in, the bridge identifies it with one short local peek at your recent-conversations sidebar through your own logged-in profile; no third party is involved beyond ChatGPT itself.) Prefer to see the agent run? `awehitch dispatch launch interactive` opens the harness's own TUI in a Terminal window instead of a background run — the task is printed there and copied to the clipboard, so you can pick an aweswitch profile (aweswitch is a dependency: enabling interactive installs it via pip if missing) or keep talking to the agent in that window (`dispatch launch headless` restores the reporting background run).

## Config

Per-workspace `.c2c.json`:

```jsonc
{
  "name": "my-project",            // workspace display name (connector title)
  "maxIterations": 12,             // C2C loop limit before asking the user
  "browserIdleMinutes": 10,        // close the idle control-plane browser after N minutes (default 10)
  "dispatchMarker": "@agent",      // marker in YOUR message that authorizes the
                                   //   agent when it watches your conversation
  "chatgptMode": "write-exec"      // ChatGPT direct tier: write-exec (default) / write / readonly.
                                   //   Set "readonly" to make the connector observation-only;
                                   //   write authority always lives here, never in ChatGPT's words
}
```

`chatgptMode` can also live in a global `~/.c2c.json`, applying to every registered workspace; the workspace's own `.c2c.json` takes precedence — the global value only fills in where a workspace leaves the key unset, and with neither set the tier is `write-exec`. Reconnect once (`awehitch up`) after changing either layer.

`.c2cignore` adds workspace-specific deny rules on top of the built-in sensitive-file policy (`.env*`, `.envrc`, keys, SSH, cloud credentials and the whole `.git/` directory are denied by default).

The idle browser close is deliberate: the control-plane browser is a machine-global resource, released while idle and relaunched (reopening the bound chat) on the next tool call. For a one-shot override without editing `.c2c.json`: `awehitch control-plane --browser-idle-minutes <N>`.

## Commands

```bash
awehitch up [-w <path>]    # idempotent "make sure I'm connected" (bare `awehitch` works too)
                           # foreground by default (Ctrl+C stops it); -d/--daemon for background
awehitch off               # disconnect (revoke access + stop local service; delete the ChatGPT plugin manually if desired)
awehitch status            # which awehitch service is mounted on this machine, and whether it is alive
awehitch doctor            # diagnose and auto-repair (--no-fix for a strictly read-only check)
awehitch tunnel            # inspect or choose the public connection (temporary / stable hostname)
                           # pin the transport: awehitch tunnel protocol http2 (for QUIC-hostile networks)
awehitch dispatch watch <url>  # pin one conversation (full marker + DIRECTIVE protocol loop)
awehitch dispatch stop         # unpin it (ChatGPT-side @opencode dispatching is unaffected)
```

`awehitch up [-w <path>]` automatically identifies the project, establishes a secure public connection, auto-detects installed coding agents (codex / opencode / zcode) and connects them, and opens a browser to create the ChatGPT connector when needed. The only manual step in the entire flow is logging into ChatGPT once in the popped-up window. The service runs in the foreground by default (logs in your terminal, Ctrl+C stops it); `-d/--daemon` runs it in the background with logs under the state dir. One bridge per machine: `up` in a different directory replaces the previous workspace's service. `--json` for agent use — it always runs in the background so a machine caller never blocks.

Agent/advanced commands (session / record / login / connector-setup / stop / pair / logs / …) are still available: `awehitch <command> --help`.

## Security

- One bridge per machine, serving all of its registered workspaces: running `up` in another directory only adds it to the registry, never disrupting existing work. Every token is bound to the machine's bridge. The bridge binds 127.0.0.1 only — the public surface is HTTPS via the tunnel, protected by OAuth 2.1 + PKCE with dynamic client registration.
- ChatGPT gets read scopes (`workspace.read`, `workspace.search`, `git.read`, `execution.read`, `offline_access`) plus `dispatch.execute` (only starts an agent for YOUR @-mentioned request) and — for the default direct mode — `workspace.write` / `exec.run`. Access tokens live 1 hour, refresh tokens rotate on every use, and only SHA-256 hashes are stored. The real gate is always the workspace's `chatgptMode`: with an explicit `"readonly"`, the write tools are absent from the catalog even with the scopes granted. Token refresh keeps the grant up to date with the scopes the server supports, so upgrades ship without re-pairing the connector.
- Sensitive files (`.env*`, `.envrc`, keys, SSH, cloud credentials, the whole `.git/` directory…) are denied at every gate — reads, listings, search, diff and **writes** alike. `.env.example` is allowed; add your own rules via `.c2cignore`.
- Pairing codes: ~40 bits, 5 attempts, one-time, 5-minute TTL, per-IP rate limit.
- Collaborative-mode dispatch is a hard constraint: `dispatch_agent` only spawns after the bridge reads your own latest message and finds the executor @-mentioned there (an agent-injected [C2C] turn never counts); unreadable means no dispatch (fail closed). Without your @, ChatGPT can only work with its data-plane tools.
- In every tier the only write paths are `apply_patch` (structured, atomic, baseline-checked, sensitive files still denied) and `run_command` (no shell, minimal environment, network/privilege/destructive commands denied) — no other write surface exists server-side, and there is no unlimited dangerous tier. Want ChatGPT observation-only? Set `"chatgptMode": "readonly"` and the write tools vanish from the catalog entirely. `dispatch_agent` only starts a coding agent for a task the user @-mentioned; it takes no shell command.

## Troubleshooting

First move, always: `awehitch doctor` (it repairs what it can; `--no-fix` is strictly read-only).

- **Bridge not running** — run `awehitch up` (doctor starts it too); logs via `awehitch logs --verbose`. If doctor says the state is *uncertain*, wait and re-run — do not start a second bridge.
- **Address expired / connector broken** — doctor sets `chatgptRepair.needed`: **Delete** this workspace's connector and create it again with the new address. Never click Reconnect — the old URL is dead.
- **Connector setup automation fails (`CONNECTOR_DOM_CHANGED`)** — the ChatGPT page changed under us. `awehitch up` then prints the exact manual steps (developer mode, delete the stale connector, create form with name and server URL, pairing code): follow them in your browser, then re-run `awehitch up`. Prefer never opening the setup browser at all: `awehitch prefs set --setup-mode manual` makes `up` and `connector-setup` print the guided steps (for your own logged-in browser) instead of launching one. To see which page element stopped resolving first: `awehitch connector-setup --dry-run`.
- **`plugins/list` answered HTTP 5xx during connector setup** — a transient ChatGPT backend hiccup; the cleanup step retries on its own and skips itself if the list stays down, so setup continues. If a stale same-name connector lingers afterwards, rerun once to clean it up.
- **Pairing code invalid** — codes are one-time and expire in ~5 minutes: `awehitch pair` mints a fresh one.
- **401 on every tool call** — the token expired and refresh failed: authorize again in ChatGPT with a fresh pairing code.
- **cloudflared missing** — `brew install cloudflared` (macOS) / `winget install Cloudflare.cloudflared` (Windows); custom location via `AWEHITCH_CLOUDFLARED_PATH`.
- **Named tunnel start timed out, errors mention QUIC** — this network blocks or tampers with UDP 7844, so cloudflared's QUIC-first dials never register within the start timeout. Pin the TCP transport: `awehitch tunnel protocol http2`, then `awehitch up` again (the timeout error itself names this remedy when it watched QUIC fail).
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
