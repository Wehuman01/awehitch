import { Command, InvalidArgumentError } from "commander";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { findBridgeObservation, findLiveBridge, readLegacyRuntimeStates, type RuntimeState } from "../bridge/runtime.js";
import {
  adminFetch,
  bridgeLogPath,
  ensureBridge,
  followLogFile,
  stopBridge,
  stopBridgeAndWait,
} from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { readRegistryRoots } from "../workspace/registry.js";
import { AuthStore } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
  suggestedMachineHostname,
} from "../tunnel/named-provision.js";
import { parseZoneInput } from "../tunnel/hostname.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  NAMED_REPAIR_MESSAGE,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
  writeTunnelState,
} from "../tunnel/state.js";
import type { TunnelProtocol } from "../tunnel/provider.js";
import { Logger } from "../logger/index.js";
import { getStateDir, parseHarnessKey } from "../config/paths.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import { mergeUiPrefs, readUiPrefs, SETUP_MODES, type SetupMode } from "../config/ui-prefs.js";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  connectorAction,
  connectorNameFor,
  legacyEndpointForMcpUrl,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { migrateLegacyStateToMachine } from "../config/migrate.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import {
  clearChatPointer,
  mergeSession,
  readSession,
  readTaskSession,
  resolveConversation,
  taskSessionFile,
  writeSession,
  writeTaskSession,
  PROTOCOL_STATES,
  WAITING_FOR,
  type ConversationMode,
  type ProtocolState,
  type WaitingFor,
} from "../session/state.js";
import { appendExecutionRecord } from "../execution/records.js";
import { saveExecutionOutput } from "../execution/output.js";
import { runStdioServer } from "../control-plane/server.js";
import { ControlPlaneBrowser, interactiveLogin } from "../control-plane/browser.js";
import { resolveDispatchMarker } from "../control-plane/dispatch.js";
import { normalizeChatUrl } from "../control-plane/state.js";
import { readDispatchWatch, writeDispatchWatch, readLaunchStyle, writeLaunchStyle, type DispatchLaunchStyle } from "../dispatch/state.js";
import { ensureAweswitch } from "../dispatch/interactive.js";
import { DispatchWatcher } from "../dispatch/watcher.js";
import { createDispatchToolHandler, defaultDispatchToolDeps } from "../dispatch/tool.js";
import { activeSession, releaseConversation } from "../dispatch/spawn.js";
import {
  manualConnectorFallback,
  runConnectorSetup,
  type ConnectorManualFallback,
  type ConnectorSetupResult,
  type ConnectorStep,
} from "../control-plane/connector.js";
import { loadSiteSelectors, probeSelectors, type SelectorProbe } from "../control-plane/selectors.js";
import { HARNESS_IDS, harnessLabel, awehitchCliEntry, type HarnessId } from "../adapters/paths.js";
import { loadAdapter } from "../adapters/index.js";
import { detectHarnesses } from "../adapters/detect.js";

/**
 * Test seam: the tests assert on command shape (hidden flags) and extracted
 * offline helpers without driving a real bridge/browser, so the CLI module
 * must import without tearing down the process. The parse at the bottom is
 * gated to the main entry; this re-export is the only test-facing surface.
 */
export const program = new Command();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

function parseInteger(value: string): number {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new InvalidArgumentError("must be an integer");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError("must be a safe integer");
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = parseInteger(value);
  if (parsed < 0) throw new InvalidArgumentError("must be a non-negative integer");
  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = parseInteger(value);
  if (parsed <= 0) throw new InvalidArgumentError("must be a positive integer");
  return parsed;
}

function parseExitStatus(value: string): string {
  const normalized = value.trim();
  if (/^-?\d+$/.test(normalized)) {
    const num = Number(normalized);
    if (!Number.isSafeInteger(num) || num < 0 || num > 255) {
      throw new InvalidArgumentError("must be 0-255 or one of: ok, failed, blocked");
    }
    return normalized;
  }
  const lowered = normalized.toLowerCase();
  if (["ok", "failed", "blocked"].includes(lowered)) return lowered;
  throw new InvalidArgumentError("must be 0-255 or one of: ok, failed, blocked");
}

function parseChangedFiles(value: string): string[] | number {
  const normalized = value.trim();
  if (/^-?\d+$/.test(normalized)) {
    const count = parseInteger(normalized);
    if (count < 0) {
      throw new InvalidArgumentError("changed-files count must be a non-negative safe integer");
    }
    return count;
  }
  return value.split(",").map((file) => file.trim()).filter(Boolean);
}

/** Local harness output only. Never pasted into ChatGPT. */
const MAX_RECORD_OUTPUT_READ = 256 * 1024;

function readCappedUtf8(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function persistMachineEndpoint(opts: {
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint();
  const connectorName = connectorNameFor({
    previousName: previous?.connectorName,
    legacyMatch: legacyEndpointForMcpUrl(opts.mcpUrl),
  });
  writeLastEndpoint({
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  return connectorName;
}

function tunnelChoicePayload(zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState();
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedMachineHostname(zone) : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
  };
}

function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

interface AdminInfo {
  scope: "machine";
  workspaces: { workspaceId: string; workspaceName: string; workspaceRoot: string }[];
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean; foreground?: boolean }
): Promise<{ runtime: RuntimeState; info: AdminInfo; mcpUrl: string | null; child: ChildProcess | null }> {
  migrateLegacyStateToMachine();
  const { runtime, child } = await ensureBridge(workspaceRoot, { foreground: opts.foreground });
  let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  if (opts.tunnel && !info.publicUrl) {
    const binaries = detectTunnelBinaries();
    if (!binaries.cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    const result = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
    if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = `${result.url}/mcp`;
  }
  return { runtime, info, mcpUrl, child };
}

/**
 * Revoke ChatGPT's access on this machine: via the live bridge when one is
 * running, otherwise directly on the persisted auth store. Split out so tests
 * can exercise the offline (no-bridge) path without a running daemon.
 */
export async function revokeConnectorAccess(): Promise<void> {
  const runtime = await findLiveBridge();
  if (runtime) {
    await adminFetch(runtime, "POST", "/admin/revoke-all");
  } else {
    // bridge not running: revoke directly in the persisted store
    new AuthStore().revokeAll();
  }
}

/** Wait on stdin for a single Enter (used only for the one allowed human pause). */
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.once("line", () => {
      rl.close();
      resolve();
    });
    rl.once("close", () => resolve());
  });
}

/**
 * What `up` should do about a bridge that is already running. TTY callers
 * choose; scripts and --json keep the silent reuse.
 */
function askBridgeReuse(port: number): Promise<"reuse" | "restart" | "quit"> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`A bridge is already running (port ${port}). [R]euse it (default) / re[S]tart / [Q]uit? `, (raw) => {
      rl.close();
      const answer = raw.trim().toLowerCase();
      if (answer.startsWith("s")) resolve("restart");
      else if (answer.startsWith("q")) resolve("quit");
      else resolve("reuse");
    });
    rl.once("close", () => resolve("reuse"));
  });
}

/**
 * Foreground tail: stay attached until the service goes away, then exit.
 * - child (spawned attached): Ctrl+C reaches it directly (same process group)
 *   and its own SIGINT handler shuts bridge + tunnel down; we outlive it and
 *   propagate its exit.
 * - reused daemon: stream the bridge log; Ctrl+C stops it gracefully first,
 *   and a bridge that dies on its own ends the attach.
 */
async function attachForeground(
  child: ChildProcess | null,
  exitCode: number
): Promise<void> {
  if (!child) {
    const stopStreaming = followLogFile(bridgeLogPath(), (text) => process.stdout.write(text));
    const watch = setInterval(() => {
      void findLiveBridge().then((live) => {
        if (!live) {
          clearInterval(watch);
          stopStreaming();
          process.exit(exitCode);
        }
      });
    }, 2_000);
    const shutdown = (): void => {
      clearInterval(watch);
      stopStreaming();
      void stopBridgeAndWait().then((ok) => process.exit(ok ? exitCode : 1));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return new Promise<void>(() => undefined); // parked; exits happen above
  }
  if (child.exitCode !== null || child.signalCode !== null) process.exit(exitCode);
  process.on("SIGINT", () => {
    // The child shares this process group: it received the same SIGINT and
    // shuts bridge + tunnel down itself. Just don't die before it does.
  });
  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
  });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (outcome.signal === null && outcome.code !== 0) say(`Bridge exited with code ${outcome.code}.`);
  process.exit(exitCode !== 0 ? exitCode : outcome.code ?? 0);
}

program
  .name("awehitch")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Your agent works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true })
  .addHelpText("after", "\nAgent/advanced commands (session, record, login, connector-setup, stop, logs, …) are still available: awehitch <command> --help");

// ---------------------------------------------------------------- awehitch (default: ensure connected)

interface ConnectorOutcome {
  result: ConnectorSetupResult;
  connectorName: string;
  mcpUrl: string;
  /** True when this run established/rebuilt a connector (address changed). */
  rebuilt: boolean;
}

