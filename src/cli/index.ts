import { Command, InvalidArgumentError } from "commander";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { findBridgeObservation, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
} from "../tunnel/named-provision.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  NAMED_REPAIR_MESSAGE,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
} from "../tunnel/state.js";
import { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import { mergeUiPrefs, readUiPrefs, SETUP_MODES, type SetupMode } from "../config/ui-prefs.js";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  connectorAction,
  connectorNameFor,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import {
  clearChatPointer,
  mergeSession,
  readSession,
  resolveConversation,
  writeSession,
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
import {
  runConnectorSetup,
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

function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  return connectorName;
}

function tunnelChoicePayload(workspace: Workspace, zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState(workspace.id);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, workspace.name, workspace.id) : null,
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
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
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
  opts: { tunnel: boolean }
): Promise<{ runtime: RuntimeState; info: AdminInfo; mcpUrl: string | null }> {
  const { runtime } = await ensureBridge(workspaceRoot);
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
  return { runtime, info, mcpUrl };
}

/**
 * Revoke ChatGPT's access for a workspace: via the live bridge when one is
 * running, otherwise directly on the persisted auth store. Split out so tests
 * can exercise the offline (no-bridge) path without a running daemon.
 */
export async function revokeConnectorAccess(workspaceId: string): Promise<void> {
  const runtime = await findLiveBridge(workspaceId);
  if (runtime) {
    await adminFetch(runtime, "POST", "/admin/revoke-all");
  } else {
    // bridge not running: revoke directly in the persisted store
    new AuthStore(workspaceId).revokeAll();
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

program
  .name("awehitch")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Your agent works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true })
  .addHelpText("after", "\n内部/高级命令（doctor、session、tunnel 等）仍可用：awehitch <命令> --help");

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
    message: payload.error?.message ?? "连接器创建未完成。",
  };
}

/**
 * Create/repair the ChatGPT connector, mirroring connector-setup's 409 rename
 * persistence and tokenCount baseline (see that command for why tokensBefore
 * must be captured before the run).
 */
