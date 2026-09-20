# Changelog

## Unreleased

### Fixes
- `list_workspaces` and `workspace_info` now report each workspace's real
  absolute root (`rootPath`). Without it the model saw only opaque names
  plus the `workspace:/` alias and could not tell that a home-rooted
  workspace covers Desktop — it concluded whole subtrees were "not
  exposed" when they were fully reachable by relative path.
- The control-plane Chromium now honors the standard proxy environment
  variables (https_proxy / http_proxy / all_proxy, any case) as
  --proxy-server. On networks where chatgpt.com needs a local proxy,
  connector setup and dispatch conversation peeks used to die with
  ERR_CONNECTION_CLOSED because Chromium ignores the shell's proxy
  settings.

### Collaborative mode: hard dispatch gate
- `dispatch_agent` now verifies authorization server-side instead of
  trusting ChatGPT's parameters: before spawning, the bridge opens the
  conversation and reads the latest USER message; only a real
  @-mention of the executor there dispatches. ChatGPT writing an @
  into its task parameter, passing a harness the user did not
  mention (EXECUTOR_MISMATCH), or an agent-injected [C2C] user turn
  is refused with DISPATCH_UNAUTHORIZED; an unreadable conversation
  is refused with DISPATCH_UNVERIFIED (fail closed). Without the
  user's @, ChatGPT's only path is its own data-plane tools.

### Direct mode (pure ChatGPT)
- Token refresh now upgrades the grant to the full currently-supported
  scope set, so releases adding scopes (like `workspace.write` /
  `exec.run`) no longer force a connector re-pair: within an hour of a
  bridge upgrade the refresh picks them up on its own. The workspace's
  chatgptMode stays the real write gate. `list_workspaces` now reports
  each workspace's chatgptMode, and `awehitch status` shows the tier
  next to every registered root.
- `chatgptMode` can now be set globally in `~/.c2c.json` and applies to
  every registered workspace; a workspace's own `.c2c.json` wins when it
  sets the key, and an unset key everywhere stays `readonly`
  (`AWEHITCH_GLOBAL_CONFIG` overrides the global path for tests).
- New `chatgptMode` in `.c2c.json` with three monotonic tiers, keeping
  read-only as the default and the structural story unchanged:
  - `readonly` (default): exactly today's connector — read tools plus
    `dispatch_agent`; no write tool exists server-side.
  - `write`: adds `apply_patch` — structured, atomic, rollback-safe
    multi-file patches. Updates require `oldText` matching the current
    file exactly once (baseline check); a failing edit rejects the whole
    patch. The sensitive-file policy (`.env*`, keys, SSH, `.git/`…) and
    the workspace boundary/symlink checks cover writes too.
  - `write-exec`: adds `run_command` — argv passed straight to spawn, no
    shell (pipes, expansion, redirection structurally impossible), a
    minimal environment with no inherited secrets, network clients /
    privilege escalation / destructive system tools denied, git's network
    subcommands (push/fetch/pull/clone) denied, 60 s default timeout,
    capped output.
- New OAuth scopes `workspace.write` and `exec.run` gate the write tools;
  the workspace's `chatgptMode` is the real gate (scope granted + tier
  off = tools absent from the catalog). There is deliberately no
  dangerous tier.
- README narrative: the two "ways to work" are merged into one
  collaborative mode (either side can start); direct mode is documented
  as the opt-in pure-ChatGPT usage.
- READMEs lead with the unified @ syntax everywhere: `@chatgpt` in your
  terminal routes the thinking to ChatGPT, `@opencode` / `@codex` /
  `@zcode` in your ChatGPT conversation routes the execution to a local
  agent — an @-mention is always the user personally naming the other
  side.