function connectorError(payload: ConnectorSetupResult): { code: string; message: string } {
  return {
    code: payload.error?.code ?? "CONNECTOR_FAILED",
    message: payload.error?.message ?? "Connector setup did not finish.",
  };
}

/**
 * Create/repair the ChatGPT connector, mirroring connector-setup's 409 rename
 * persistence and tokenCount baseline (see that command for why tokensBefore
 * must be captured before the run).
 */
async function runConnectorFor(
  workspaceId: string,
  runtime: RuntimeState,
  info: AdminInfo,
  mcpUrl: string,
  connectorName: string,
  timeoutMinutes: number,
  onNotice: (message: string) => void
): Promise<ConnectorOutcome> {
  const resolvedMcpUrl = mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`;
  const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
  const tokensBefore = info.tokenCount;
  const result = await runConnectorSetup({
    workspaceId,
    connectorName,
    mcpUrl: resolvedMcpUrl,
    pairingCode: pairing.code,
    dryRun: false,
    loginTimeoutMs: timeoutMinutes * 60_000,
    onNotice,
    verifyAuthorized: async () => {
      const current = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      return current.tokenCount > tokensBefore;
    },
  });
  // A 409 conflict makes the flow retry under a bumped title; the final name
  // must be persisted or the next run would conflict forever.
  const finalName = result.connectorName ?? connectorName;
  if (result.ok && finalName !== connectorName) {
    writeLastEndpoint({
      port: runtime.port,
      publicUrl: info.publicUrl,
      mcpUrl: resolvedMcpUrl,
      connectorName: finalName,
    });
  }
  return { result, connectorName: finalName, mcpUrl: resolvedMcpUrl, rebuilt: true };
}

interface UpOptions {
  workspace?: string;
  harness?: HarnessId[];
  noTunnel: boolean;
  json: boolean;
  daemon: boolean;
  timeout: number;
}

function parseHarnessOption(value: string, acc: HarnessId[]): HarnessId[] {
  const harness = value.trim().toLowerCase() as HarnessId;
  if (!HARNESS_IDS.includes(harness)) {
    throw new InvalidArgumentError(`must be one of: ${HARNESS_IDS.join(", ")}`);
  }
  return [...acc, harness];
}

// `awehitch` (alias `awehitch up`): "make sure ChatGPT is connected". Every
// step is idempotent and non-interactive except the single login pause below.
// The temporary address is the default — the Cloudflare choice prompt is
// deliberately not shown here. Foreground by default: the service lives in
// this terminal until Ctrl+C; --daemon (implied by --json) detaches instead.
program
  .command("up", { isDefault: true })
  .description(
    "Connect this workspace to ChatGPT (idempotent). Keeps the service in the foreground: logs stream here, Ctrl+C stops it. Use --daemon for background."
  )
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--harness <id>", "harness adapter to install (repeatable, overrides auto-detection)", parseHarnessOption, [] as HarnessId[])
  .option("--no-tunnel", "local-only mode (skip the public connection)")
  .option("-d, --daemon", "run the service in the background and exit (implied by --json); logs under the state dir's logs/", false)
  .option("--json", "machine-readable output", false)
  .option("--timeout <minutes>", "how long to wait for the ChatGPT login", parsePositiveInteger, 5)
  .action(async (opts: UpOptions) => {
    const root = resolveWorkspace(opts.workspace);
    const json = opts.json;
    // Foreground = interactive default. --json always detaches: a machine
    // caller must get its JSON answer and exit, never block on a service.
    const fg = !json && !opts.daemon;
    let fgChild: ChildProcess | null = null;
    let fgExit = 0;
    let skipHarness = false;
    const requested = opts.harness?.length ? [...new Set(opts.harness)] : detectHarnesses();

    let workspace: Workspace;
    try {
      workspace = new Workspace(root);
    } catch (error) {
      const message = (error as Error).message;
      if (json) say(JSON.stringify({ ok: false, error: { code: "BAD_WORKSPACE", message } }));
      else cross(message);
      process.exitCode = 1;
      return;
    }

    // There is no mode switch: the same machinery (bridge, tunnel, connector)
    // serves both ways of working — the agent driving per-task chats from the
    // terminal, and the user dispatching from their own bound conversation.
    // The dispatch marker is the user-authorization knob for the latter.
    const dispatchMarker = resolveDispatchMarker(workspace.projectConfig.dispatchMarker);

    if (!json) {
      say(PRODUCT_NAME);
      say("");
      // An interactive caller gets to decide what a running bridge means:
      // keep it (the default — reusing also picks up newly registered
      // workspaces), restart it (e.g. after a build), or back off.
      if (fg && process.stdin.isTTY && process.stdout.isTTY) {
        const live = await findLiveBridge();
        if (live) {
          const choice = await askBridgeReuse(live.port);
          if (choice === "quit") return;
          if (choice === "restart") await stopBridge();
        }
      }
      say("Connecting to ChatGPT…");
      say("");
    }

    // 1. Bridge + (temporary) tunnel. Never asks the Cloudflare choice prompt.
    let runtime: RuntimeState;
    let info: AdminInfo;
    let mcpUrl: string | null;
    try {
      const out = await ensureBridgeAndTunnel(root, { tunnel: !opts.noTunnel, foreground: fg });
      runtime = out.runtime;
      info = out.info;
      mcpUrl = out.mcpUrl;
      fgChild = out.child;
    } catch (error) {
      handleCliError(error, json);
      return;
    }

    const onNotice = (message: string): void => {
      if (!json) process.stderr.write(message + "\n");
    };
    // Snapshot the previous endpoint BEFORE persisting: connectorAction must
    // compare the OLD address against the new one, or an address change is
    // never detected (doctor follows the same ordering).
    const previousEndpoint = readLastEndpoint();
    const connectorName = mcpUrl
      ? persistMachineEndpoint({
          port: runtime.port,
          publicUrl: info.publicUrl,
          mcpUrl,
          previous: previousEndpoint,
        })
      : connectorNameFor({
          previousName: previousEndpoint?.connectorName,
          legacyMatch: legacyEndpointForMcpUrl(previousEndpoint?.mcpUrl),
        });

    // 2. Decide whether the ChatGPT side needs any action. Without a public
    //    address there is nothing to connect (local mode). When the address is
    //    unchanged AND we already hold an authorized token, do not touch
    //    ChatGPT at all (a fresh pairing would invalidate the old code).
    const action = mcpUrl ? connectorAction(previousEndpoint?.mcpUrl, mcpUrl) : "none";
    const addressChanged = action === "update";
    let connectorUpdated = false;
    // Guided-manual mode (`prefs setup-mode manual`): print the steps for the
    // user's own browser instead of opening the control-plane browser.
    let manualSetup: ConnectorManualFallback | null = null;
    // Holder object: assignments happen inside the closure below; a bare `let`
    // would be narrowed back to `null` at the use site.
    const connector: { outcome: ConnectorOutcome | null } = { outcome: null };
    if (mcpUrl && !(action === "none" && info.tokenCount > 0)) {
      if (readUiPrefs().setupMode === "manual") {
        const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
        manualSetup = manualConnectorFallback({ connectorName, mcpUrl, pairingCode: pairing.code });
      } else {
      const attempt = async (): Promise<"ok" | "failed" | "paused"> => {
        const outcome = await runConnectorFor(workspace.id, runtime, info, mcpUrl, connectorName, opts.timeout, onNotice);
        if (outcome.result.ok) {
          connector.outcome = outcome;
          connectorUpdated = true;
          return "ok";
        }
        const code = outcome.result.error?.code;
        if (code === "CONNECTOR_NEEDS_HUMAN" && !json) {
          // The one allowed human pause: the control-plane browser is already
          // open on the login wall. JSON mode stops here with exit 0 instead —
          // an expected pause for the agent to relay, not an error.
          say("Log in to ChatGPT in the opened window, then press Enter…");
          await waitForEnter();
          await interactiveLogin(workspace.id, opts.timeout * 60_000).catch(() => undefined);
          const retry = await runConnectorFor(workspace.id, runtime, info, mcpUrl, connectorName, opts.timeout, onNotice);
          if (retry.result.ok) {
            connector.outcome = retry;
            connectorUpdated = true;
            return "ok";
          }
          handleConnectorFailure(retry, json);
          return "failed";
        }
        if (code === "CONNECTOR_NEEDS_HUMAN" && json) {
          say(JSON.stringify({ ok: false, needsLogin: true, message: "Log in to ChatGPT in the opened window, then re-run awehitch" }));
          return "paused";
        }
        if (code === "CONNECTOR_PAIRING_REJECTED") {
          onNotice("The pairing code expired; generated a fresh one and retrying.");
          const retry = await runConnectorFor(workspace.id, runtime, info, mcpUrl, connectorName, opts.timeout, onNotice);
          if (retry.result.ok) {
            connector.outcome = retry;
            connectorUpdated = true;
            return "ok";
          }
          handleConnectorFailure(retry, json);
          return "failed";
        }
        handleConnectorFailure(outcome, json);
        return "failed";
      };
      try {
        const verdict = await attempt();
        if (verdict !== "ok") {
          // "paused" (needsLogin) is the expected stop, exit 0; everything
          // else already printed its honest failure. Foreground keeps the
          // service alive in this terminal and exits with the verdict only
          // after the user presses Ctrl+C — the attached bridge owns the
          // exit path.
          if (verdict === "failed") {
            if (fg) {
              fgExit = 1;
              skipHarness = true;
            } else {
              process.exitCode = 1;
            }
          }
          if (!fg) return;
        }
      } catch (error) {
        handleCliError(error, json);
        if (fg) {
          fgExit = 1;
          skipHarness = true;
        } else {
          return;
        }
      }
      }
    }

    // 3. Harness adapters (idempotent; a wiring failure must not abort the
    //    connection). Codex gets its sandbox allowlist alongside.
    const harnesses: { id: string; installed: boolean; skillPath?: string; error?: string }[] = [];
    if (!skipHarness) {
      for (const harness of requested) {
        try {
          const impl = await loadAdapter(harness);
          const base = readLastEndpoint()?.connectorName ?? connectorName;
          const result = impl.setup({ workspaceRoot: root, cliEntry: awehitchCliEntry(), connectorName: base });
          harnesses.push({ id: harness, installed: true, skillPath: result.skillPath });
          if (harness === "codex") trySandboxAllow();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          harnesses.push({ id: harness, installed: false, error: message });
          if (!json) process.stderr.write("Failed to wire " + harnessLabel(harness) + ": " + message + "\n");
        }
      }
    }

    // 4. Output.
    const finalName = connector.outcome?.connectorName ?? connectorName;
    const tunnelState = readTunnelState();
    const served = info.workspaces.length > 0
      ? info.workspaces.map((w) => w.workspaceName).join(", ")
      : workspace.name;
    if (json) {
      say(JSON.stringify({
        ok: true,
        scope: "machine",
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        servedWorkspaces: info.workspaces,
        connectorName: finalName,
        mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
        port: runtime.port,
        tunnel: {
          mode: !mcpUrl ? "none" : isNamedTunnelReady(tunnelState) ? "named" : "quick",
          hostname: mcpUrl ? (tunnelState.hostname ?? null) : null,
        },
        harnesses,
        needsLogin: false,
        connectorUpdated,
        // The marker the user types in their own ChatGPT conversation to
        // authorize a dispatch (the agent-bound conversation workflow).
        dispatchMarker,
        // Present only in guided-manual mode: the agent relays these steps
        // to the user instead of awehitch opening a browser.
        ...(manualSetup ? { manualSetup } : {}),
      }));
      return;
    }

    say(PRODUCT_NAME);
    say("");
    if (manualSetup) say("· Local side ready; the ChatGPT connector needs the guided manual steps below");
    else if (mcpUrl) check(`ChatGPT is connected to this machine's workspaces`);
    else say("· Local mode started (no public connection; ChatGPT cannot reach this machine yet)");
    say(`· Serving ${info.workspaces.length} workspace(s): ${served}`);
    if (requested.length === 0) say("· No coding agent detected (codex / opencode / zcode); pass --harness to pick one");
    else say(`· Wired ${requested.map((h) => harnessLabel(h)).join(", ")}`);
    if (manualSetup) {
      say("");
      say("Guided manual setup — complete these in your own browser (already logged in to ChatGPT):");
      for (const step of manualSetup.steps) say("· " + step);
      say("");
      say("The pairing code expires in ~5 minutes; re-run `awehitch up` for a fresh one.");
      say("Done? Re-run `awehitch up` to verify the connection.");
      if (fg) {
        say("");
        say(fgChild
          ? "Foreground mode: service logs stream below. Press Ctrl+C to stop awehitch."
          : "Bridge already running: streaming its log below. Press Ctrl+C to stop awehitch.");
        await attachForeground(fgChild, fgExit);
      }
      return;
    }
    say("");
    say('From now on, ask your agent to "use ChatGPT to plan XXX" — or just prefix it with @chatgpt.');
    const watchMode = readDispatchWatch()?.mode ?? "off";
    if (watchMode === "chat") {
      say(`One pinned conversation is watched: ${dispatchMarker} there dispatches work (\`awehitch dispatch stop\` unpins it).`);
    } else {
      say(`To run an agent from your own ChatGPT conversations, @-mention one with a task (@opencode, @codex, @zcode) and let ChatGPT call its dispatch tool — nothing runs in the background.`);
    }
    say("For a full agent-driven protocol loop in one conversation, bind it with awehitch_open_chat (url=…) instead.");
    say("After a reboot it usually self-heals; if not, re-run awehitch.");
    if (addressChanged) {
      say("");
      say("The public address changed and was repaired automatically. Occasional changes are normal; for a stable hostname run `awehitch tunnel choose --mode named`.");
    }

    if (fg) {
      say("");
      say(fgChild
        ? "Foreground mode: service logs stream below. Press Ctrl+C to stop awehitch."
        : "Bridge already running: streaming its log below. Press Ctrl+C to stop awehitch.");
      await attachForeground(fgChild, fgExit);
      return;
    }
    say("");
    say(`· Background mode — logs: ${bridgeLogPath()}`);
  });

