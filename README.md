<div align="center">
  <h1>awehitch: Hitch the ChatGPT Web Brain to Any Coding Agent</h1>
  <p><strong>ChatGPT thinks. Your agent works.</strong></p>
  <p>Use the ChatGPT web subscription you already pay for as the planning and review layer — while any coding agent (codex / opencode / zcode) keeps full ownership of execution.</p>
  <p>
    <strong>English</strong> ·
    <a href="./README_cn.md">简体中文</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-0.1.0-7C3AED?style=flat-square" alt="Version">
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
git clone <this repo> awehitch
cd awehitch
corepack pnpm install && corepack pnpm build
```

Requirements: Node.js >= 20, git. `cloudflared` for the public connection (auto-detected). A Chrome-based browser for the control plane.

## Quick Start

Tell your coding agent (codex / opencode / zcode):

```text
请帮我完整安装并配置 awehitch，全程自动。
```

Or run the CLI yourself:

```bash
awehitch setup -w /path/to/project --harness codex --json
awehitch login -w /path/to/project        # log in to ChatGPT once in the opened window
```

`setup --harness` wires everything: the bridge, the secure tunnel, a pairing code, and the adapter for that harness (MCP registration + skill installation + sandbox tweaks). Then use your agent normally: "用 ChatGPT 帮我规划 XXX".

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

`.c2cignore` adds workspace-specific deny rules on top of the built-in sensitive-file policy (`.env*`, keys, SSH, cloud credentials are denied by default).

## Commands

```bash
awehitch setup -w <workspace> [--harness codex|opencode|zcode] [--json]
awehitch start | stop | restart -w <workspace>
awehitch status -w <workspace> [--json]
awehitch doctor -w <workspace> [--json]      # diagnose + auto-repair
awehitch login -w <workspace> [--json]       # control-plane ChatGPT login
awehitch pair | unpair -w <workspace>        # pairing codes / revoke all tokens
awehitch session get|set|clear -w <workspace> # conversation + checkpoint state
awehitch sandbox-allow [--json]              # codex writable_roots (idempotent)
```

All commands support `--json`. Internal: `serve`, `control-plane` (stdio MCP), `record`, `update-check`.

## Development

```bash
corepack pnpm install
corepack pnpm build     # -> dist/, exposes the awehitch bin
corepack pnpm test      # 196 tests: path security, OAuth, pairing, MCP e2e, adapters
```

Docs: [architecture](docs/architecture.md) · [protocol](docs/protocol.md) · [security](docs/security.md) · [harness capability matrix](docs/harness-matrix.md)

## Status & disclaimer

Alpha. The control plane depends on the current ChatGPT DOM; when it changes, `awehitch_wait_reply` fails honestly with `CHATGPT_DOM_CHANGED` — run doctor, fix selectors. Not affiliated with or endorsed by OpenAI.

Data plane adapted from [codex-with-chatgpt](https://github.com/mugpeng/codex-with-chatgpt) (forked from [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)) — MIT.

## License

[MIT](LICENSE)
