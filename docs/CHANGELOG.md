# Changelog

## v0.1.1

Task-scoped ChatGPT conversations with automatic HANDOFF.

Task-scoped ChatGPT conversations with automatic HANDOFF.

- **One chat per task**: `awehitch_open_chat` takes a `task_id`. A new task
  opens a fresh chat and binds it; resuming the same task (review iterations,
  agent restarts) always reopens that bound chat. `fresh=true` forces a
  replacement chat when the old one is lost or the user asks. Bindings live
  in control-plane state (`taskChats`); legacy workspace-level sessions are
  still honored for the checkpoint's task.
- **Automatic HANDOFF**: new tool `awehitch_send_handoff` composes the
  `[C2C] STATE: HANDOFF` brief from the session checkpoint (goal, progress,
  state, issues, next step — byte-budgeted, never files/diffs/logs) and
  sends it to the currently open replacement chat. Fails with
  `NO_CHECKPOINT` when there is nothing to resume.
- `awehitch_chat_info` accepts `task_id` to look up a task's bound chat.
- Docs/skill updated to the task-scoped model; legacy long-chat/project
  fields remain readable but are no longer part of the flow.

## v0.1.0

Initial release: awehitch — hitch the ChatGPT web brain to any coding agent
(codex / opencode / zcode), with execution owned entirely
by the local agent. Forked in spirit from `codex-with-chatgpt` (Codex-only);
the data plane is reused as-is, the control plane is rebuilt as a
harness-independent proxy.

### Highlights

- **Data plane (unchanged security model)**: read-only 9-tool MCP bridge
  over OAuth 2.1 + PKCE + dynamic client registration, one workspace = one
  bridge = one token audience, sensitive-file deny-by-default, `.c2cignore`,
  Cloudflare Quick/Named tunnels. All 170 upstream tests carried over and
  passing.
- **Control-plane proxy (new)**: local stdio MCP server wrapping a
  dedicated-profile Playwright browser; four semantic tools
  (`awehitch_open_chat`, `awehitch_send_state`, `awehitch_wait_reply`,
  `awehitch_read_reply`) + `awehitch_chat_info`. Cheap 20–30 s DOM polling,
  timeout ≠ failure, one tab, [C2C] message validation (< 1 KB).
- **Harness adapters (new)**: codex (`skills` + `config.toml` MCP +
  sandbox `writable_roots`), opencode (`skills` + `opencode.json` MCP,
  JSONC-preserving upsert), zcode (`config.json` `mcpServers` merge + skill).
  Thin, isolated, idempotent; never import each other.
- **Unified CLI**: `awehitch setup --harness <codex|opencode|zcode>`,
  `awehitch status`, `awehitch doctor` (+ bridge/session/tunnel/pair/record),
  `--json` on every command.
- 188 tests total (170 carried over + 18 new for the control plane and
  adapters).