/** Print a connector-setup failure honestly (human or JSON). */
function handleConnectorFailure(outcome: ConnectorOutcome, json: boolean): void {
  const err = connectorError(outcome.result);
  if (json) {
    say(JSON.stringify({ ok: false, error: err, manualFallback: outcome.result.manualFallback }));
    return;
  }
  cross(err.message);
  if (outcome.result.manualFallback?.steps) {
    say("");
    say("You can complete these steps manually:");
    for (const step of outcome.result.manualFallback.steps) say("· " + step);
  }
}

// ---------------------------------------------------------------- off (disconnect)

program
  .command("off")
  .description("Disconnect ChatGPT and stop the machine's awehitch bridge")
  .option("-w, --workspace <path>", "accepted for compatibility; the bridge is machine-wide")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    // Off is machine-wide in both modes — the bridge is the data plane for
    // lead and follow alike, so tearing it down is what off means here.
    try {
      await revokeConnectorAccess();
      await stopBridge();
    } catch (error) {
      handleCliError(error, opts.json);
      return;
    }
    if (opts.json) {
      const name = readLastEndpoint()?.connectorName;
      say(JSON.stringify({ ok: true, scope: "machine", connectorName: name ?? null, pluginsUrl: "https://chatgpt.com/plugins" }));
      return;
    }
    check("Disconnected ChatGPT from this machine");
    const name = readLastEndpoint()?.connectorName;
    if (name) say("· To remove it fully, delete \"" + name + "\" on https://chatgpt.com/plugins");
  });

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .option("--port <port>", "preferred port")
  .action(async (opts: { port?: string }) => {
    migrateLegacyStateToMachine();
    const logger = new Logger({ name: "bridge", console: true });
    // Hands-free dispatch: ChatGPT itself calls the dispatch_agent tool; the
    // watcher below is the explicit, pinned-conversation variant.
    const dispatchWatcher = new DispatchWatcher({ logger });
    const bridge = await startBridge({
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
      dispatchAgent: createDispatchToolHandler(
        defaultDispatchToolDeps(logger, () => {
          const watched = dispatchWatcher.watchedConversation();
          return watched ? [watched] : [];
        })
      ),
    });
    dispatchWatcher.start();
    const shutdown = (): void => {
      void Promise.all([bridge.close(), dispatchWatcher.stop()]).then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} serving ${bridge.workspaces.length} workspace(s)`);
  });

// ---------------------------------------------------------------- dispatch

const dispatchCmd = program
  .command("dispatch")
  .description(
    "Watch a user-owned ChatGPT conversation; the bridge spawns your agent for user-authorized dispatches there"
  );

dispatchCmd
  .command("watch", { isDefault: true })
  .description(
    "Watch a conversation (its chatgpt.com/c/… URL). Typing the dispatch marker in your own message there, with a task, makes the bridge spawn the agent — no agent session needs to be running."
  )
  .argument("<url>")
  .option("-w, --workspace <path>", "workspace root the dispatched agent runs in (defaults to current directory)")
  .option("--harness <id>", "harness to spawn (codex | opencode | zcode); default: a harness named in the directive, else the first installed", parseHarnessKey)
  .option("--command <cmd>", "override the harness binary (space-separated; run without a shell)")
  .option("--json", "machine-readable output", false)
  .action(async (url: string, opts: { workspace?: string; harness?: string; command?: string; json: boolean }) => {
    try {
      const root = resolveWorkspace(opts.workspace);
      const chatUrl = normalizeChatUrl(url);
      if (!chatUrl) throw new InvalidArgumentError("not a chatgpt.com conversation URL (expected chatgpt.com/c/…)");
      if (opts.harness && !HARNESS_IDS.includes(opts.harness as HarnessId)) {
        throw new InvalidArgumentError(`--harness must be one of: ${HARNESS_IDS.join(", ")}`);
      }
      const previous = readDispatchWatch();
      const sameChat = previous?.chatUrl === chatUrl;
      writeDispatchWatch({
        mode: "chat",
        workspaceRoot: root,
        chatUrl,
        ...(opts.harness ? { harness: opts.harness as HarnessId } : {}),
        ...(opts.command ? { command: opts.command } : {}),
        // Same conversation re-watched: keep the note/dedup bookkeeping.
        ...(sameChat && previous
          ? { notedUrl: previous.notedUrl, lastDirective: previous.lastDirective }
          : {}),
        updatedAt: new Date().toISOString(),
      });

      // The watcher lives in the bridge process: make sure one is running.
      let bridgePort: number | null = (await findLiveBridge())?.port ?? null;
      if (bridgePort === null) bridgePort = (await ensureBridge(root)).runtime.port;

      const marker = resolveDispatchMarker(new Workspace(root).projectConfig.dispatchMarker);
      if (opts.json) {
        say(JSON.stringify({ ok: true, watch: { workspaceRoot: root, chatUrl, harness: opts.harness ?? null }, dispatchMarker: marker, bridgePort }));
        return;
      }
      check(`Watching ${chatUrl}`);
      say(`· Workspace: ${root}`);
      say(`· Dispatch marker: ${marker} — type it in your OWN message there to authorize work (config: dispatchMarker in .c2c.json)`);
      say(`· Agent: ${opts.harness ?? "chosen per directive (a harness named in the message wins, else the first installed)"}`);
      say("The watcher runs inside the bridge; ChatGPT turns an authorized dispatch into a spawned agent run that reports back into the same conversation.");
      say("One executor per conversation: if you also attach an agent session there, run `awehitch dispatch stop` first.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

dispatchCmd
  .command("stop")
  .description("Stop watching the pinned conversation (hands-free dispatching via the connector tool is unaffected — it never polls)")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const watch = readDispatchWatch();
    writeDispatchWatch({ mode: "off", updatedAt: new Date().toISOString() });
    if (opts.json) {
      say(JSON.stringify({ ok: true, watching: false, stopped: watch?.chatUrl ?? watch?.mode ?? "off" }));
      return;
    }
    if (watch?.mode === "chat" && watch.chatUrl) check(`Stopped watching ${watch.chatUrl}`);
    else check("No conversation is watched");
    say("The bridge releases its dispatch browser within a minute (or immediately on restart). Watching one again: `awehitch dispatch watch <url>`.");
  });

dispatchCmd
  .command("release")
  .description("Free a conversation's one-agent-session claim (a stuck interactive terminal, or a run the bridge lost track of)")
  .argument("<url>")
  .option("--json", "machine-readable output", false)
  .action((url: string, opts: { json: boolean }) => {
    try {
      const chatUrl = normalizeChatUrl(url);
      if (!chatUrl) throw new InvalidArgumentError("not a chatgpt.com conversation URL (expected chatgpt.com/c/…)");
      const had = activeSession(chatUrl) !== null;
      releaseConversation(chatUrl);
      if (opts.json) {
        say(JSON.stringify({ ok: true, chatUrl, released: had }));
        return;
      }
      if (had) check(`Released ${chatUrl} — the conversation can dispatch a new agent session`);
      else check(`No active claim on ${chatUrl}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

dispatchCmd
  .command("launch")
  .description("How a dispatch starts the agent: headless (background run, reports [C2C] back into the conversation) or interactive (the harness's TUI opens in a terminal window — switch profile, steer, keep talking there)")
  .argument("<style>", "headless | interactive", (value: string) => {
    if (value !== "headless" && value !== "interactive") {
      throw new InvalidArgumentError("must be headless or interactive");
    }
    return value as DispatchLaunchStyle;
  })
  .option("--json", "machine-readable output", false)
  .action(async (style: DispatchLaunchStyle, opts: { json: boolean }) => {
    writeLaunchStyle(style);
    if (style === "interactive") {
      const ensured = await ensureAweswitch();
      if (!ensured.ok && ensured.note) say(`⚠ ${ensured.note}`);
    }
    if (opts.json) {
      say(JSON.stringify({ ok: true, launchStyle: readLaunchStyle() }));
      return;
    }
    check(style === "interactive"
      ? "Dispatches now open the agent's TUI in a Terminal window with an aweswitch profile picker; the task is pasted into the agent and submitted automatically (clipboard fallback; no automatic [C2C] report)"
      : "Dispatches now run in the background and report [C2C] back into the conversation");
  });

// ---------------------------------------------------------------- control-plane (stdio MCP)

program
  .command("control-plane", { hidden: true })
  .description("Run the control-plane proxy as a stdio MCP server (spawned by harnesses)")
  .requiredOption("--workspace <path>")
  .option("--harness <id>", "harness slice: own browser profile, chat bindings and C2C checkpoint", parseHarnessKey)
  .option("--browser-idle-minutes <minutes>", "close the browser after this many idle minutes (default 10; also settable via browserIdleMinutes in .c2c.json)", (value: string) => {
    const minutes = Number.parseFloat(value);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new InvalidArgumentError("must be a positive number of minutes");
    }
    return minutes;
  })
  .action(async (opts: { workspace: string; harness?: string; browserIdleMinutes?: number }) => {
    await runStdioServer(resolveWorkspace(opts.workspace), opts.harness, opts.browserIdleMinutes);
  });

// ---------------------------------------------------------------- setup

program
  .command("setup", { hidden: true })
  .description("First-time setup: bridge + secure connection + pairing code + harness adapter")
  .option("-w, --workspace <path>")
  .option("--harness <harness>", `harness adapter: ${HARNESS_IDS.join(" | ")} (optional, repeatable)`)
  .option("--no-tunnel", "local-only setup (development)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; harness?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("Connecting to ChatGPT…");
        say("");
      }
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistMachineEndpoint({
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : connectorNameFor({
            previousName: readLastEndpoint()?.connectorName,
            legacyMatch: legacyEndpointForMcpUrl(readLastEndpoint()?.mcpUrl),
          });
      const pairingResult = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      const tunnelState = readTunnelState();

      // Harness adapter (repeatable): wire the control plane into the harness.
      let adapter: Record<string, unknown> | null = null;
      if (opts.harness) {
        const harness = opts.harness.trim().toLowerCase() as HarnessId;
        if (!HARNESS_IDS.includes(harness)) {
          throw new Error(`--harness must be one of: ${HARNESS_IDS.join(", ")}`);
        }
        const impl = await loadAdapter(harness);
        const result = impl.setup({
          workspaceRoot: root,
          cliEntry: awehitchCliEntry(),
          connectorName,
        });
        adapter = { harness, ...result };
      }

      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            scope: "machine",
            servedWorkspaces: info.workspaces,
            connectorName,
            mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
            local: mcpUrl === null,
            pairingCode: pairingResult.code,
            pairingExpiresAt: pairingResult.expiresAt,
            adapter,
            tunnel: {
              mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
              hostname: tunnelState.hostname ?? null,
              fallback: Boolean(tunnelState.fallbackReason),
            },
          })
        );
        return;
      }
      check(`Bridge is up (${info.workspaces.length} workspace(s) served)`);
      if (mcpUrl) check("Secure connection established");
      if (adapter) check(`Wired ${harnessLabel(adapter.harness as HarnessId)}`);
      say("");
      say(`Connection URL: ${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
      say(`Pairing code: ${pairingResult.code} (valid for ${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} min)`);
      say("");
      say("Next: run `awehitch connector-setup -w <workspace>` to create the ChatGPT connector automatically.");
      say("(You do not need to copy the URL or pairing code; an agent with the awehitch skill runs this step itself.)");
      say("Note: `setup` is kept for older installed skills; `awehitch up` does all of this in one idempotent step.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- login (control-plane browser)

program
  .command("login", { hidden: true })
  .description("Open the control-plane browser and wait for the ChatGPT login")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    try {
      const loggedIn = await interactiveLogin(workspace.id);
      if (opts.json) say(JSON.stringify({ ok: loggedIn, workspaceId: workspace.id }));
      else if (loggedIn) check("Logged in to ChatGPT (control-plane browser ready)");
      else cross("Timed out waiting for login; retry `awehitch login`");
      if (!loggedIn) process.exitCode = 1;
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- connector-setup

const STEP_MARK: Record<ConnectorStep["status"], string> = {
  done: "✓",
  skipped: "·",
  planned: "·",
  "needs-human": "!",
  failed: "✗",
};

function renderConnectorResult(result: ConnectorSetupResult, dryRun: boolean): void {
  say(PRODUCT_NAME);
  say("");
  for (const step of result.steps) {
    const suffix = step.detail ? `（${step.detail}）` : "";
    say(`${STEP_MARK[step.status]} ${step.label}${suffix}`);
  }
  if (dryRun && result.probe) {
    say("");
    say("Element probes:");
    for (const [target, hit] of Object.entries(result.probe)) {
      say(`· ${target}: ${hit.selector ? `matched ${hit.selector} (${hit.count})` : "missed"}`);
    }
    if (result.unresolved && result.unresolved.length > 0) {
      say("");
      say(`Unresolved required elements: ${result.unresolved.join(", ")}`);
      say("Override the matching keys in selectors.json and retry.");
    }
  }
  say("");
  if (result.ok) {
    say(dryRun ? "Element probe finished (nothing was changed)." : "Ready.");
    return;
  }
  if (result.error) {
    say(`Problem: ${result.error.message}`);
    say("");
  }
  // A dry run has no real address or pairing code, so its fallback is noise.
  if (!dryRun && result.manualFallback) {
    say("You can complete these steps manually:");
    for (const line of result.manualFallback.steps) say(`· ${line}`);
    say("");
    say("Pairing codes expire in about 5 minutes; run `awehitch pair` for a fresh one.");
  }
}

program
  .command("connector-setup", { hidden: true })
  .alias("connector")
  .description("Create or repair this workspace's ChatGPT connector automatically")
  .option("-w, --workspace <path>")
  .option("--dry-run", "resolve the page elements and report them, change nothing", false)
  .option("--timeout <minutes>", "how long to wait for the ChatGPT login", parsePositiveInteger, 5)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; dryRun: boolean; timeout: number; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const onNotice = (message: string): void => {
      if (!opts.json) process.stderr.write(`${message}\n`);
    };
    try {
      const workspace = new Workspace(root);
      const previous = readLastEndpoint();
      const nameFor = (): string =>
        connectorNameFor({
          previousName: previous?.connectorName,
          legacyMatch: legacyEndpointForMcpUrl(previous?.mcpUrl),
        });

      if (opts.dryRun) {
        // A dry run must not start daemons or tunnels: it only reports what
        // the control-plane browser can currently see on the three pages.
        const result = await runConnectorSetup({
          workspaceId: workspace.id,
          connectorName: nameFor(),
          mcpUrl: previous?.mcpUrl ?? "",
          pairingCode: "",
          dryRun: true,
          loginTimeoutMs: opts.timeout * 60_000,
          onNotice,
        });
        if (opts.json) say(JSON.stringify(result));
        else renderConnectorResult(result, true);
        return;
      }

      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: true });
      const connectorName = mcpUrl
        ? persistMachineEndpoint({
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : nameFor();
      const resolvedMcpUrl = mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`;
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");

      // Guided-manual mode: print the steps for the user's own browser;
      // the control-plane browser is never opened.
      if (readUiPrefs().setupMode === "manual") {
        const plan = manualConnectorFallback({ connectorName, mcpUrl: resolvedMcpUrl, pairingCode: pairing.code });
        if (opts.json) {
          say(JSON.stringify({
            ok: true,
            dryRun: false,
            guided: true,
            steps: [],
            connectorName,
            mcpUrl: resolvedMcpUrl,
            manualFallback: plan,
          }));
        } else {
          check("Guided manual setup (setup mode: manual) — no browser will open");
          say("");
          for (const step of plan.steps) say("· " + step);
          say("");
          say("The pairing code expires in ~5 minutes; re-run this command for a fresh one.");
        }
        return;
      }

      // Baseline BEFORE the run: a token left over from an earlier pairing
      // must never be mistaken for this run's success.
      const tokensBefore = info.tokenCount;
      const result = await runConnectorSetup({
        workspaceId: workspace.id,
        connectorName,
        mcpUrl: resolvedMcpUrl,
        pairingCode: pairing.code,
        dryRun: false,
        loginTimeoutMs: opts.timeout * 60_000,
        onNotice,
        verifyAuthorized: async () => {
          const current = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
          return current.tokenCount > tokensBefore;
        },
      });

      // A 409 conflict makes the flow retry under a bumped title; the final
      // name must be persisted or the next run would rebuild under the
      // taken name and conflict forever.
      const finalName = result.connectorName ?? connectorName;
      if (result.ok && finalName !== connectorName) {
        writeLastEndpoint({
          port: runtime.port,
          publicUrl: info.publicUrl,
          mcpUrl: resolvedMcpUrl,
          connectorName: finalName,
        });
      }

      if (opts.json) {
        say(JSON.stringify({ ...result, connectorName: finalName, mcpUrl: resolvedMcpUrl }));
      } else {
        renderConnectorResult(result, false);
      }
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop", { hidden: true })
  .description("Stop the machine's bridge")
  .option("-w, --workspace <path>", "accepted for compatibility; the bridge is machine-wide")
  .action(async () => {
    const stopped = await stopBridge();
    if (stopped) check("Bridge stopped");
    else say("No bridge is running.");
  });

program
  .command("restart", { hidden: true })
  .description("Restart the machine's bridge")
  .option("-w, --workspace <path>", "workspace whose directory stays registered")
  .option("--tunnel", "re-establish the secure public connection", false)
  .action(async (opts: { workspace?: string; tunnel: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    await stopBridge();
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const { info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      check(`Bridge restarted (${info.workspaces.length} workspace(s) served)`);
      if (mcpUrl) check("Secure connection established");
    } catch (error) {
      handleCliError(error, false);
    }
  });

// ---------------------------------------------------------------- status (machine-wide service view)

/**
 * Machine-level view: the one bridge plus the workspace registry it serves.
 * `doctor --no-fix` remains the read-only deep check for one workspace's
 * wiring; `status` answers "is the service up, and what does it serve".
 */
const STATUS_REASON_TEXT: Record<string, string> = {
  runtime_missing: "no runtime record (service not started)",
  pid_missing: "process exited (crash or kill)",
  stale_pid: "its pid now belongs to another process",
  probe_failed: "not answering on its port",
  pid_unknown: "process state unreadable",
  legacy_workspace_scoped: "a pre-0.2.6 workspace-scoped bridge is still running; re-run `awehitch up` to replace it",
};

program
  .command("status")
  .description("Show the awehitch bridge on this machine and the workspaces it serves")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    const observation = await findBridgeObservation();
    const registryRoots = readRegistryRoots();
    const legacy = readLegacyRuntimeStates();
    const runtime = observation.runtime;

    const bridge =
      observation.state === "healthy"
        ? {
            state: "running" as const,
            pid: runtime?.pid,
            port: runtime?.port,
            publicUrl: runtime?.publicUrl ?? null,
            startedAt: runtime?.startedAt,
          }
        : {
            state: observation.state,
            reason: observation.reason,
            reasonText: STATUS_REASON_TEXT[observation.reason] ?? observation.reason,
          };

    if (opts.json) {
      say(JSON.stringify({
        ok: true,
        scope: "machine",
        bridge,
        registryRoots,
        legacyRecords: legacy.map((entry) => ({ pid: entry.pid, port: entry.port })),
      }));
      return;
    }

    if (observation.state === "healthy") {
      const rt = observation.runtime;
      check(`awehitch bridge — running (pid ${rt.pid}, port ${rt.port})`);
      if (rt.publicUrl) say(`  Public: ${rt.publicUrl}`);
      say(`  Since: ${new Date(rt.startedAt).toLocaleString()}`);
    } else if (observation.state === "unknown") {
      say(`! Bridge state is uncertain (${STATUS_REASON_TEXT[observation.reason] ?? observation.reason})`);
      say("  Check: awehitch doctor");
    } else {
      const reasonText = STATUS_REASON_TEXT[observation.reason] ?? observation.reason;
      if (observation.reason === "legacy_workspace_scoped") {
        cross(`awehitch bridge — ${reasonText}`);
      } else {
        say(`· Bridge is not running (${reasonText}).`);
      }
    }

    if (registryRoots.length > 0) {
      say(`  Registered workspaces (${registryRoots.length}):`);
      for (const root of registryRoots) say(`    · ${root}`);
    } else if (observation.state === "healthy") {
      say("  No workspaces registered yet: run `awehitch up -w <directory>`.");
    }
    if (legacy.length > 0) {
      say(`· ${legacy.length} leftover pre-0.2.6 runtime record(s); they stop being written after the next \`awehitch up\`.`);
    }
    if (observation.state === "stopped" && observation.reason !== "legacy_workspace_scoped") {
      say("Start it: awehitch up -w <workspace>");
    }
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose and auto-repair the connection (--no-fix for a strictly read-only check)")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--control-plane", "also probe the live ChatGPT DOM (launches the control-plane browser)", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; fix: boolean; controlPlane: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const report: Record<string, { ok: boolean; detail?: string }> = {};
    const results: string[] = [];

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };

    // Codex sandbox writable_roots (only relevant when a codex adapter is installed)
    const codexStatus = (await loadAdapter("codex").catch(() => null))?.status();
    if (codexStatus?.mcpRegistered) {
      if (opts.fix) {
        const sandbox = trySandboxAllow();
        if (sandbox.ok) {
          report.sandbox = { ok: true, detail: sandbox.alreadyAllowed ? "already allowlisted" : "written to allowlist" };
          if (sandbox.added) results.push("Added the state dir to the Codex sandbox allowlist");
        } else {
          report.sandbox = { ok: false, detail: sandbox.error };
        }
      } else {
        try {
          const configPath = getCodexConfigPath();
          const allowed =
            fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), getStateDir());
          report.sandbox = allowed ? { ok: true, detail: "already allowlisted" } : { ok: false, detail: "not allowlisted" };
        } catch (error) {
          report.sandbox = { ok: false, detail: (error as Error).message };
        }
      }
    }

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      report.workspace = { ok: true, detail: workspace.name };
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    // The dispatch marker is informational: the bridge/tunnel/connector
    // machinery is the data plane however the user drives the conversation.

    // Bridge
    let runtime: RuntimeState | null = null;
    let bridgeUnknown = false;
    {
      const observation = await findBridgeObservation();
      if (observation.state === "healthy") {
        runtime = observation.runtime;
      } else if (observation.state === "unknown") {
        bridgeUnknown = true;
        report.bridge = { ok: false, detail: `state uncertain (${observation.reason}); not auto-repaired` };
      } else if (opts.fix) {
        try {
          runtime = (await ensureBridge(root)).runtime;
          results.push("Started the bridge automatically");
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      }
      if (runtime) report.bridge = { ok: true, detail: `port ${runtime.port}` };
      else report.bridge = report.bridge ?? { ok: false, detail: "not running" };
    }

    // Dispatch config: echo the marker the user types to authorize work from
    // their own ChatGPT conversation.
    if (workspace) {
      report.dispatch = {
        ok: true,
        detail: `dispatch marker ${resolveDispatchMarker(workspace.projectConfig.dispatchMarker)}`,
      };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        report.mcp = { ok: response.status === 401, detail: `unauthorized request returned ${response.status}` };
        report.oauth = { ok: response.status === 401 };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = error instanceof Error && error.name === "AbortError";
        report.mcp = { ok: false, detail: timedOut ? "MCP probe timed out" : message };
      }
    }

    // Tunnel + remote reachability
    const lastEndpoint = readLastEndpoint();
    const connectorName = connectorNameFor({
      previousName: lastEndpoint?.connectorName,
      legacyMatch: legacyEndpointForMcpUrl(lastEndpoint?.mcpUrl),
    });
    const tunnelState = readTunnelState();
    const namedReady = isNamedTunnelReady(tunnelState);
    let namedRepair: { needed: boolean; userMessage?: string } = { needed: false };
    let chatgptRepair: {
      needed: boolean;
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
      pairingCode?: string;
      pairingExpiresAt?: number;
      pages: {
        developerMode: string;
        plugins: string;
        createConnector: string;
      };
    } = {
      needed: false,
      connectorAction: "none",
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
      pages: {
        developerMode: CHATGPT_DEVELOPER_MODE_URL,
        plugins: CHATGPT_PLUGINS_URL,
        createConnector: CHATGPT_CREATE_CONNECTOR_URL,
      },
    };

    if (runtime) {
      let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      if (namedReady && opts.fix && info.tunnel.provider !== "cloudflare-named") {
        await stopBridge();
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          runtime = (await ensureBridge(root)).runtime;
          info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
          results.push("Switched to the named hostname connection");
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }
      const expectedPublic = Boolean(lastEndpoint?.publicUrl) || namedReady;
      let currentUrl = info.publicUrl ?? info.tunnel.url;
      let healthy = false;
      if (currentUrl) {
        try {
          const response = await fetch(`${currentUrl}/health`, { signal: AbortSignal.timeout(8000) });
          healthy = response.ok;
        } catch {
          healthy = false;
        }
      }

      if ((!currentUrl || !healthy) && opts.fix && (expectedPublic || info.tunnel.running)) {
        try {
          const binaries = detectTunnelBinaries();
          if (!binaries.cloudflared) {
            report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
          } else {
            const started = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
            if (started.url) {
              const previousUrl = lastEndpoint?.publicUrl;
              currentUrl = started.url;
              healthy = true;
              info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
              const sameAddress =
                previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(started.url);
              results.push(sameAddress ? "Secure connection re-established" : "Secure connection re-established (address changed)");
            }
          }
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }

      if (currentUrl && healthy) {
        report.tunnel = { ok: true, detail: currentUrl };
        const nextMcp = mcpUrlFromPublic(currentUrl);
        const action = connectorAction(lastEndpoint?.mcpUrl, nextMcp);
        const boundName = nextMcp
          ? opts.fix
            ? persistMachineEndpoint({
                port: runtime.port,
                publicUrl: currentUrl,
                mcpUrl: nextMcp,
                previous: lastEndpoint,
              })
            : connectorNameFor({
                previousName: lastEndpoint?.connectorName,
                legacyMatch: legacyEndpointForMcpUrl(nextMcp),
              })
          : connectorName;
        chatgptRepair = {
          ...chatgptRepair,
          needed: action === "update",
          reason: action === "update" ? "address_reclaimed" : undefined,
          connectorAction: action,
          connectorName: boundName,
          userMessage: action === "update" ? reclaimUserMessage(boundName) : undefined,
          mcpUrl: nextMcp,
          previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
        };
        if (action === "update" && opts.fix) {
          try {
            const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
            chatgptRepair.pairingCode = pairing.code;
            chatgptRepair.pairingExpiresAt = pairing.expiresAt;
            results.push(`Generated a new pairing code; update "${boundName}"`);
          } catch (error) {
            report.oauth = { ok: false, detail: (error as Error).message };
          }
        }
      } else if (namedReady) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "NAMED_TUNNEL_DOWN" };
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
      } else if (expectedPublic) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "secure connection not restored" };
        chatgptRepair = {
          ...chatgptRepair,
          needed: true,
          reason: "address_reclaimed",
          connectorAction: "update",
          connectorName,
          userMessage: reclaimUserMessage(connectorName),
          mcpUrl: null,
        };
      } else if (!currentUrl) {
        report.tunnel = { ok: true, detail: "disabled (local mode)" };
      } else {
        report.tunnel = { ok: false, detail: "public address unreachable" };
      }
    } else if (bridgeUnknown) {
      report.tunnel = report.tunnel ?? { ok: false, detail: "bridge state uncertain; connector repair skipped" };
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
    } else if (lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: "secure connection not running" };
      chatgptRepair = {
        ...chatgptRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    // Harness adapters
    const adapters: Record<string, unknown> = {};
    for (const harness of HARNESS_IDS) {
      try {
        const impl = await loadAdapter(harness);
        const status = impl.status();
        const installed = status.skillInstalled && status.mcpRegistered;
        adapters[harness] = {
          installed,
          skillInstalled: status.skillInstalled,
          mcpRegistered: status.mcpRegistered,
        };
      } catch {
        adapters[harness] = { installed: false };
      }
    }

    // Control-plane selector pack (cheap, always reported) + optional live probe
    const selectorPack = loadSiteSelectors();
    report.selectors = {
      ok: selectorPack.problems.length === 0,
      detail:
        `${selectorPack.site.id}/${selectorPack.site.version}` +
        (selectorPack.source === "override" ? " (override file active)" : "") +
        (selectorPack.problems.length > 0 ? `；${selectorPack.problems.join("；")}` : ""),
    };
    let controlPlane: { ok: boolean; detail?: string; probe?: SelectorProbe } | undefined;
    if (opts.controlPlane) {
      if (!workspace) {
        report.controlPlane = { ok: false, detail: "workspace could not be identified" };
      } else {
        const driver = new ControlPlaneBrowser(workspace.id);
        try {
          await driver.openConversation();
          const page = await driver.currentPage();
          const probe = await probeSelectors(page, selectorPack.site);
          // composer + userTurn must hit; loginWall must NOT (it means a login
          // wall is visible); assistantTurn/generating may be absent on an
          // empty chat, so they are informational only.
          const broken = [
            ...(!probe.composer.found ? ["composer"] : []),
            ...(!probe.userTurn.found ? ["userTurn"] : []),
            ...(probe.loginWall.found ? ["login wall visible (needs `awehitch login`)"] : []),
          ];
          controlPlane = {
            ok: broken.length === 0,
            detail: broken.length === 0 ? "DOM probes passed" : broken.join(", "),
            probe,
          };
          report.controlPlane = { ok: controlPlane.ok, detail: controlPlane.detail };
        } catch (error) {
          report.controlPlane = { ok: false, detail: (error as Error).message };
        } finally {
          await driver.close().catch(() => undefined);
        }
      }
    }

    // The connector is now created/updated by the control-plane browser, so
    // doctor points at that command instead of talking the user through it.
    const connectorSetupCommand = `awehitch connector-setup -w ${root}`;
    const chatgptSetup = {
      needed: chatgptRepair.connectorAction !== "none",
      action: chatgptRepair.connectorAction,
      command: connectorSetupCommand,
      dryRunCommand: `${connectorSetupCommand} --dry-run`,
    };

    if (opts.json) {
      say(
        JSON.stringify({
          report,
          repairs: results,
          chatgptRepair,
          chatgptSetup,
          namedRepair,
          adapters,
          selectors: {
            site: { id: selectorPack.site.id, version: selectorPack.site.version },
            source: selectorPack.source,
            problems: selectorPack.problems,
          },
          controlPlane,
        })
      );
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      bridge: "Bridge",
      mcp: "MCP",
      oauth: "OAuth",
      tunnel: "Tunnel",
      dispatch: "Dispatch",
      selectors: "Selectors",
      controlPlane: "Control-plane DOM",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? `（${value.detail}）` : ""}`);
      else {
        cross(`${label}${value.detail ? `：${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    const installedHarnesses = Object.entries(adapters)
      .filter(([, value]) => (value as { installed: boolean }).installed)
      .map(([name]) => harnessLabel(name as HarnessId));
    if (installedHarnesses.length > 0) say(`· Wired: ${installedHarnesses.join(", ")}`);
    say("");
    if (namedRepair.needed && namedRepair.userMessage) {
      say(namedRepair.userMessage);
      say("");
    }
    if (chatgptRepair.needed && chatgptRepair.userMessage) {
      say(chatgptRepair.userMessage);
      if (chatgptRepair.mcpUrl) say(`New connection URL: ${chatgptRepair.mcpUrl}`);
      if (chatgptRepair.pairingCode) say(`Pairing code: ${chatgptRepair.pairingCode}`);
      say("");
    }
    if (chatgptSetup.needed) {
      if (readUiPrefs().setupMode === "manual") {
        say(`Guided manual steps, no browser (setup mode: manual): ${chatgptSetup.command}`);
      } else {
        say(`Can finish automatically (opens the control-plane browser): ${chatgptSetup.command}`);
      }
      say(`Just probe page elements: ${chatgptSetup.dryRunCommand}`);
      say("");
    }
    say(
      allOk && !chatgptRepair.needed && !namedRepair.needed
        ? "Everything looks good."
        : chatgptRepair.needed
          ? "Local side is ready; the ChatGPT connector needs an update — run `awehitch connector-setup`."
          : namedRepair.needed
            ? "The stable hostname is not connected yet; log in to Cloudflare first."
            : "Some issues remain; try `awehitch restart --tunnel`."
    );
    if (!allOk || namedRepair.needed) process.exitCode = 1;
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair", { hidden: true })
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(`Pairing code: ${pairing.code}`);
        say(`(valid for ${Math.round((pairing.expiresAt - Date.now()) / 60000)} min, single use)`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair", { hidden: true })
  .description("Revoke ChatGPT's access on this machine immediately")
  .option("-w, --workspace <path>", "accepted for compatibility; access is machine-wide")
  .action(async () => {
    const runtime = await findLiveBridge();
    if (runtime) {
      await adminFetch(runtime, "POST", "/admin/revoke-all");
    } else {
      // bridge not running: revoke directly in the persisted store
      new AuthStore().revokeAll();
    }
    check("Disconnected ChatGPT from this machine (all tokens revoked)");
  });

// ---------------------------------------------------------------- logs / workspace / record

program
  .command("logs", { hidden: true })
  .description("Show recent bridge logs")
  .option("-n, --lines <n>", "number of lines", parsePositiveInteger, 50)
  .option("--verbose", "include debug detail", false)
  .action((opts: { lines: number; verbose: boolean }) => {
    try {
      const candidates = [
        path.join(getStateDir(), "logs", "bridge.log"),
        path.join(getStateDir(), "logs", "bridge.out.log"),
      ];
      let shown = false;
      for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        const lines = fs.readFileSync(file, "utf8").trim().split("\n");
        const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
        say(filtered.slice(-opts.lines).join("\n"));
        shown = true;
      }
      if (!shown) say("No logs yet.");
    } catch (error) {
      handleCliError(error, false);
    }
  });

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots)

program
  .command("sandbox-allow", { hidden: true })
  .description("Add the local settings directory to the Codex sandbox allowlist")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`Could not write the Codex sandbox allowlist: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("Sandbox allowlist ready; later chats need no elevation");
    else check("Added the state dir to the Codex sandbox allowlist (later chats need no elevation)");
  });