async function runConnectorFor(
  workspace: Workspace,
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
    workspaceId: workspace.id,
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
      workspaceId: workspace.id,
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
// deliberately not shown here.
program
  .command("up", { isDefault: true })
  .description("Connect this workspace to ChatGPT (idempotent; the only manual step is logging in)")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--harness <id>", "harness adapter to install (repeatable, overrides auto-detection)", parseHarnessOption, [] as HarnessId[])
  .option("--no-tunnel", "local-only mode (skip the public connection)")
  .option("--json", "machine-readable output", false)
  .option("--timeout <minutes>", "how long to wait for the ChatGPT login", parseInteger, 5)
  .action(async (opts: UpOptions) => {
    const root = resolveWorkspace(opts.workspace);
    const json = opts.json;
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

    if (!json) {
      say(PRODUCT_NAME);
      say("");
      say("正在连接 ChatGPT…");
      say("");
    }

    // 1. Bridge + (temporary) tunnel. Never asks the Cloudflare choice prompt.
    let runtime: RuntimeState;
    let info: AdminInfo;
    let mcpUrl: string | null;
    try {
      const out = await ensureBridgeAndTunnel(root, { tunnel: !opts.noTunnel });
      runtime = out.runtime;
      info = out.info;
      mcpUrl = out.mcpUrl;
    } catch (error) {
      handleCliError(error, json);
      return;
    }

    const onNotice = (message: string): void => {
      if (!json) process.stderr.write(message + "\n");
    };
    const connectorName = mcpUrl
      ? persistWorkspaceEndpoint({
          workspaceId: info.workspaceId,
          workspaceName: info.workspaceName,
          port: runtime.port,
          publicUrl: info.publicUrl,
          mcpUrl,
        })
      : readLastEndpoint(info.workspaceId)?.connectorName ?? connectorNameFor({
          workspaceName: info.workspaceName,
          workspaceId: info.workspaceId,
          previousName: readLastEndpoint(info.workspaceId)?.connectorName,
          hadEndpointBefore: Boolean(readLastEndpoint(info.workspaceId)),
        });

    // 2. Decide whether the ChatGPT side needs any action. Without a public
    //    address there is nothing to connect (local mode). When the address is
    //    unchanged AND we already hold an authorized token, do not touch
    //    ChatGPT at all (a fresh pairing would invalidate the old code).
    const action = mcpUrl ? connectorAction(readLastEndpoint(info.workspaceId)?.mcpUrl, mcpUrl) : "none";
    const addressChanged = action === "update";
    let connectorUpdated = false;
    // Holder object: assignments happen inside the closure below; a bare `let`
    // would be narrowed back to `null` at the use site.
    const connector: { outcome: ConnectorOutcome | null } = { outcome: null };
    if (mcpUrl && !(action === "none" && info.tokenCount > 0)) {
      const attempt = async (): Promise<"ok" | "failed" | "paused"> => {
        const outcome = await runConnectorFor(workspace, runtime, info, mcpUrl, connectorName, opts.timeout, onNotice);
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
          say("请在打开的窗口里登录 ChatGPT，完成后回来按回车…");
          await waitForEnter();
          await interactiveLogin(workspace.id, opts.timeout * 60_000).catch(() => undefined);
          const retry = await runConnectorFor(workspace, runtime, info, mcpUrl, connectorName, opts.timeout, onNotice);
          if (retry.result.ok) {
            connector.outcome = retry;
            connectorUpdated = true;
            return "ok";
          }
          handleConnectorFailure(retry, json);
          return "failed";
        }
        if (code === "CONNECTOR_NEEDS_HUMAN" && json) {
          say(JSON.stringify({ ok: false, needsLogin: true, message: "请在打开的窗口里登录 ChatGPT，完成后重新运行 awehitch" }));
          return "paused";
        }
        if (code === "CONNECTOR_PAIRING_REJECTED") {
          onNotice("配对码已失效，已重新生成并重试。");
          const retry = await runConnectorFor(workspace, runtime, info, mcpUrl, connectorName, opts.timeout, onNotice);
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
          // else already printed its honest failure.
          if (verdict === "failed") process.exitCode = 1;
          return;
        }
      } catch (error) {
        handleCliError(error, json);
        return;
      }
    }

    // 3. Harness adapters (idempotent; a wiring failure must not abort the
    //    connection). Codex gets its sandbox allowlist alongside.
    const harnesses: { id: string; installed: boolean; skillPath?: string }[] = [];
    for (const harness of requested) {
      try {
        const impl = await loadAdapter(harness);
        const base = readLastEndpoint(info.workspaceId)?.connectorName ?? connectorName;
        const result = impl.setup({ workspaceRoot: root, cliEntry: awehitchCliEntry(), connectorName: base });
        harnesses.push({ id: harness, installed: true, skillPath: result.skillPath });
        if (harness === "codex") trySandboxAllow();
      } catch (error) {
        harnesses.push({ id: harness, installed: false });
        if (!json) process.stderr.write("接入 " + harnessLabel(harness) + " 失败：" + (error as Error).message + "\n");
      }
    }

    // 4. Output.
    const finalName = connector.outcome?.connectorName ?? connectorName;
    const tunnelState = readTunnelState(info.workspaceId);
    if (json) {
      say(JSON.stringify({
        ok: true,
        workspaceId: info.workspaceId,
        workspaceName: info.workspaceName,
        connectorName: finalName,
        mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
        port: runtime.port,
        tunnel: {
          mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
          hostname: tunnelState.hostname ?? null,
        },
        harnesses,
        needsLogin: false,
        connectorUpdated,
      }));
      return;
    }

    say(PRODUCT_NAME);
    say("");
    if (mcpUrl) check(`ChatGPT 已连上你的项目 ${info.workspaceName}`);
    else say("· 本地模式已启动（未建立公网连接，ChatGPT 暂时无法访问）");
    if (requested.length === 0) say("· 未检测到编码 agent（codex / opencode / zcode），可用 --harness 指定");
    else say(`· 已接入 ${requested.map((h) => harnessLabel(h)).join("、")}`);
    say("");
    say("以后在 agent 里说「用 ChatGPT 帮我规划 XXX」就行。");
    say("重启电脑后它一般自己修好；实在不行就再跑一次 awehitch。");
    if (addressChanged) {
      say("");
      say("连接地址已更换并自动修复。地址偶尔会变属于正常现象；如果太频繁，可以配置固定域名（awehitch tunnel choose --mode named）。");
    }
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
    say("可以手动完成这几步：");
    for (const step of outcome.result.manualFallback.steps) say("· " + step);
  }
}

