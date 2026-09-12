# Changelog

## Unreleased

**One ChatGPT login per machine.** The control-plane browser profile is now
shared by every workspace instead of one profile per project, so
`awehitch login` is run once, not once per workspace.

- The profile lives at `browser-profile/shared/` and is guarded by a
  cross-process lock. A genuine collision reports the holding pid and
  workspace (and stops) instead of failing with a Playwright singleton stack
  trace; a lock left by a crashed process is stolen automatically.
- A session closes the browser after a few idle minutes — while the harness
  codes, no other workspace is blocked — and relaunches it on the next tool
  call, reopening the bound conversation.
- The stdio MCP server and the CLI both multiplex tabs inside the one shared
  context, so workspaces sharing a process each keep their own tab.
- Upgrading: old per-workspace profile directories are ignored; log in once.

**`awehitch connector-setup`** — the ChatGPT connector is now created and
repaired automatically, for every harness.

Previously only Codex could do this, because it owns a built-in browser that
the original design drove through; opencode and zcode had to fall back to
teaching the user, which meant copying a public address and a pairing code by
hand. The control plane already ships a persistent, logged-in Playwright
profile, so the same flow now runs there instead:

- One command covers login → developer mode → delete stale connector →
  create → pairing code → verify. Only a login wall should interrupt the user.
- Success is verified against the bridge (`tokenCount` grew), not a DOM badge.
- Delete only ever matches a connector title **exactly** (normalized), so
  `awehitch · proj` cannot take out `awehitch · proj2`; duplicate titles stop
  the run instead of picking one.
- Never clicks Reconnect on a reclaimed address.
- Any failure returns a `manualFallback` with the real address, pairing code
  and step list, so a broken selector degrades to the old guided flow.
- `--dry-run` resolves every page element and reports which selector matched,
  changing nothing. Connector selectors join the existing override pack
  (`connector.<target>` replaces a target's candidate list).
- `awehitch doctor` now reports `chatgptSetup` (action + command) alongside
  `chatgptRepair`.
- 17 offline tests (loopback fixture, real Chromium, no network): exact-title
  safety, ambiguity refusal, honest DOM-change failure, rejected pairing code,
  login wall, and that `--dry-run` mutates nothing.

Live-verification pass against a logged-in ChatGPT (2026-09):

- The create-form and developer-mode selectors are replaced with the real
  ones (`#custom-connector-name`, `#custom-connector-url`,
  `#custom-connector-auth`, `#trust-checkbox`,
  `button[role='switch'][aria-label='Developer mode']`). The old bare
  `[role='switch']` fallback would have flipped **Lockdown mode** — the first
  switch on the Security page — instead of Developer mode.
- The delete step now opens the settings modal's connector list (the
  `/plugins` directory page never lists a workspace's own connector).
- Every step waits for a rendered-page marker; ChatGPT is a SPA and the old
  probes raced the React render and saw an empty page.
- New `confirmToggle` target handles the risk-confirmation dialog ChatGPT
  may show when Developer mode is switched on.
- Quick-tunnel start timeout raised from 45s to 90s: on lossy networks the
  QUIC handshake to the Cloudflare edge can eat half the old budget before
  the health check even begins.

Control-plane fixes from issue #1 (code review).

- **P0 — multi-line send**: `locator.type()` pressed a plain Enter per `\n`
  and ChatGPT submits on Enter, so every multi-line [C2C] message fragmented
  into several partial sends. The composer path now inserts each line with
  `insertText`, joins lines with Shift+Enter, and submits with one final
  Enter. Send confirmation reads the message back from the conversation log
  (whitespace-normalized compare) and fails loudly with `SEND_FAILED` — the
  old "composer is empty" check was a false positive after the first
  fragment. Covered by real-DOM contract tests (headless Chromium fixture).
- **waitReply timeout notes**: on timeout, a present-but-unaccepted reply is
  explained (state mismatch vs. pre-send stale reply) instead of a bare
  timeout.
- **Selector pack**: ChatGPT selectors moved out of the driver into a
  versioned declarative description — compiled defaults plus a per-key
  override file in the state dir. `awehitch doctor` reports the pack;
  `awehitch doctor --control-plane` opens the browser and probes every
  selector on the live page, naming the broken one instead of waiting for
  `CHATGPT_DOM_CHANGED` mid-task.
- Small items: profile comment now honest (user's Chrome login is NOT
  reused), MCP SDK pinned to `^1.30.0`, README clone URL fixed, upstream
  attribution added to README_cn, stale `c2c` command names and Project-era
  workflow removed from troubleshooting, handover doc archived to
  `docs/handover.md`.

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
