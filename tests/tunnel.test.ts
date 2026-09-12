import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { findBinary } from "../src/tunnel/detect.js";
import {
  CloudflaredQuickTunnel,
  parseQuickTunnelUrl,
  type CloudflaredQuickTunnelOptions,
} from "../src/tunnel/cloudflared.js";
import { normalizeNamedTunnelHostname } from "../src/tunnel/cloudflared-named.js";
import { hostnameSlug, parseZoneInput, suggestedNamedHostname } from "../src/tunnel/hostname.js";
import {
  chooseQuickTunnel,
  isBenignRouteError,
  parseCreatedTunnel,
  parseTunnelList,
  provisionNamedTunnel,
  type CloudflaredAccount,
} from "../src/tunnel/named-provision.js";
import { isNamedTunnelReady, needsTunnelChoice, readTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const stateDirs: string[] = [];
const previousStateDir = process.env.AWEHITCH_STATE_DIR;
const previousCloudflaredPath = process.env.AWEHITCH_CLOUDFLARED_PATH;
const QUICK_URL = "https://random-words-here-1234.trycloudflare.com";
const METRICS_PORT = 46001;
type FetchImpl = NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>;

class FakeCloudflaredProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function setupTunnel(fetchImpl: FetchImpl, startTimeoutMs = 1_000) {
  const child = new FakeCloudflaredProcess();
  const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
  const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared", {
    spawnImpl,
    fetchImpl,
    startTimeoutMs,
    metricsPort: METRICS_PORT,
  });
  return { child, spawnImpl, tunnel };
}

function announceUrl(child: FakeCloudflaredProcess): void {
  child.stderr.write(`INF ${QUICK_URL}\n`);
}

function healthResponse(): Response {
  return new Response(JSON.stringify({ service: "awehitch-bridge", status: "ok" }), { status: 200 });
}

function metricsResponse(readyConnections = 1): Response {
  return new Response(JSON.stringify({ status: 200, readyConnections }), { status: 200 });
}

/** Fetch stub that routes 127.0.0.1 calls to cloudflared metrics and the rest to the public URL. */
function routingFetch(
  metrics: () => Response | Promise<Response> = () => metricsResponse(),
  publicProbe: () => Response | Promise<Response> = () => healthResponse()
): FetchImpl & { metricsCalls: () => number; publicCalls: () => number } {
  let metricsCount = 0;
  let publicCount = 0;
  const impl = vi.fn(async (input: string | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("http://127.0.0.1")) {
      metricsCount += 1;
      return metrics();
    }
    publicCount += 1;
    return publicProbe();
  });
  return Object.assign(impl as unknown as FetchImpl, {
    metricsCalls: () => metricsCount,
    publicCalls: () => publicCount,
  });
}

afterEach(() => {
  while (stateDirs.length) cleanup(stateDirs.pop()!);
  if (previousStateDir === undefined) delete process.env.AWEHITCH_STATE_DIR;
  else process.env.AWEHITCH_STATE_DIR = previousStateDir;
  if (previousCloudflaredPath === undefined) delete process.env.AWEHITCH_CLOUDFLARED_PATH;
  else process.env.AWEHITCH_CLOUDFLARED_PATH = previousCloudflaredPath;
});

describe("findBinary", () => {
  it("uses AWEHITCH_CLOUDFLARED_PATH for an accessible cloudflared executable", () => {
    const dir = makeTmpDir("cloudflared-path");
    stateDirs.push(dir);
    const filename = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const configured = write(dir, filename, "placeholder");
    if (process.platform !== "win32") fs.chmodSync(configured, 0o755);
    process.env.AWEHITCH_CLOUDFLARED_PATH = configured;
    expect(findBinary("cloudflared")).toBe(configured);
  });
});