// ---------------------------------------------------------------- off (disconnect)

program
  .command("off")
  .description("Disconnect ChatGPT from this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    try {
      await revokeConnectorAccess(workspace.id);
      await stopBridge(root);
    } catch (error) {
      handleCliError(error, opts.json);
      return;
    }
    if (opts.json) {
      const name = readLastEndpoint(workspace.id)?.connectorName;
      say(JSON.stringify({ ok: true, workspaceName: workspace.name, connectorName: name ?? null, pluginsUrl: "https://chatgpt.com/plugins" }));
      return;
    }
    check(`已断开 ChatGPT 对 ${workspace.name} 的访问`);
    const name = readLastEndpoint(workspace.id)?.connectorName;
    if (name) say("· 如需彻底移除，可在 ChatGPT 插件页删除「" + name + "」：https://chatgpt.com/plugins");
  });

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; port?: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const bridge = await startBridge({
      workspaceRoot: resolveWorkspace(opts.workspace),
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
    });
    const shutdown = (): void => {
      void bridge.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- control-plane (stdio MCP)

program
  .command("control-plane", { hidden: true })
  .description("Run the control-plane proxy as a stdio MCP server (spawned by harnesses)")
  .requiredOption("--workspace <path>")
  .action(async (opts: { workspace: string }) => {
    await runStdioServer(resolveWorkspace(opts.workspace));
  });

// ---------------------------------------------------------------- start

program
  .command("start", { hidden: true })
  .description("Start (or reuse) the bridge for this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--tunnel", "also establish the secure public connection", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : readLastEndpoint(info.workspaceId)?.connectorName;
      if (opts.json) {
        say(JSON.stringify({ ok: true, port: runtime.port, workspaceId: info.workspaceId, mcpUrl, connectorName }));
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
    } catch (error) {
      handleCliError(error, opts.json);
    }
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
        say("正在连接 ChatGPT…");
        say("");
      }
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : connectorNameFor({
            workspaceName: info.workspaceName,
            workspaceId: info.workspaceId,
            previousName: readLastEndpoint(info.workspaceId)?.connectorName,
            hadEndpointBefore: Boolean(readLastEndpoint(info.workspaceId)),
          });
      const pairingResult = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      const tunnelState = readTunnelState(info.workspaceId);

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
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
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
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
      if (adapter) check(`已接入 ${harnessLabel(adapter.harness as HarnessId)}`);
      say("");
      say(`连接地址：${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
      say(`配对码：${pairingResult.code}（${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} 分钟内有效）`);
      say("");
      say("下一步：运行 `awehitch connector-setup -w <workspace>` 自动创建 ChatGPT 连接器。");
      say("（地址与配对码无需手抄；若你用的是 awehitch skill 的 agent，这一步它会自动跑。）");
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
      else if (loggedIn) check("ChatGPT 已登录（控制面浏览器就绪）");
      else cross("等待登录超时，请重试 awehitch login");
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
    say("元素定位：");
    for (const [target, hit] of Object.entries(result.probe)) {
      say(`· ${target}：${hit.selector ? `命中 ${hit.selector}（${hit.count} 个）` : "未命中"}`);
    }
    if (result.unresolved && result.unresolved.length > 0) {
      say("");
      say(`未定位到的必需元素：${result.unresolved.join("、")}`);
      say("可在 selectors.json 里覆盖对应项后重试。");
    }
  }
  say("");
  if (result.ok) {
    say(dryRun ? "元素定位检查完成（未改动任何设置）。" : "Ready.");
    return;
  }
  if (result.error) {
    say(`问题：${result.error.message}`);
    say("");
  }
  // A dry run has no real address or pairing code, so its fallback is noise.
  if (!dryRun && result.manualFallback) {
    say("可以手动完成这几步：");
    for (const line of result.manualFallback.steps) say(`· ${line}`);
    say("");
    say("配对码约 5 分钟过期；过期后运行 awehitch pair 取一个新的。");
  }
}

program
  .command("connector-setup", { hidden: true })
  .alias("connector")
  .description("Create or repair this workspace's ChatGPT connector automatically")
  .option("-w, --workspace <path>")
  .option("--dry-run", "resolve the page elements and report them, change nothing", false)
  .option("--timeout <minutes>", "how long to wait for the ChatGPT login", parseInteger, 5)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; dryRun: boolean; timeout: number; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const onNotice = (message: string): void => {
      if (!opts.json) process.stderr.write(`${message}\n`);
    };
    try {
      const workspace = new Workspace(root);
      const previous = readLastEndpoint(workspace.id);
      const nameFor = (): string =>
        connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: previous?.connectorName,
          hadEndpointBefore: Boolean(previous),
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
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : nameFor();
      const resolvedMcpUrl = mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`;
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");

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
          workspaceId: info.workspaceId,
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
  .description("Stop the bridge for this workspace")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const stopped = await stopBridge(resolveWorkspace(opts.workspace));
    if (stopped) check("Bridge 已停止");
    else say("没有正在运行的 Bridge。");
  });

