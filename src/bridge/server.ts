import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Workspace, WorkspaceError } from "../workspace/manager.js";
import { addWorkspaceRoot, loadRegisteredWorkspaces } from "../workspace/registry.js";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { namedTunnelBinding, readTunnelState } from "../tunnel/state.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";

/** The one bridge owns one public connection: stable hostname when provisioned, quick tunnel otherwise. */
function tunnelForMachine(logger: Logger): TunnelProvider {
  const binding = namedTunnelBinding(readTunnelState());
  if (binding) {
    return new CloudflaredNamedTunnel({
      tunnelName: binding.tunnelName,
      hostname: binding.hostname,
      protocol: binding.protocol,
      logger,
    });
  }
  return new CloudflaredQuickTunnel(logger);
}

export interface BridgeOptions {
  /** Seed roots for the served workspaces (tests). Default: the machine registry. */
  workspaceRoots?: string[];
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
  /** Handler behind the dispatch_agent tool; absent disables the tool. */
  dispatchAgent?: import("../mcp/server.js").McpContext["dispatchAgent"];
}

export interface Bridge {
  /** Live snapshot of the served workspaces; mutates via POST /admin/workspaces. */
  workspaces: Workspace[];
  port: number;
  host: string;
  adminToken: string;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

/**
 * Listen on the preferred port; on EADDRINUSE fall back to an ephemeral port.
 */
function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const logger = opts.logger ?? nullLogger;
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  // The served set starts from the machine registry (or explicit seeds) and
  // grows at runtime via POST /admin/workspaces — a second `up` elsewhere
  // registers its directory without touching this process.
  const workspaces: Workspace[] = opts.workspaceRoots
    ? opts.workspaceRoots.map((root) => new Workspace(root)).sort((a, b) => a.name.localeCompare(b.name))
    : loadRegisteredWorkspaces();
  if (workspaces.length === 0) {
    logger.warn("No workspaces registered yet; ChatGPT tools will say so until `awehitch up -w <dir>` runs.");
  }

  // Machine-scoped identity (v0.2.6): one store, one pairing flow, one tunnel.
  const authStore = new AuthStore("machine", { file: opts.authStoreFile });
  const pairing = new PairingManager("machine", { ttlMs: opts.pairingTtlMs });
  const tunnel = opts.tunnelProvider ?? tunnelForMachine(logger);
  const adminToken = `awehitch_admin_${randomBytes(24).toString("base64url")}`;
  const pairingLabel =
    workspaces.length === 1 ? workspaces[0].name : "this machine's registered workspaces";

  let publicBaseUrl: string | null = null;

  const app = express();
  // No `trust proxy`: the bridge binds loopback and proxy headers are
  // client-controlled; rate-limit identity is derived in pairingIpKey()
  // (last X-Forwarded-For hop) instead of req.ip.
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  // ---- Health (public but minimal) ---------------------------------------

  app.get("/health", (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      scope: "machine",
      workspaceCount: workspaces.length,
      status: "ok",
    });
  });

  // ---- OAuth + discovery ---------------------------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: pairingLabel,
      getBaseUrl,
      logger,
    })
  );

  // ---- MCP endpoint (bearer-protected) --------------------------------------

  // A fresh server per request picks up the live workspace list and the
  // selector hints that depend on it.
  const mcpHandler = createMcpHttpHandler(
    () => createMcpServer({ workspaces, logger, dispatchAgent: opts.dispatchAgent }),
    logger
  );
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({ store: authStore, getBaseUrl, logger }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );

  // ---- Admin API (loopback + admin token only; used by the CLI/Skill) --------

  // Admin routes may carry JSON bodies (workspace registration).
  app.use("/admin", express.json({ limit: "1mb" }));

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    // Defense in depth: reject anything that arrived through a proxy/tunnel.
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end(); // do not advertise the admin surface
      return;
    }
    next();
  };

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      scope: "machine",
      workspaces: workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceRoot: workspace.root,
      })),
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
    });
  });

  // Register one more directory with the running bridge (used by a second
  // `up` while this instance serves). Persists to the machine registry and
  // makes sure the live tool set sees the root — even when the caller
  // persisted it already and `added` comes back false.
  app.post("/admin/workspaces", adminGuard, (req, res) => {
    const root = typeof req.body?.root === "string" ? req.body.root.trim() : "";
    if (!root) {
      res.status(400).json({ error: "invalid_root", message: "Request body must be {\"root\": \"<directory>\"}" });
      return;
    }
    try {
      const workspace = new Workspace(root);
      const known = workspaces.some((candidate) => candidate.root.toLowerCase() === workspace.root.toLowerCase());
      addWorkspaceRoot(root); // idempotent registry write
      if (!known) {
        workspaces.push(workspace);
        workspaces.sort((a, b) => a.name.localeCompare(b.name));
        logger.info(`Registered workspace ${workspace.name} (${workspace.id})`);
      }
      persistRuntime();
      res.json({ added: !known, workspaceCount: workspaces.length });
    } catch (error) {
      const status = error instanceof WorkspaceError ? 400 : 500;
      const message = error instanceof Error ? error.message : String(error);
      res.status(status).json({ error: "invalid_root", message });
    }
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    tunnel
      .start(port)
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      // Spell out the trigger: a foreground watcher seeing "Bridge stopped"
      // alone cannot tell an intentional stop from a crash.
      void shutdown("admin shutdown requested — `awehitch stop/off/restart`")
        .then(() => process.exit(0));
    }, 100);
  });

  // Last-resort error handler. Express's default handler forwards stack traces
  // and absolute paths to the client; keep the details in the server log and
  // answer with an opaque JSON body.
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status =
      (error as { status?: number } | null)?.status ??
      (error as { statusCode?: number } | null)?.statusCode ??
      500;
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Request failed (${status}): ${message}`);
    res.status(status).json({
      error: status >= 500 ? "internal_error" : "bad_request",
      message: status >= 500 ? "Unexpected server error" : "Malformed request",
    });
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  const startedAt = new Date().toISOString();
  const names = workspaces.map((workspace) => workspace.name).join(", ") || "(none registered)";
  logger.info(`Bridge listening on ${host}:${port} serving ${workspaces.length} workspace(s): ${names}`);

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
      workspaces: workspaces.map((workspace) => workspace.root),
    };
    writeRuntimeState(state);
  };
  persistRuntime();

  let closed = false;
  const shutdown = async (reason?: string): Promise<void> => {
    if (closed) return;
    closed = true;
    await tunnel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (opts.persistRuntime !== false) clearRuntimeState();
    logger.info(reason ? `Bridge stopped (${reason})` : "Bridge stopped");
  };

  return {
    workspaces,
    port,
    host,
    adminToken,
    authStore,
    pairing,
    tunnel,
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
