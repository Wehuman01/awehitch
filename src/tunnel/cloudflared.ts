import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { SERVICE_NAME } from "../version.js";
import { findBinary } from "./detect.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

const QUICK_TUNNEL_URL_RE = /https:\/\/[^\s|]+/gi;
const QUICK_TUNNEL_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com$/i;
const HEALTH_CHECK_INTERVAL_MS = 250;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** Render an error plus its cause chain: undici wraps the real reason ("fetch failed"). */
export function describeFetchError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && parts.length < 3) {
    parts.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return parts.join(" <- ") || String(error);
}

function isBridgeHealth(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const health = payload as Record<string, unknown>;
  return health.service === SERVICE_NAME && health.status === "ok";
}

/** Best-effort public roundtrip; not a readiness gate (see startProcess). */
async function bridgeHealth(
  fetchImpl: NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>,
  publicUrl: string
): Promise<{ ready: boolean; detail: string }> {
  const response = await fetchImpl(new URL("/health", publicUrl).toString(), {
    redirect: "error",
    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
  });
  if (!response) return { ready: false, detail: "Health check did not run" };
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ready: false, detail: `Health check returned HTTP ${response.status}` };
  }
  return {
    ready: isBridgeHealth(await response.json().catch(() => null)),
    detail: `Health check did not identify ${SERVICE_NAME}`,
  };
}

/**
 * Readiness from cloudflared's local metrics server. GET /ready answers
 * HTTP 200 with {"status":200,"readyConnections":N} once the tunnel holds
 * edge connections. This needs no DNS — unlike the public hostname, whose
 * record can stay negative-cached on local resolvers for minutes after
 * cloudflared prints the URL.
 */
async function metricsReady(
  fetchImpl: NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>,
  metricsPort: number
): Promise<{ ready: boolean; detail: string }> {
  const response = await fetchImpl(`http://127.0.0.1:${metricsPort}/ready`, {
    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ready: false, detail: `metrics /ready returned HTTP ${response.status}` };
  }
  const payload = (await response.json().catch(() => null)) as {
    ready?: unknown;
    readyConnections?: unknown;
  } | null;
  if (payload?.ready === false) return { ready: false, detail: "metrics /ready reports not ready" };
  if (typeof payload?.readyConnections === "number" && payload.readyConnections < 1) {
    return { ready: false, detail: "no edge connections yet" };
  }
  return {
    ready: true,
    detail:
      typeof payload?.readyConnections === "number"
        ? `${payload.readyConnections} edge connection(s)`
        : "ready",
  };
}

function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a metrics port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** Extract a Quick Tunnel public URL from a cloudflared log line. */
export function parseQuickTunnelUrl(line: string): string | null {
  for (const match of line.matchAll(QUICK_TUNNEL_URL_RE)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol !== "https:" || !QUICK_TUNNEL_HOST_RE.test(url.hostname)) continue;
      if (url.hostname.toLowerCase() === "api.trycloudflare.com") continue;
      return url.origin;
    } catch {
      // Ignore malformed URLs embedded in log output.
    }
  }
  return null;
}

export interface CloudflaredQuickTunnelOptions {
  startTimeoutMs?: number;
  /** Fixed metrics port for tests; production picks a free loopback port. */
  metricsPort?: number;
  spawnImpl?: (
    command: string,
    args: string[],
    options: { stdio: ["ignore", "pipe", "pipe"]; windowsHide: true }
  ) => ChildProcess;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Cloudflare Quick Tunnel provider.
 * Quick Tunnels need no account/login; the URL changes on every start,
 * which the bridge and the Skill handle by reconfiguring automatically.
 *
 * Readiness is cloudflared's own metrics /ready (edge connections up), not a
 * public roundtrip: a fresh quick-tunnel hostname is often unresolvable by
 * local DNS for minutes (the first lookup hits a record that Cloudflare has
 * not published yet, and resolvers cache the NXDOMAIN), even though ChatGPT's
 * backend — which talks to Cloudflare's authoritative DNS — can reach the
 * tunnel immediately. The public probe still runs once, best-effort, for
 * telemetry.
 */
export class CloudflaredQuickTunnel implements TunnelProvider {
  readonly name = "cloudflare-quick";
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private lastError: string | null = null;
  private readonly startTimeoutMs: number;
  private readonly metricsPort: number | undefined;
  private readonly spawnImpl: NonNullable<CloudflaredQuickTunnelOptions["spawnImpl"]>;
  private readonly fetchImpl: NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>;
  private starting: Promise<string> | null = null;
  private cancelStart: (() => void) | null = null;

  constructor(
    private readonly logger: Logger = nullLogger,
    private readonly binaryOverride?: string,
    options: CloudflaredQuickTunnelOptions = {}
  ) {
    this.startTimeoutMs = options.startTimeoutMs ?? 90_000;
    this.metricsPort = options.metricsPort;
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.url) return this.url;
    if (this.starting) return this.starting;
    const starting = this.startProcess(localPort);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private async startProcess(localPort: number): Promise<string> {
    const bin = this.binary();
    if (!bin) {
      throw new Error(
        "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
      );
    }
    const metricsPort = this.metricsPort ?? (await findFreeLoopbackPort());

    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(
          bin,
          [
            "tunnel",
            "--url",
            `http://127.0.0.1:${localPort}`,
            "--no-autoupdate",
            "--metrics",
            `127.0.0.1:${metricsPort}`,
          ],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
        );
      } catch (error) {
        reject(error);
        return;
      }
      this.child = child;
      this.url = null;
      this.lastError = null;
      let settled = false;
      let candidateUrl: string | null = null;
      let cancel: (() => void) | null = null;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const closeReaders = (): void => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      };