### Breaking
- The lead/follow mode switch is gone. There is one way to run awehitch:
  the same bridge, tunnel and read-only connector serve both entry points —
  the agent driving per-task chats from your terminal, and you dispatching
  from your own ChatGPT conversation (bound via `awehitch_open_chat` with
  its URL). `awehitch up --mode` is removed; `.c2c.json` `mode` and
  `follow.chatWrite` are dead keys (ignored); `follow.dispatchMarker` is
  still honored as a legacy fallback, with the new top-level
  `dispatchMarker` winning. `doctor`'s `follow` report key is now `dispatch`,
  and `up --json` reports `dispatchMarker` unconditionally instead of
  `mode`/`chatWrite`. The skill template's mode-gated workflows are merged:
  binding a conversation is the only trigger for the dispatch loop.
- The background dispatch auto-watch is gone, replaced by a connector
  tool. Hands-free dispatching is now `dispatch_agent`: you @-mention an
  executor in your own message (`@opencode fix the login page`) and ChatGPT
  calls the tool; the bridge spawns the harness immediately — no polling,
  no browser opening on its own every cycle. `awehitch dispatch auto` is
  removed (`dispatch watch <url>` keeps serving one pinned conversation;
  a leftover `mode: "auto"` state reads as off). One conversation, one
  agent session: further `dispatch_agent` calls there are refused until
  the current run posts its `[C2C]` report. The new `dispatch.execute`
  scope gates the tool, so re-pair the connector once after upgrading.

### Changes
- Interactive dispatch auto-starts the task: none of the three TUIs
  (opencode/codex/zcode) accepts an initial prompt as argv, so the launch
  script now pastes the clipboard task into the freshly opened TUI and
  submits it (best effort via System Events keystrokes; when macOS denies
  that, the task stays on the clipboard and the window says so). The TUI
  runs in the background of its terminal so the conversation claim is
  still released when it exits.
- `@chatgpt` is now the explicit agent-side invitation — the twin of the
  ChatGPT-side `@agent` dispatch marker. An `@chatgpt` anywhere in the
  user's message routes that request through the awehitch skill; natural
  language ("问问 ChatGPT") keeps working.