// ---------------------------------------------------------------- session (ChatGPT conversation / Project memory)

const session = program
  .command("session", { hidden: true })
  .description("Remember the ChatGPT Project and conversation for this workspace");

session
  .command("get", { isDefault: true })
  .description("Show the saved ChatGPT conversation / Project for this workspace")
  .option("-w, --workspace <path>")
  .option("-H, --harness <id>", "harness slice (must match the control-plane's --harness)", parseHarnessKey)
  .option("--task <id>", "read a specific task's checkpoint slot instead of the workspace slot")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; harness?: string; task?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const saved = opts.task
        ? readTaskSession(workspace.id, opts.task, opts.harness)
        : readSession(workspace.id, opts.harness);
      const conversation = resolveConversation(saved);
      if (opts.json) say(JSON.stringify({ ok: true, task: opts.task ?? null, session: saved, conversation }));
      else if (!saved) {
        say(opts.task ? `No checkpoint recorded for task ${opts.task}.` : "No ChatGPT conversation recorded yet. New workspaces default to a Project collection.");
      } else {
        say(opts.task ? `Task ${opts.task}:` : `Mode: ${conversation.mode === "project" ? "Project collection" : "long-running chat"}`);
        if (conversation.projectUrl) say(`Collection: ${conversation.projectUrl}`);
        if (saved.title) say(`Session: ${saved.title}`);
        if (saved.url) say(`Chat: ${saved.url}`);
        if (saved.connectorName) say(`Connector: ${saved.connectorName}`);
        if (saved.taskId) say(`Task: ${saved.taskId} (iteration ${saved.iteration ?? 0}, ${saved.lastState ?? "?"})`);
        if (saved.checkpoint) {
          say(
            `Checkpoint: ${saved.checkpoint.protocolState} / waiting for ${saved.checkpoint.waitingFor} (iteration ${saved.checkpoint.iteration})`
          );
        }
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

session
  .command("set")
  .description("Save the ChatGPT Project and/or conversation for this workspace")
  .option("-w, --workspace <path>")
  .option("-H, --harness <id>", "harness slice (must match the control-plane's --harness)", parseHarnessKey)
  .option("--url <url>", "ChatGPT conversation URL from the address bar")
  .option("--title <title>")
  .option("--task <id>", "task id: writes this task's own checkpoint slot (concurrent sessions stay isolated)")
  .option("--iteration <n>")
  .option("--state <state>", "last protocol state, e.g. EXECUTED")
  .option("--mode <mode>", "long-chat or project")
  .option("--project-url <url>", "ChatGPT Project collection URL (…/g/g-p-…/project)")
  .option("--connector-name <name>", "exact connector title for this workspace")
  .option("--protocol-state <state>", "checkpoint protocol state, e.g. EXECUTED_SENT")
  .option("--waiting-for <who>", "none | GPT_PLAN | GPT_REVIEW | USER")
  .option("--goal <text>", "original task goal for resume / HANDOFF")
  .option("--completed-subtasks <text>")
  .option("--known-issues <text>")
  .option("--next-step <text>")
  .option("--clear-checkpoint", "drop the active checkpoint (task DONE)", false)
  .action(
    (opts: {
      workspace?: string;
      harness?: string;
      url?: string;
      title?: string;
      task?: string;
      iteration?: string;
      state?: string;
      mode?: string;
      projectUrl?: string;
      connectorName?: string;
      protocolState?: string;
      waitingFor?: string;
      goal?: string;
      completedSubtasks?: string;
      knownIssues?: string;
      nextStep?: string;
      clearCheckpoint: boolean;
    }) => {
      try {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        const modeRaw = opts.mode?.trim().toLowerCase();
        if (modeRaw && modeRaw !== "long-chat" && modeRaw !== "project") {
          throw new Error("mode must be long-chat or project");
        }
        const protocolRaw = opts.protocolState?.trim().toUpperCase();
        if (protocolRaw && !PROTOCOL_STATES.includes(protocolRaw as ProtocolState)) {
          throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
        }
        const waitingRaw = opts.waitingFor?.trim();
        const waitingNorm = waitingRaw
          ? waitingRaw.toLowerCase() === "none"
            ? "none"
            : waitingRaw.toUpperCase()
          : undefined;
        if (waitingNorm && !WAITING_FOR.includes(waitingNorm as WaitingFor)) {
          throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
        }
        const saved = mergeSession(
          opts.task
            ? readTaskSession(workspace.id, opts.task, opts.harness)
            : readSession(workspace.id, opts.harness),
          {
          url: opts.url,
          title: opts.title,
          taskId: opts.task,
          iteration: opts.iteration ? parseNonNegativeInteger(opts.iteration) : undefined,
          lastState: opts.state,
          conversationMode: modeRaw as ConversationMode | undefined,
          projectUrl: opts.projectUrl,
          connectorName: opts.connectorName,
          clearCheckpoint: opts.clearCheckpoint,
          checkpoint: protocolRaw
            ? {
                protocolState: protocolRaw as ProtocolState,
                waitingFor: (waitingNorm as WaitingFor | undefined) ?? undefined,
                originalGoal: opts.goal,
                completedSubtasks: opts.completedSubtasks,
                knownIssues: opts.knownIssues,
                nextExpectedStep: opts.nextStep,
              }
            : undefined,
        });
        if (opts.task) writeTaskSession(workspace.id, opts.task, saved, opts.harness);
        else writeSession(workspace.id, saved, opts.harness);
        if (saved.projectUrl && saved.conversationMode === "project") {
          check("Recorded the ChatGPT collection; later chats open or reuse from the collection page");
        } else if (opts.task) {
          check(`Recorded the checkpoint for task ${opts.task}`);
        } else {
          check("Recorded the ChatGPT conversation; later tasks will reuse it");
        }
      } catch (error) {
        handleCliError(error, false);
      }
    }
  );

session
  .command("clear")
  .description("Forget the current ChatGPT chat (Project binding is kept)")
  .option("-w, --workspace <path>")
  .option("-H, --harness <id>", "harness slice (must match the control-plane's --harness)", parseHarnessKey)
  .option("--task <id>", "clear a specific task's checkpoint slot instead of the workspace slot")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; harness?: string; task?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      if (opts.task) {
        const existed = readTaskSession(workspace.id, opts.task, opts.harness) !== null;
        fs.rmSync(taskSessionFile(workspace.id, opts.task, opts.harness), { force: true });
        if (!existed) say(`No checkpoint recorded for task ${opts.task}.`);
        else check(`Cleared the checkpoint for task ${opts.task}`);
        return;
      }
      const result = clearChatPointer(workspace.id, opts.harness);
      if (!result.cleared) say("No ChatGPT conversation recorded yet.");
      else if (result.keptProject) check("Cleared the current chat; the collection binding is kept");
      else check("Cleared the conversation record; the next task opens a new ChatGPT chat");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- prefs

const prefsCmd = program
  .command("prefs", { hidden: true })
  .description("Remember ChatGPT developer mode and setup choice for this machine");

prefsCmd
  .command("get", { isDefault: true })
  .description("Show remembered ChatGPT setup choices (not per workspace)")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const prefs = readUiPrefs();
    if (opts.json) {
      say(JSON.stringify({ ok: true, ...prefs }));
      return;
    }
    say(prefs.developerModeEnabled ? "Developer mode: remembered as on" : "Developer mode: not remembered");
    if (prefs.setupMode === "auto") say("Setup mode: AI automated setup (preview)");
    else if (prefs.setupMode === "manual") say("Setup mode: guided manual setup");
    else say("Setup mode: not chosen yet");
  });