      const isAlive = (): boolean => this.child === child;

      const stopChild = (): void => {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may have exited between the state check and kill().
        }
      };

      const finish = (callback: () => void, closeOutput = true): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (closeOutput) closeReaders();
        if (cancel && this.cancelStart === cancel) this.cancelStart = null;
        callback();
      };

      const fail = (error: unknown): void => {
        finish(() => {
          stopChild();
          if (this.child === child) {
            this.child = null;
            this.url = null;
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };

      cancel = () => fail(new Error("Tunnel start stopped"));
      this.cancelStart = cancel;

      const ready = (url: string): void => {
        if (!isAlive()) {
          fail(new Error("cloudflared exited before the tunnel reported ready"));
          return;
        }
        finish(
          () => {
            this.url = url;
            this.lastError = null;
            this.logger.info(`Quick tunnel established: ${url}`);
            resolve(url);
          },
          false
        );
        // Telemetry only. On resolvers that negative-cache the fresh
        // hostname this fails for minutes while the tunnel serves fine.
        void bridgeHealth(this.fetchImpl, url)
          .then((probe) => {
            if (probe.ready) this.logger.info(`Public tunnel probe OK: ${url}/health`);
            else this.logger.info(`Public tunnel probe skipped: ${probe.detail}`);
          })
          .catch((error: unknown) => {
            this.logger.info(`Public tunnel probe skipped: ${describeFetchError(error)}`);
          });
      };

      const waitForReady = async (): Promise<void> => {
        let attempts = 0;
        let lastDetail = "";
        while (!settled) {
          if (!isAlive()) {
            fail(new Error("cloudflared exited before the tunnel reported ready"));
            return;
          }

          try {
            const result = await metricsReady(this.fetchImpl, metricsPort);
            if (settled) return;
            if (result.ready && candidateUrl) {
              ready(candidateUrl);
              return;
            }
            this.lastError = result.ready
              ? "edge connections up but no quick-tunnel URL in cloudflared output"
              : result.detail;
          } catch (error) {
            if (settled) return;
            this.lastError = describeFetchError(error);
          }
          if (settled) return;
          // Surface the readiness view at most every 4 attempts (~1s) and
          // whenever the failure mode changes; the timeout error repeats it.
          attempts += 1;
          if (this.lastError !== lastDetail || attempts % 4 === 0) {
            this.logger.debug(`Quick tunnel not ready: ${this.lastError}`);
            lastDetail = this.lastError;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, HEALTH_CHECK_INTERVAL_MS));
        }
      };

      timeout = setTimeout(() => {
        if (!settled) {
          const detail = candidateUrl
            ? `; last readiness check: ${this.lastError ?? "no response"}`
            : "; cloudflared produced no quick-tunnel URL";
          this.logger.error(
            `Quick tunnel did not become ready within ${this.startTimeoutMs}ms${detail}`
          );
          fail(new Error(`Tunnel start timed out${detail}`));
        }
      }, this.startTimeoutMs);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          const url = parseQuickTunnelUrl(line);
          if (url && !candidateUrl) {
            candidateUrl = url;
            this.logger.info(`Quick tunnel URL observed: ${url}`);
          }
          if (/\b(?:ERR|error|failed|fatal)\b/i.test(line)) {
            this.lastError = line.slice(0, 400);
            this.logger.debug(`cloudflared: ${line.slice(0, 400)}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);
      void waitForReady().catch((error: unknown) => {
        this.logger.error(`Quick tunnel readiness loop failed: ${describeFetchError(error)}`);
      });

      child.on("error", (error) => {
        closeReaders();
        if (this.child === child) {
          this.child = null;
          this.url = null;
        }
        if (!settled) fail(error);
      });
      child.on("exit", (code) => {
        closeReaders();
        if (this.child === child) {
          this.child = null;
          this.url = null;
          this.lastError = `cloudflared exited (code ${code})`;
        }
        this.logger.warn(`cloudflared exited with code ${code}`);
        if (!settled) {
          fail(
            new Error(
              `cloudflared exited (code ${code}) before establishing a tunnel${this.lastError ? `: ${this.lastError}` : ""}`
            )
          );
        }
      });
    });
  }

  async stop(): Promise<void> {
    this.cancelStart?.();
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // The process may have exited between the state check and kill().
      }
      this.child = null;
    }
    this.url = null;
    this.lastError = null;
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null && this.url !== null,
      url: this.url,
      provider: this.name,
      detail: this.lastError ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !this.child) problems.push("tunnel process not running");
    if (this.child && !this.url) problems.push("tunnel running but no public URL yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null,
      url: this.url,
      problems,
    };
  }
}