describe("parseQuickTunnelUrl", () => {
  it("extracts the URL from cloudflared banner output", () => {
    const line =
      "2026-08-28T10:00:00Z INF |  https://random-words-here-1234.trycloudflare.com                              |";
    expect(parseQuickTunnelUrl(line)).toBe(QUICK_URL);
  });

  it("ignores unrelated lines and non-Quick-Tunnel hosts", () => {
    expect(parseQuickTunnelUrl("INF Starting tunnel connection")).toBeNull();
    expect(parseQuickTunnelUrl("visit https://www.cloudflare.com for docs")).toBeNull();
    expect(parseQuickTunnelUrl("https://evil.example.com/trycloudflare.com")).toBeNull();
  });

  it("rejects Cloudflare's API host", () => {
    expect(parseQuickTunnelUrl("INF https://api.trycloudflare.com")).toBeNull();
  });
});

describe("CloudflaredQuickTunnel", () => {
  it("resolves after cloudflared's metrics endpoint reports edge connections", async () => {
    const fetchImpl = routingFetch();
    const { child, spawnImpl, tunnel } = setupTunnel(fetchImpl);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(spawnImpl).toHaveBeenCalledWith(
      "cloudflared",
      [
        "tunnel",
        "--url",
        "http://127.0.0.1:3333",
        "--no-autoupdate",
        "--metrics",
        `127.0.0.1:${METRICS_PORT}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:${METRICS_PORT}/ready`, {
      signal: expect.any(AbortSignal),
    });
    expect(fetchImpl).toHaveBeenCalledWith(`${QUICK_URL}/health`, {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(tunnel.status()).toMatchObject({ running: true, url: QUICK_URL });
    await tunnel.stop();
  });

  it("resolves even when the public hostname is not resolvable yet", async () => {
    // Fresh quick-tunnel hostnames stay negative-cached on some resolvers for
    // minutes; readiness must not depend on resolving them locally.
    const fetchImpl = routingFetch(
      () => metricsResponse(2),
      () => {
        throw new TypeError("fetch failed <- getaddrinfo ENOTFOUND nope.trycloudflare.com");
      }
    );
    const { child, tunnel } = setupTunnel(fetchImpl);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(fetchImpl.metricsCalls()).toBeGreaterThanOrEqual(1);
    await tunnel.stop();
  });

  it("keeps consuming cloudflared errors after the tunnel is ready", async () => {
    const { child, tunnel } = setupTunnel(routingFetch());
    const starting = tunnel.start(3333);
    announceUrl(child);
    await expect(starting).resolves.toBe(QUICK_URL);

    child.stderr.write("ERR runtime connection error\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(tunnel.status().detail).toBe("ERR runtime connection error");
    await tunnel.stop();
  });

  it("times out while metrics report no edge connections", async () => {
    const fetchImpl = routingFetch(
      () => new Response(JSON.stringify({ status: 200, readyConnections: 0 }), { status: 200 })
    );
    const { child, tunnel } = setupTunnel(fetchImpl, 20);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).rejects.toThrow(/timed out.*no edge connections/i);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("does not spawn twice or resolve a stopped pending start", async () => {
    const { child, spawnImpl, tunnel } = setupTunnel(() => new Promise<Response>(() => {}));
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    const concurrent = tunnel.start(3333);
    await tunnel.stop();
    await expect(starting).rejects.toThrow(/stopped/i);
    await expect(concurrent).rejects.toThrow(/stopped/i);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not resolve if cloudflared exits while the readiness probe is in flight", async () => {
    let resolveFetch!: (response: Response) => void;
    const { child, tunnel } = setupTunnel(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve))
    );
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    child.exitCode = 1;
    child.emit("exit", 1, null);
    resolveFetch(metricsResponse());
    await expect(starting).rejects.toThrow(/exited/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("rejects when spawning reports an asynchronous error", async () => {
    const { child, tunnel } = setupTunnel(routingFetch());
    const starting = tunnel.start(3333);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("error", new Error("spawn cloudflared ENOENT"));

    await expect(starting).rejects.toThrow(/ENOENT/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("retries a non-ready metrics response before resolving", async () => {
    const cancelBody = vi.fn(async () => undefined);
    const fetchImpl = routingFetch(
      (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return calls === 1
            ? ({ ok: false, status: 503, body: { cancel: cancelBody } } as unknown as Response)
            : metricsResponse();
        };
      })()
    );
    const { child, tunnel } = setupTunnel(fetchImpl);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(fetchImpl.metricsCalls()).toBe(2);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    await tunnel.stop();
  });

  it("waits for the quick-tunnel URL even when edge connections come up first", async () => {
    const fetchImpl = routingFetch();
    const { child, tunnel } = setupTunnel(fetchImpl, 2_000);
    const starting = tunnel.start(3333);
    await new Promise((resolve) => setTimeout(resolve, 50));
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    await tunnel.stop();
  });
});

describe("normalizeNamedTunnelHostname", () => {
  it("normalizes a valid hostname", () => {
    expect(normalizeNamedTunnelHostname("Dev.GetRemi.xyz.")).toBe("dev.getremi.xyz");
  });

  it("rejects URLs and invalid hostnames", () => {
    expect(() => normalizeNamedTunnelHostname("https://dev.getremi.xyz")).toThrow(/invalid/i);
    expect(() => normalizeNamedTunnelHostname("localhost")).toThrow(/invalid/i);
  });
});

describe("named hostname helpers", () => {
  it("builds a stable c2c-<project>.<zone> hostname", () => {
    expect(suggestedNamedHostname("Example.COM", "My App", "abcdef123456")).toBe("c2c-my-app.example.com");
  });

  it("falls back to the workspace id when the name is not ASCII", () => {
    expect(hostnameSlug("回声", "abcdef123456")).toBe("c2c-ws-abcdef12");
  });

  it("parses a typed domain", () => {
    expect(parseZoneInput("https://Example.com/")).toBe("example.com");
    expect(parseZoneInput("not a domain")).toBeNull();
  });
});

describe("cloudflared output parsers", () => {
  it("reads a tunnel list table", () => {
    const output = `
ID                                   NAME          CREATED
11111111-1111-1111-1111-111111111111 c2c-abc123    2026-08-30
`;
    expect(parseTunnelList(output)).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", name: "c2c-abc123" },
    ]);
  });

  it("reads created-tunnel output", () => {
    expect(
      parseCreatedTunnel(
        "Created tunnel c2c-abc with id 22222222-2222-2222-2222-222222222222",
        "c2c-abc"
      )
    ).toEqual({ id: "22222222-2222-2222-2222-222222222222", name: "c2c-abc" });
  });

  it("treats an existing DNS route as success", () => {
    expect(isBenignRouteError("Failed to add route: record already exists")).toBe(true);
  });
});

describe("tunnel preference state", () => {
  it("asks once, then remembers a quick choice", () => {
    stateDirs.push(isolateStateDir());
    const unset = readTunnelState("ws1");
    expect(needsTunnelChoice(unset)).toBe(true);
    const saved = chooseQuickTunnel("ws1");
    expect(saved.preference).toBe("quick");
    expect(needsTunnelChoice(readTunnelState("ws1"))).toBe(false);
    expect(isNamedTunnelReady(saved)).toBe(false);
  });

  it("provisions a named hostname through the account adapter and stores it outside the project", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "33333333-3333-3333-3333-333333333333", name }),
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "abcdef123456",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(false);
      expect(result.state.preference).toBe("named");
      expect(result.state.hostname).toBe("c2c-demo.example.com");
      expect(result.state.tunnelName).toBe("c2c-abcdef123456");
      expect(isNamedTunnelReady(readTunnelState("abcdef123456"))).toBe(true);
    });
  });

  it("falls back to a temporary address when named provisioning fails", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async () => {
        throw new Error("no zone");
      },
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "ws2",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(true);
      expect(result.state.preference).toBe("quick");
      expect(result.userMessage).toMatch(/临时地址/);
    });
  });
});