prefsCmd
  .command("set")
  .description("Save a ChatGPT setup choice for this machine")
  .option("--developer-mode", "remember that ChatGPT developer mode is on", false)
  .option("--setup-mode <mode>", "auto (preview) or manual")
  .option("--json", "machine-readable output", false)
  .action((opts: { developerMode: boolean; setupMode?: string; json: boolean }) => {
    try {
      const modeRaw = opts.setupMode?.trim().toLowerCase();
      if (modeRaw && !SETUP_MODES.includes(modeRaw as SetupMode)) {
        throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
      }
      if (!opts.developerMode && !modeRaw) {
        throw new Error("nothing to save: pass --developer-mode and/or --setup-mode");
      }
      const prefs = mergeUiPrefs({
        developerModeEnabled: opts.developerMode ? true : undefined,
        setupMode: modeRaw as SetupMode | undefined,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...prefs }));
        return;
      }
      if (opts.developerMode) check("Remembered that developer mode is on");
      if (modeRaw === "auto") check("Remembered setup mode: AI automated setup (preview)");
      if (modeRaw === "manual") check("Remembered setup mode: guided manual setup");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- record (harness execution summaries)

program
  .command("record", { hidden: true })
  .description("Record a coding-agent execution summary (used by the skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>", "non-negative execution iteration", parseNonNegativeInteger)
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked or 0-255", parseExitStatus, "ok")
  .option("--notes <text>")
  .option("--command <text>", "command whose output may be offered to ChatGPT")
  .option("--output <text>", "command output (prefer --output-file for long logs)")
  .option("--output-file <path>", "read command output from a local file")
  .option("--exit-code <n>", "numeric exit code of that command", parseInteger)
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: number;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
      command?: string;
      output?: string;
      outputFile?: string;
      exitCode?: number;
    }) => {
      try {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        const changed = parseChangedFiles(opts.changedFiles);
        let outputId: number | undefined;
        let outputAvailable = false;
        let rawOutput: string | undefined;
        if (opts.outputFile !== undefined) {
          try {
            rawOutput = readCappedUtf8(path.resolve(opts.outputFile), MAX_RECORD_OUTPUT_READ);
          } catch (error) {
            throw new Error(
              `Cannot read --output-file: ${(error as Error).message}. ` +
                `Ensure the file exists and the directory path is correct.`
            );
          }
        } else {
          rawOutput = opts.output;
        }
        if (opts.command && rawOutput !== undefined) {
          const savedOutput = saveExecutionOutput(workspace.id, {
            command: opts.command,
            raw: rawOutput,
            exitCode: opts.exitCode ?? null,
            taskId: opts.task,
            iteration: opts.iteration,
          });
          outputId = savedOutput.id;
          outputAvailable = savedOutput.allowed;
        }
        appendExecutionRecord(workspace.id, {
          taskId: opts.task,
          iteration: opts.iteration,
          changedFiles: changed,
          tests: opts.tests ?? null,
          exitStatus: opts.exitStatus,
          timestamp: new Date().toISOString(),
          notes: opts.notes?.slice(0, 400),
          outputId,
          outputAvailable,
        });
        if (outputId !== undefined && !outputAvailable) check("Recorded the execution summary (output not exposed to ChatGPT)");
        else if (outputId !== undefined) check("Recorded the execution summary and output");
        else check("Recorded the execution summary");
      } catch (error) {
        handleCliError(error, false);
      }
    }
  );