- One ChatGPT conversation, one durable agent identity. Every dispatched
  run now receives the conversation's stable task id (`chat-<conversation
  id>`) in its prompt and binds it via `awehitch_open_chat url=… task_id=…`:
  the binding lands in `taskChats` (per-conversation, merge-safe) instead
  of overwriting the workspace-level chat pointer, and checkpoints
  (`awehitch session set --task …`) resume the same conversation across
  dispatches.
- The one-session-per-conversation registry is file-backed
  (`dispatch/sessions.json`) instead of in-memory: it survives bridge
  restarts, records the spawned run's pid (a dead pid frees the claim),
  and interactive launches claim too — their terminal script releases the
  claim when the TUI exits. A claim without a live pid is trusted for 4
  hours, any claim expires after 24; `awehitch dispatch release <url>`
  frees a stuck one manually.
- Sidebar and conversation reads wait (bounded) for their selectors: the
  ChatGPT sidebar and turns are client-rendered, and an immediate scrape
  after domcontentloaded saw nothing every time.
- Default dispatch marker changed from `@opencode` (a specific harness's
  name) to the neutral `@agent`. Existing configs that set a marker keep it;
  users relying on the old default type `@agent` from now on.

### Features
- ChatGPT can start your agent: the `dispatch_agent` connector tool (new
  `dispatch.execute` scope) spawns codex exec / opencode run /
  `zcode --prompt` non-interactively (prompt as argv, never a shell) in the
  registered workspace, with the conversation URL ChatGPT passes — or, when
  it cannot tell, one short local sidebar peek identifies the most recent
  conversation. The spawned run introduces the [C2C] protocol itself,
  executes, and reports EXECUTED back into the same conversation; a
  non-zero exit surfaces as `[C2C] BLOCKED` with the log path. The tool
  defers to conversations pinned by `awehitch dispatch watch` and enforces
  one agent session per conversation.
- Dispatch can open the agent in front of you: `awehitch dispatch launch
  interactive` switches the `dispatch_agent` tool from a background
  `opencode run` to the harness's own TUI in a new Terminal window (macOS).
  The full dispatch prompt — conversation URL plus TASK — is printed in the
  window and copied to the clipboard; the window first offers an aweswitch
  profile picker for that harness (aweswitch is a dependency: enabling
  interactive installs it via pip when missing), so a dispatched run can
  start under a profile with quota instead of the exhausted default. The
  terminal follows the user: their default terminal (the LaunchServices
  .command binding Warp/iTerm2 write), else Warp when installed, else
  Terminal.app. The
  chosen profile only affects that window (aweswitch launch mode isolates
  env; nothing is written into your agent configs); nothing reports [C2C]
  automatically (you report from that session). The prompt body only travels
  through a file, never as shell syntax. `dispatch launch headless` (the
  default) restores the background run that reports EXECUTED back into the
  conversation; the choice is machine-level state in dispatch.json and
  survives watch rewrites.
- `awehitch up` asks before gluing onto a running bridge: an interactive
  terminal now offers reuse (the default — new workspaces still register
  into the live process), restart, or quit, instead of silently streaming
  the old instance's logs. Scripts and `--json` keep the silent reuse.
- Named-tunnel startup is more honest about why it failed: the start
  timeout is raised from 45 s to 90 s (matching the quick tunnel) because
  on networks that block QUIC cloudflared's pre-check-and-fall-back-to-
  HTTP/2 path alone can take tens of seconds; and the timeout error now
  carries cloudflared's last error line (e.g. a failed QUIC dial) instead
  of a bare "timed out".
- Named tunnels can pin their edge transport: `awehitch tunnel protocol
  http2` forces cloudflared over TCP/HTTP-2. On networks that block or
  tamper with QUIC (UDP 7844) its QUIC-first retries can exceed even the
  90 s start timeout; `unset` returns to cloudflared's own choice, and
  the timeout error names this remedy when it watched QUIC dials fail.

### Features
- Parallel C2C per session, not just per harness: a second (third, …)
  instance of the same harness — two opencode windows, say — now runs its
  own ChatGPT planning loop instead of failing on the shared browser
  profile. Each harness has a small pool of browser profiles; a
  control-plane process claims a free session slot at first browser use
  (slot 0 = the harness's existing profile, extra sessions get
  `<harness>-s<k>` seeded from a logged-in profile, so still one login
  total). Leases are held for the process lifetime and stolen from dead
  holders; the pool size is `AWEHITCH_MAX_PARALLEL_SESSIONS`
  (default 2 per harness, max 16).
- Task→chat bindings are now merged under a short cross-process lock
  (`<key>.merge.lock`, stale-holder steal, 2 s deadline then proceeds) so
  concurrent same-harness sessions cannot drop each other's bindings.
- Each session's "current chat" pointer is private from slot 1 on
  (`control-plane/<key>.slot-<n>.json`): an idle-recovered session reopens
  its OWN chat and never lands in a sibling session's conversation.
  Slot 0 keeps mirroring into the shared state file, so single-session
  setups and the `awehitch session` view are unchanged.
- `awehitch_chat_info` now reports the session's slot (`session.slot`,
  `session.profile`) and resolves `chatUrl` through it.
- Profile seeding widened: a new slot profile seeds from any logged-in,
  currently-unlocked profile (master first), not only the master — a
  second opencode session starting while codex drives the master still
  gets a logged-in seed.

## v0.2.7 - 2026-09-18

### Fixes
- v0.2.6 migration adopts the legacy auth store that actually holds
  credentials (most clients + tokens; mtime only breaks ties). Every 0.2.5
  bridge start writes an auth store, so workspaces that never paired left
  empty files newer than the paired store — mtime-based selection then
  forced a re-pair on upgrade, exactly what migration was meant to avoid.
- `send_handoff`'s NO_CHECKPOINT hint for a `--task` slot now names the
  real flag (`awehitch session set --protocol-state …`, not the
  nonexistent `--checkpoint-state`), so an agent following the hint can
  actually save the checkpoint.

## v0.2.6 - 2026-09-18

### Features
- One machine, one bridge: a single awehitch service now serves every
  registered directory. Running `awehitch up -w <dir>` in a new place
  registers that directory with the running service instead of taking the
  old one over — the last-up-wins takeover (`scanForeignBridges`,
  `stoppedWorkspaces`) is gone. One machine bridge ↔ one ChatGPT
  connector, no matter how many project directories you work in.
- Multi-root ChatGPT-facing MCP: every data tool accepts an optional
  `workspace` selector (name or id), and a new `list_workspaces` tool
  enumerates the served roots. With a single registered workspace it is the
  implicit default; with several, the boot prompt asks the agent once and
  passes that name on every call. Ambiguous or unknown selectors fail fast
  (`AMBIGUOUS_WORKSPACE` / `UNKNOWN_WORKSPACE`).
- Per-task ChatGPT chats: checkpoints are stored per `(session, task)` at
  `sessions/task/<sessionKey>--<taskSlug>.json`, so concurrent same-harness
  sessions no longer overwrite each other. `awehitch session set/get/clear
  --task <id>` and the control plane's `send_handoff` `task_id` select the
  right slot — one agent task ↔ one ChatGPT conversation.
- Machine auth / pairing / tunnel / endpoint: one `auth/machine.json`, one
  `tunnels/machine.json` (`c2c-awehitch`), one `endpoints/machine.json`. A
  legacy per-workspace connector pointing at the same address is adopted by
  title so the upgrade does not orphan it in ChatGPT.
  `migrateLegacyStateToMachine()` runs on every `up`/`serve` — idempotent.
- Legacy upgrade path: a pre-0.2.6 workspace-scoped bridge found on disk is
  stopped via its own admin token and replaced. `awehitch status` reports
  `legacy_workspace_scoped` and tells the user to re-run `up`.

### Fixes
- `POST /admin/workspaces` now parses a JSON body (the admin router was
  missing `express.json`) and pushes the root into the in-memory workspace
  list based on what was already known — not on the registry write — so live
  registration by `ensureBridge` actually raises `workspaceCount`.
- `stopLegacyBridges` only stops a foreign bridge whose `/health` reports a
  workspace-scoped (pre-0.2.6) build; a healthy machine bridge is left alone.

### Documentation
- Skill template rewritten for the machine model: one service per machine
  serving all registered directories; the boot prompt asks which workspace
  once when `list_workspaces` shows several; checkpoint commands always
  carry `-H {{HARNESS_ID}} --task {{TASK_ID}}`; handoff reads from this
  task's checkpoint; the disconnect message is machine-scoped.

## v0.2.5 - 2026-09-18

### Features
- True parallel C2C: per-harness browser profile, chat bindings, and session checkpoints — multiple agents drive ChatGPT truly in parallel in one workspace
- `awehitch up` runs in the foreground by default with logs streaming to the terminal; `-d/--daemon` opts into detached background mode, and `--json` implies daemon
- One bridge per machine: running `up` from a different workspace directory gracefully stops the foreign bridge before starting a new one
- Scoped git tools (`git_status`, `git_diff`) now resolve the enclosing repo from the scoped path, so a project subdirectory with its own `.git` is diffed correctly
- Skill triggers on casual asks ("问问 ChatGPT", "ask ChatGPT", "问下 GPT"…); quick-question workflow starts the service on demand without the planning loop

### Fixes
- Chat binding is now persisted at every observable interaction point, preventing orphaned conversations when the SPA URL updates slower than the capture window
- zcode adapter writes the skill to `~/.zcode/skills` (not `~/.zcode/cli/skills`) and MCP servers to the nested `mcp.servers` key of `config.json` — zcode sessions now see the control-plane tools
- Codex TOML adapter separates the replaced MCP entry from the next table header with a trailing newline, fixing unparseable TOML that prevented codex from booting

### Documentation
- README troubleshooting documents the manual connector-setup fallback when a ChatGPT DOM change breaks automation
- Ecosystem section adds awefork, awecontrib, and AgentX to the recommended tooling list

## v0.2.3

Command surface: four user-facing verbs (up / off / doctor / tunnel), one diagnostic authority.

- **`doctor` and `tunnel` are now listed in `--help`.** They were already the
  documented first moves (README troubleshooting, `up`'s stable-hostname
  hint) — a command the surface tells humans to run must itself be visible.
- **Removed `start`, `status`, `workspace`, `update-check`.** `up` is
  idempotent and starts the bridge; `doctor --no-fix` is a strictly
  read-only superset of `status`; `workspace` reported what doctor already
  reports; `update-check` had no caller. `setup` still runs for
  already-installed skills but now points at `awehitch up`.
- Help footer now lists the remaining agent/advanced commands accurately.

## v0.2.2

Security and robustness pass from a full code review (289 tests, +35).

- **Sensitive files**: the whole `.git/` directory (remote credentials in
  `.git/config`, reflog, COMMIT_EDITMSG) and `.envrc` are now denied at the
  same gate as `.env*` — previously `.git/` was only hidden from listings.
- **codex config.toml**: the `writable_roots` upsert is quote-aware (a path
  containing `]` no longer truncates the array into invalid TOML) and
  appends without re-resolving existing entries, so a hand-written `~/data`
  survives byte-for-byte.
- **opencode home**: resolved via `OPENCODE_CONFIG_DIR` →
  `XDG_CONFIG_HOME/opencode` → `~/.config/opencode`. `OPENCODE_CONFIG` is a
  file path per opencode's docs and is no longer treated as a directory.
  `opencode.json` upserts are comment-preserving (JSONC-aware surgical edit
  of the `mcp.awehitch` key); a broken config aborts with a clear error
  instead of being clobbered.
- **Atomic config writes**: every user-owned config/state write goes through
  a temp-file + rename helper, so a crash mid-write can no longer truncate
  the file that carries the user's other MCP entries.
- **Bridge lifecycle**: `stop` verifies the pid's command line before
  killing (a reused pid can no longer kill an unrelated process; stale
  runtime files clear instead of wedging in "unknown"); concurrent `up`
  calls spawn at most one bridge (exclusive lock + re-check); the stdio
  control plane handles SIGTERM/SIGINT and releases the shared browser.
- **OAuth hardening**: unsupported scopes no longer widen into a full grant
  (intersection only, `invalid_scope` otherwise); pairing rate limiting keys
  on the unforgeable last X-Forwarded-For hop; pending authorize requests
  are capped (50) and registered DCR clients (200; `awehitch unpair`
  resets); unauthenticated registrations are rate-limited through the
  tunnel.
- **Error responses**: unhandled server errors return opaque JSON — stack
  traces and absolute paths stay in the server log.
- **CLI honesty**: `doctor --no-fix` is strictly read-only (no endpoint
  writes, no pairing codes minted) and its MCP probe is time-bounded;
  `--timeout`, `logs -n`, `record --exit-status` validate their input;
  `session set --iteration` rejects non-integers (NaN used to persist as
  null); `--json` failures always emit parseable JSON carrying the reason;
  `up --json` includes harness wiring errors.
- **Connector create**: only an HTTP 409 counts as a name conflict — any
  other failure surfaces the HTTP status instead of producing an "X 2"
  renamed connector; cloudflared login timeouts now include the login URL.
- **Connector setup resilience**: a transient 500 from ChatGPT's
  `plugins/list` no longer dead-ends the run — the query is retried
  briefly, and a list that stays unreadable skips the (optional) cleanup
  step instead of failing it; create then retries under a fresh title if
  the old name is still reserved.
- **English CLI**: progress output, errors, and help text are now English,
  matching the agent skill text.
- **Portability**: the CLI entry no longer depends on Node 20.11+
  (`import.meta.dirname`; dist preferred with a tsx dev fallback), and an
  unset `HOME` no longer probes the CWD for cloudflared.

## v0.2.1

npm distribution: `npm install -g awehitch`.

- `files` allowlist (bin / dist / skill / examples / READMEs / LICENSE) and
  `prepare`/`prepack` build hooks — the tarball ships the compiled CLI, not
  sources and tests.
- Fixed the npm-installed `bin/awehitch.js` doing nothing: it imported the
  CLI module, which bypasses the main-entry guard. It now spawns the
  compiled CLI as the Node entrypoint (verified by a packed-install smoke
  test).
- Repository moved to the `wehuman01` organization.

## v0.2.0

Two visible commands — `awehitch` connects, `awehitch off` disconnects — plus automatic connector setup and one ChatGPT login per machine.

**Two commands.** `awehitch` connects, `awehitch off` disconnects. The visible
CLI surface shrinks from 17 commands to 2; everything else still exists but is
hidden from help (already-installed skills keep working unchanged).

- `awehitch [-w <path>]` is an idempotent "make sure ChatGPT is connected":
  bridge + tunnel, harness adapter, and the ChatGPT connector — one command
  instead of `setup` → `login` → `connector-setup`. The Cloudflare
  named-tunnel question is no longer asked here; the temporary address is the
  default (`awehitch tunnel choose --mode named` still upgrades).
- Harness adapters are auto-detected from their config homes
  (`CODEX_HOME` / `OPENCODE_CONFIG` / `ZCODE_HOME`, falling back to `~/.codex`,
  `~/.config/opencode`, `~/.zcode/cli`); `--harness` overrides.
- The only human pause left is the ChatGPT login. Human mode waits for one
  Enter and retries in-process; `--json` stops with `{ok:false, needsLogin:true}`
  and exit code 0 so an agent relays exactly one action, then re-runs.
- Address changes self-heal: same address + a valid token ⇒ ChatGPT is not
  touched at all; changed address ⇒ the connector is rebuilt and the output
  says so. A rejected pairing code auto-retries once with a fresh one.
- `awehitch off` revokes tokens (live bridge, or the persisted store when no
  bridge is running) and stops the bridge, then points at the plugins page for
  optional manual deletion.
- New tests: harness auto-detection, the offline revoke path, and the help
  surface (`tests/cli-surface.test.ts`).

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
- 24 offline tests (loopback fixture, real Chromium, no network): exact-title
  safety, ambiguity refusal, honest DOM-change failure, rejected pairing code,
  login wall, conflict auto-rename, backend delete, and that `--dry-run`
  mutates nothing.

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

Second live pass (2026-09-12, real machine; connector verified end to end —
bridge `tokenCount` grew, delete+recreate closure confirmed):

- **P0 tunnel timeout root-caused and fixed**: fresh `*.trycloudflare.com`
  hostnames are NXDOMAIN-negative-cached by local resolvers (~300s), so the
  public-name health probe always failed while ChatGPT reached the tunnel
  fine. Readiness is now gated on cloudflared's local metrics `/ready`
  (`--metrics 127.0.0.1:<port>`), which needs no DNS; start completes in
  seconds. Fetch errors unwrap the undici `error.cause` chain so a future
  DNS failure names itself (`getaddrinfo ENOTFOUND ...`).
- **Delete goes through the backend**: ChatGPT's "Uninstall" only removes
  the installation — the connector object stays server-side, keeps the name
  reserved, and recreate then fails with a silent 409. The delete step lists
  `ps/plugins/list` and `DELETE`s `aip/connectors/<id>` with the session
  token, then re-lists to confirm.
- **Create conflict auto-rename**: a 409 on create retries under a fresh
  title (`X` → `X 2` → `X 3`, max 3 attempts); the final name is returned as
  `result.connectorName` and persisted for future runs.
- **Authorize path mapped**: connector row → Connection "Connect" → consent
  dialog "Sign in with <name>" → authorize page. New `connectButton` and
  `signInButton` targets. Known limitation: the automated click sequence did
  not reach the authorize page in either live run, so the step degrades to
  `manualFallback` (its values verified sufficient — a human finishes in
  under a minute); when a bridge token already exists the step is skipped
  and the run is fully automatic. Never a false success.
- Connector tests: 24 offline contract tests (loopback ChatGPT-shaped
  fixtures, real Chromium), covering conflict-rename, backend-delete safety
  (exact title only, ambiguity refusal), and the consent-dialog path.

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
