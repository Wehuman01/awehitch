# Troubleshooting

First move, always:

```
awehitch doctor
```

It checks Node, workspace, bridge, MCP, OAuth and tunnel — and repairs what it
can (restarts the bridge, restarts the tunnel) without asking. Pass
`--no-fix` for a strictly read-only diagnosis (no files written, no pairing
codes minted).

## Common situations

### "Bridge is not running"
`awehitch start` (or let doctor do it). Bridge logs:
`awehitch logs`, or verbose: `awehitch logs --verbose`.

If doctor says the bridge state is **uncertain**, do not start a
second bridge and do not Delete the ChatGPT connector. Wait and run doctor
again. The local process may still be running. (A runtime file whose pid was
reused by an unrelated process used to wedge here forever; such stale files
are now detected by a process-identity check and cleared automatically.)

### Everything was quit and ChatGPT can no longer connect
Quitting Codex / the terminal stops the public address. The next `awehitch doctor`
starts a new address and sets `chatgptRepair.needed`. The Skill should tell the
user that the old address expired, then **Delete** THIS workspace's
connector (`chatgptRepair.connectorName`) and create it again with the new
address (never click Reconnect — the old URL is dead). Other workspaces keep
their own connectors so two projects can stay connected at once.

Fixed ChatGPT pages for first-time setup and later repair (do not hunt the UI):

- Developer mode: https://chatgpt.com/#settings/Security
- Plugins hub (manage existing connectors): https://chatgpt.com/plugins
- Add a connector:
  https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

### Tunnel URL unreachable / ChatGPT says the connector is broken
Same as above: `awehitch doctor`, then Delete + recreate THIS workspace's
connector if `chatgptRepair.needed`. Fresh pairing code: `awehitch pair`.
If this workspace uses a stable hostname, doctor sets `namedRepair` instead —
re-login to Cloudflare (`awehitch tunnel login`) and doctor again. Do not Delete
the connector; the address did not change.

### I have a Cloudflare domain and want a stable hostname
During first-time setup (or the next coding session, once), say you have a
Cloudflare account and give the domain. Codex opens a browser for Cloudflare
login, then keeps `c2c-<project>.your-domain.com`. To stay on the temporary
address, say you do not have a domain. Switching later: tell Codex you want
the stable hostname; it runs `awehitch tunnel choose --mode named --zone <domain>`.

### "Pairing code invalid/expired"
Pairing codes are one-time and expire after ~5 minutes:

```
awehitch pair
```

generates a fresh one (older codes become invalid immediately).

### ChatGPT gets 401 on every tool call
The access token expired and refresh failed (e.g. after `awehitch unpair` or a
long offline period). Delete THIS workspace's connector if the address also
changed; otherwise run Authorize again in ChatGPT and enter a fresh pairing
code. Never use Reconnect when the public address has been replaced.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.
If cloudflared is installed in a custom location that is not on `PATH`, set
`AWEHITCH_CLOUDFLARED_PATH` to the executable's absolute path before running
`awehitch`.

### Every new Codex chat “repairs” the connection / cannot write logs
The C2C state directory lives outside the project (macOS:
`~/Library/Application Support/awehitch`; Windows:
`%LOCALAPPDATA%\awehitch`). Codex's default sandbox cannot write
there, so each new chat looks like a health-check failure.

The default `awehitch` command, `awehitch doctor` and `awehitch sandbox-allow`
add that directory to
`[sandbox_workspace_write].writable_roots` in `~/.codex/config.toml`
(`%USERPROFILE%\.codex\config.toml` on Windows). After that, later chats
do not need elevation.

### Port already in use
Handled automatically: an existing healthy bridge for the same workspace is
reused; anything else makes the bridge pick a free port. Configuration follows
automatically.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env*`, `.envrc`, `.git/` (remote credentials live in
`.git/config`), keys, credentials and anything matched by
`.c2cignore` are never readable through ChatGPT. `.env.example` is allowed.

### The task's ChatGPT chat is gone (404) or lags
One chat per task. Open a replacement with `awehitch_open_chat` for that
`task_id` and `fresh=true`, then send the boot prompt and
`awehitch_send_handoff` (composed from the session checkpoint). Resume the
protocol from the checkpoint state — do not restart the task.

### Each new workspace asks me to log in to ChatGPT again
Fixed: the control-plane browser uses ONE shared profile for every workspace
on the machine. Log in once with `awehitch login -w <workspace>`; every other
workspace reuses it.

The shared profile can be held by only one process at a time. Sessions close
the browser after a few idle minutes and relaunch it when needed; a genuine
collision reports the holding pid and workspace instead of a Playwright stack
trace. Upgrading from a pre-sharing version: old per-workspace profiles under
`browser-profile/` are ignored — log in once.

### Completely stuck
```
awehitch stop -w <workspace>
awehitch up -w <workspace>
```

re-creates the bridge, tunnel and pairing session from scratch. Use
`awehitch off` instead of `stop` only for a full disconnect — it also revokes
ChatGPT's tokens.