// ---------------------------------------------------------------- tunnel

const tunnelCmd = program.command("tunnel").description("Choose or inspect the public connection for this workspace");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this machine still needs a one-time connection choice")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .action((opts: { zone?: string; json: boolean }) => {
    try {
      const payload = tunnelChoicePayload(opts.zone);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) say(TUNNEL_CHOICE_PROMPT);
      else if (payload.namedReady) check(`Stable hostname: ${payload.hostname}`);
      else say("Using a temporary address.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the default c2c.<zone>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { mode: string; zone?: string; hostname?: string; json: boolean }) => {
    try {
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState();
      if (mode === "quick") {
        const state = chooseQuickTunnel();
        // The bridge picks its tunnel at startup: stop it so the next `up`
        // comes back with the new connection kind.
        if (previous.preference === "named" && (await findLiveBridge())) await stopBridge();
        const payload = { ...tunnelChoicePayload(), state };
        if (opts.json) say(JSON.stringify(payload));
        else check("Using a temporary address");
        return;
      }
      if (mode !== "named") {
        throw new Error("mode must be quick or named");
      }
      const zone = parseZoneInput(opts.zone ?? "");
      if (!zone) {
        const payload = {
          ok: false,
          need: "zone",
          userMessage: "Tell me the domain already added to Cloudflare, for example example.com",
          loginPrompt: NAMED_LOGIN_PROMPT,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(payload.userMessage);
        return;
      }
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        zone,
        hostname: opts.hostname,
      });
      if (await findLiveBridge()) await stopBridge();
      const payload = {
        ...tunnelChoicePayload(),
        ok: true,
        fallback: result.fallback,
        userMessage: result.userMessage,
        error: result.error,
        state: result.state,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (result.fallback) say(result.userMessage ?? "");
      else check(`Stable hostname ready: ${result.state.hostname}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("protocol")
  .description(
    "Pin the named tunnel's edge transport. Use http2 when QUIC (UDP 7844) is blocked or tampered with on this network"
  )
  .argument("<protocol>", "quic, http2, or unset (back to cloudflared's own choice)")
  .option("--json", "machine-readable output", false)
  .action(async (protocol: string, opts: { json: boolean }) => {
    try {
      const wanted = protocol.trim().toLowerCase();
      if (wanted !== "quic" && wanted !== "http2" && wanted !== "unset") {
        throw new Error("protocol must be quic, http2, or unset");
      }
      const state = readTunnelState();
      if (!isNamedTunnelReady(state)) {
        throw new Error("No named tunnel on this machine yet; run `awehitch tunnel choose --mode named` first");
      }
      const next = writeTunnelState({
        ...state,
        protocol: wanted === "unset" ? undefined : (wanted as TunnelProtocol),
      });
      // The bridge builds its tunnel provider at startup: stop a live bridge
      // so the next `up` dials with the new transport.
      const wasLive = Boolean(await findLiveBridge());
      if (wasLive) await stopBridge();
      const payload = {
        ok: true,
        protocol: next.protocol ?? null,
        hostname: next.hostname ?? null,
        stoppedBridge: wasLive,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      check(`Named tunnel transport: ${next.protocol ?? "cloudflared's own choice (QUIC first)"}`);
      if (wasLive) say("The running bridge was stopped; run `awehitch up` to come back with the new transport.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("login")
  .description("Open the Cloudflare login window used by a named hostname")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login();
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check("Logged in to Cloudflare");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("One step needed from you:");
    say("");
    say("cloudflared is not installed yet.");
    say("On macOS run: brew install cloudflared");
    say("Then try again.");
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

// Only parse when actually invoked as the CLI. Importing this module (as the
// tests do) must not tear down the process or parse vitest's argv.
const isMainEntry =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainEntry) {
  program.parseAsync(process.argv).catch((error: Error) => {
    cross(error.message);
    process.exit(1);
  });
}