program
  .command("restart", { hidden: true })
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--tunnel", "re-establish the secure public connection", false)
  .action(async (opts: { workspace?: string; tunnel: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    await stopBridge(root);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const { info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      check(`Bridge 已重启（${info.workspaceName}）`);
      if (mcpUrl) check(`安全连接已建立`);
    } catch (error) {
      handleCliError(error, false);
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status", { hidden: true })
  .description("Show bridge status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    if (observation.state === "unknown") {
      if (opts.json) {
        say(JSON.stringify({ ok: false, running: null, state: "unknown", reason: observation.reason }));
      } else {
        cross(`Bridge 状态无法确认（${observation.reason}），未将其视为未运行。`);
      }
      return;
    }
    if (observation.state === "stopped") {
      if (opts.json) say(JSON.stringify({ ok: false, running: false }));
      else say("Bridge 未运行。使用 `awehitch start` 启动。");
      return;
    }
    const runtime = observation.runtime;
    const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    if (opts.json) {
      say(JSON.stringify({ ok: true, running: true, ...info }));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace：${info.workspaceName}`);
    check(`Bridge：运行中（端口 ${info.port}）`);
    if (info.tunnel.running && info.tunnel.url) check(`安全连接：${info.tunnel.url}/mcp`);
    else say("· 安全连接：未启用（本地模式）");
    say(`· 已授权连接：${info.tokenCount > 0 ? "是" : "否"}`);
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor", { hidden: true })
  .description("Diagnose and auto-repair the connection")
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
          report.sandbox = { ok: true, detail: sandbox.alreadyAllowed ? "已在白名单" : "已写入白名单" };
          if (sandbox.added) results.push("已将本地设置目录加入 Codex 沙箱白名单");
        } else {
          report.sandbox = { ok: false, detail: sandbox.error };
        }
      } else {
        try {
          const configPath = getCodexConfigPath();
          const allowed =
            fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), getStateDir());
          report.sandbox = allowed ? { ok: true, detail: "已在白名单" } : { ok: false, detail: "未在白名单" };
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

    // Bridge
    let runtime: RuntimeState | null = null;
    let bridgeUnknown = false;
    if (workspace) {
      const observation = await findBridgeObservation(workspace.id);
      if (observation.state === "healthy") {
        runtime = observation.runtime;
      } else if (observation.state === "unknown") {
        bridgeUnknown = true;
        report.bridge = { ok: false, detail: `状态无法确认（${observation.reason}），未自动修复` };
      } else if (opts.fix) {
        try {
          runtime = (await ensureBridge(root)).runtime;
          results.push("已自动启动 Bridge");
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      }
      if (runtime) report.bridge = { ok: true, detail: `端口 ${runtime.port}` };
      else report.bridge = report.bridge ?? { ok: false, detail: "未运行" };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        report.mcp = { ok: response.status === 401, detail: `未授权请求返回 ${response.status}` };
        report.oauth = { ok: response.status === 401 };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel + remote reachability
    const lastEndpoint = workspace ? readLastEndpoint(workspace.id) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
        })
      : PRODUCT_NAME;
    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;
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
        await stopBridge(root);
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          runtime = (await ensureBridge(root)).runtime;
          info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
          results.push("已切换到固定域名连接");
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
              results.push(sameAddress ? "已重新建立安全连接" : "已重新建立安全连接（地址已更换）");
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
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: currentUrl,
              mcpUrl: nextMcp,
              previous: lastEndpoint,
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
        if (action === "update") {
          try {
            const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
            chatgptRepair.pairingCode = pairing.code;
            chatgptRepair.pairingExpiresAt = pairing.expiresAt;
            results.push(`已生成新的配对码，需要更新「${boundName}」`);
          } catch (error) {
            report.oauth = { ok: false, detail: (error as Error).message };
          }
        }
      } else if (namedReady) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "NAMED_TUNNEL_DOWN" };
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
      } else if (expectedPublic) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "安全连接未恢复" };
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
        report.tunnel = { ok: true, detail: "未启用（本地模式）" };
      } else {
        report.tunnel = { ok: false, detail: "公网地址无法访问" };
      }
    } else if (bridgeUnknown) {
      report.tunnel = report.tunnel ?? { ok: false, detail: "Bridge 状态无法确认，未执行连接器修复" };
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
    } else if (lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: "安全连接未运行" };
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
        (selectorPack.source === "override" ? "（覆盖文件生效）" : "") +
        (selectorPack.problems.length > 0 ? `；${selectorPack.problems.join("；")}` : ""),
    };
    let controlPlane: { ok: boolean; detail?: string; probe?: SelectorProbe } | undefined;
    if (opts.controlPlane) {
      if (!workspace) {
        report.controlPlane = { ok: false, detail: "工作区无法识别" };
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
            ...(probe.loginWall.found ? ["登录墙可见（需要 awehitch login）"] : []),
          ];
          controlPlane = {
            ok: broken.length === 0,
            detail: broken.length === 0 ? "DOM 探针通过" : broken.join("、"),
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
      selectors: "选择器",
      controlPlane: "控制面 DOM",
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
    if (installedHarnesses.length > 0) say(`· 已接入：${installedHarnesses.join("、")}`);
    say("");
    if (namedRepair.needed && namedRepair.userMessage) {
      say(namedRepair.userMessage);
      say("");
    }
    if (chatgptRepair.needed && chatgptRepair.userMessage) {
      say(chatgptRepair.userMessage);
      if (chatgptRepair.mcpUrl) say(`新的连接地址：${chatgptRepair.mcpUrl}`);
      if (chatgptRepair.pairingCode) say(`配对码：${chatgptRepair.pairingCode}`);
      say("");
    }
    if (chatgptSetup.needed) {
      say(`可自动完成（会打开控制面浏览器）：${chatgptSetup.command}`);
      say(`只想看看页面元素能不能定位：${chatgptSetup.dryRunCommand}`);
      say("");
    }
    say(
      allOk && !chatgptRepair.needed && !namedRepair.needed
        ? "Everything looks good."
        : chatgptRepair.needed
          ? "本地已就绪，ChatGPT 里的连接需要更新——运行 awehitch connector-setup 可自动完成。"
          : namedRepair.needed
            ? "固定域名还没连上，需要先登录 Cloudflare。"
            : "仍有问题未解决，可尝试 `awehitch restart --tunnel`。"
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
        say(`配对码：${pairing.code}`);
        say(`（${Math.round((pairing.expiresAt - Date.now()) / 60000)} 分钟内有效，仅可使用一次）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair", { hidden: true })
  .description("Revoke ChatGPT's access to this workspace immediately")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) {
      await adminFetch(runtime, "POST", "/admin/revoke-all");
    } else {
      // bridge not running: revoke directly in the persisted store
      new AuthStore(workspace.id).revokeAll();
    }
    check("已断开 ChatGPT 对当前项目的访问（所有令牌已吊销）");
  });

// ---------------------------------------------------------------- logs / workspace / record

program
  .command("logs", { hidden: true })
  .description("Show recent bridge logs")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const candidates = [
      path.join(getStateDir(), "logs", "bridge.log"),
      path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say("暂无日志。");
  });

program
  .command("workspace", { hidden: true })
  .description("Show workspace identity and project info")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const project = workspace.detectProject();
    const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
    if (opts.json) say(JSON.stringify(data));
    else {
      say(`Workspace：${data.name}（${data.workspaceId}）`);
      say(`类型：${data.projectType}  语言：${data.languages.join(", ") || "-"}`);
      say(`路径：${data.root}`);
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
      cross(`无法写入 Codex 沙箱白名单：${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("沙箱白名单已就绪，后续对话无需再提权");
    else check("已将本地设置目录加入 Codex 沙箱白名单（后续对话无需再提权）");
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

program
  .command("update-check", { hidden: true })
  .description("Check the repository for a newer version (real check at most once per local day)")
  .option("--force", "check even if already checked today", false)
  .option("--json", "machine-readable output", false)
  .action((opts: { force: boolean; json: boolean }) => {
    const file = path.join(getStateDir(), "update-check.json");
    const today = new Date().toLocaleDateString("en-CA");
    let last: { date?: string; updateAvailable?: boolean } = {};
    try {
      last = JSON.parse(fs.readFileSync(file, "utf8")) as typeof last;
    } catch {
      /* first run */
    }

    const emit = (data: {
      checked: boolean;
      updateAvailable: boolean;
      localCommit?: string;
      remoteCommit?: string;
      note?: string;
    }): void => {
      if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
      else if (data.updateAvailable) say(`发现新版本（本地 ${data.localCommit?.slice(0, 7)} → 远端 ${data.remoteCommit?.slice(0, 7)}）。`);
      else say(data.note ?? "已是最新版本。");
    };

    if (!opts.force && last.date === today) {
      emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: "今天已检查过更新。" });
      return;
    }

    const local = runGit(["rev-parse", "HEAD"]);
    const remote = runGit(["ls-remote", "origin", "HEAD"]);
    if (!local.ok || !remote.ok || !remote.stdout) {
      emit({ checked: false, updateAvailable: false, note: "无法检查更新（离线或非 git 安装），已跳过。" });
      return;
    }
    const remoteCommit = remote.stdout.split(/\s/)[0];
    const updateAvailable = remoteCommit !== local.stdout;
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today, updateAvailable, remoteCommit }), { mode: 0o600 });
    emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
  });

// ---------------------------------------------------------------- session (ChatGPT conversation / Project memory)

const session = program
  .command("session", { hidden: true })
  .description("Remember the ChatGPT Project and conversation for this workspace");

session
  .command("get", { isDefault: true })
  .description("Show the saved ChatGPT conversation / Project for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const saved = readSession(workspace.id);
    const conversation = resolveConversation(saved);
    if (opts.json) say(JSON.stringify({ ok: true, session: saved, conversation }));
    else if (!saved) {
      say("尚未记录 ChatGPT 会话。新仓库默认使用 Project 合集。");
    } else {
      say(`模式：${conversation.mode === "project" ? "Project 合集" : "长对话"}`);
      if (conversation.projectUrl) say(`合集：${conversation.projectUrl}`);
      if (saved.title) say(`会话：${saved.title}`);
      if (saved.url) say(`对话：${saved.url}`);
      if (saved.connectorName) say(`连接器：${saved.connectorName}`);
      if (saved.taskId) say(`任务：${saved.taskId}（第 ${saved.iteration ?? 0} 轮，${saved.lastState ?? "?"}）`);
      if (saved.checkpoint) {
        say(
          `存档：${saved.checkpoint.protocolState} / 等待 ${saved.checkpoint.waitingFor}（第 ${saved.checkpoint.iteration} 轮）`
        );
      }
    }
  });

session
  .command("set")
  .description("Save the ChatGPT Project and/or conversation for this workspace")
  .option("-w, --workspace <path>")
  .option("--url <url>", "ChatGPT conversation URL from the address bar")
  .option("--title <title>")
  .option("--task <id>")
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
      const saved = mergeSession(readSession(workspace.id), {
        url: opts.url,
        title: opts.title,
        taskId: opts.task,
        iteration: opts.iteration ? parseInt(opts.iteration, 10) : undefined,
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
      writeSession(workspace.id, saved);
      if (saved.projectUrl && saved.conversationMode === "project") {
        check("已记录 ChatGPT 合集，后续从合集页新开或复用对话");
      } else {
        check("已记录 ChatGPT 会话，后续任务将复用");
      }
    }
  );

session
  .command("clear")
  .description("Forget the current ChatGPT chat (Project binding is kept)")
  .option("-w, --workspace <path>")
  .action((opts: { workspace?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const result = clearChatPointer(workspace.id);
    if (!result.cleared) say("尚未记录 ChatGPT 会话。");
    else if (result.keptProject) check("已清除当前对话，合集绑定仍保留");
    else check("已清除会话记录，下次任务将新建 ChatGPT 会话");
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
    say(prefs.developerModeEnabled ? "开发人员模式：已记住已开启" : "开发人员模式：尚未记住");
    if (prefs.setupMode === "auto") say("配置方式：AI 自动化配置（预览版）");
    else if (prefs.setupMode === "manual") say("配置方式：手动教学配置");
    else say("配置方式：尚未选择");
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
      if (opts.developerMode) check("已记住开发人员模式已开启");
      if (modeRaw === "auto") check("已记住配置方式：AI 自动化配置（预览版）");
      if (modeRaw === "manual") check("已记住配置方式：手动教学配置");
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
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
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
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const changed = parseChangedFiles(opts.changedFiles);
      let outputId: number | undefined;
      let outputAvailable = false;
      const rawOutput =
        opts.outputFile !== undefined
          ? readCappedUtf8(path.resolve(opts.outputFile), MAX_RECORD_OUTPUT_READ)
          : opts.output;
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
      if (outputId !== undefined && !outputAvailable) check("已记录执行摘要（输出未对 ChatGPT 开放）");
      else if (outputId !== undefined) check("已记录执行摘要与输出");
      else check("已记录执行摘要");
    }
  );

// ---------------------------------------------------------------- tunnel

const tunnelCmd = program.command("tunnel", { hidden: true }).description("Choose or inspect the public connection for this workspace");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this workspace still needs a one-time connection choice")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; zone?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const payload = tunnelChoicePayload(workspace, opts.zone);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) say(TUNNEL_CHOICE_PROMPT);
      else if (payload.namedReady) check(`固定域名：${payload.hostname}`);
      else say("当前使用临时地址。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the default c2c-<project>.<zone>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { mode: string; workspace?: string; zone?: string; hostname?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id);
      if (mode === "quick") {
        const state = chooseQuickTunnel(workspace.id);
        if (await findLiveBridge(workspace.id)) {
          if (previous.preference === "named") await stopBridge(root);
        }
        const payload = { ...tunnelChoicePayload(workspace), state };
        if (opts.json) say(JSON.stringify(payload));
        else check("已选用临时地址");
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
          userMessage: "请告诉我已经加在 Cloudflare 上的域名，例如 example.com",
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
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        zone,
        hostname: opts.hostname,
      });
      if (await findLiveBridge(workspace.id)) await stopBridge(root);
      const payload = {
        ...tunnelChoicePayload(workspace),
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
      else check(`固定域名已就绪：${result.state.hostname}`);
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
      else check("Cloudflare 已登录");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("需要你完成一步：");
    say("");
    say("尚未安装安全连接组件 cloudflared。");
    say("macOS 用户可运行：brew install cloudflared");
    say("完成后再试一次即可。");
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
