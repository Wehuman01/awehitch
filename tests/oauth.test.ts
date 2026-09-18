import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import type { Request } from "express";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { pairingIpKey } from "../src/auth/oauth.js";
import { makeTmpDir, cleanup, write, isolateStateDir, pkceVerifierAndChallenge } from "./helpers.js";

let root: string;
let bridge: Bridge;
let base: string;

const REDIRECT_URI = "http://127.0.0.1:19999/callback";

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("oauth-ws");
  write(root, "hello.txt", "hello oauth\n");
  bridge = await startBridge({
    workspaceRoots: [root],
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
  });
  base = bridge.localBaseUrl();
});

afterAll(async () => {
  await bridge.close();
  cleanup(root);
});

async function registerClient(): Promise<string> {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT-Test", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

async function authorizeWithPairing(
  clientId: string,
  challenge: string,
  pairingCode: string,
  state = "st-123"
): Promise<{ code: string | null; location: string | null; page?: string; status?: number }> {
  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "workspace.read workspace.search git.read execution.read offline_access");

  const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const html = await pageResponse.text();
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  if (!requestId) return { code: null, location: null, page: html, status: pageResponse.status };

  const postResponse = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode }),
    redirect: "manual",
  });
  if (postResponse.status !== 302) {
    return { code: null, location: null, page: await postResponse.text(), status: postResponse.status };
  }
  const location = postResponse.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  return { code, location, status: postResponse.status };
}

async function exchangeToken(
  clientId: string,
  code: string,
  verifier: string
): Promise<{ status: number; body: Record<string, string> }> {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

describe("discovery metadata", () => {
  it("serves protected resource metadata", async () => {
    const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toContain("/mcp");
    expect(body.authorization_servers.length).toBe(1);
  });

  it("serves authorization server metadata with PKCE S256", async () => {
    const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.registration_endpoint).toContain("/oauth/register");
  });
});

describe("authorization + token flow", () => {
  it("completes the full pairing + PKCE flow and calls MCP", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code, location } = await authorizeWithPairing(clientId, challenge, pairing.code);
    expect(code).toBeTruthy();
    expect(location).toContain("state=st-123");

    const token = await exchangeToken(clientId, code!, verifier);
    expect(token.status).toBe(200);
    expect(token.body.access_token).toMatch(/^c2c_at_/);
    expect(token.body.refresh_token).toMatch(/^c2c_rt_/);
    expect(token.body.token_type).toBe("Bearer");

    // authorized MCP request
    const mcpResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.body.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(mcpResponse.status).toBe(200);
  });

  it("rejects a wrong pairing code", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    bridge.pairing.create();
    const result = await authorizeWithPairing(clientId, challenge, "AAAA-AAAA");
    expect(result.code).toBeNull();
    expect(result.status).toBe(401);
    expect(result.page).toContain("Incorrect pairing code");
  });

  it("escapes the workspace name in the pairing page", async () => {
    const xssWorkspaceRoot = makeTmpDir("oauth-html");
    write(xssWorkspaceRoot, ".c2c.json", JSON.stringify({ name: "<script>alert('xss')</script>" }));
    const xssBridge = await startBridge({
      workspaceRoots: [xssWorkspaceRoot],
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth-html"), "store.json"),
    });

    try {
      const xssBase = xssBridge.localBaseUrl();
      const registration = await fetch(`${xssBase}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "HTML-Test", redirect_uris: [REDIRECT_URI] }),
      });
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as { client_id: string };
      const { challenge } = pkceVerifierAndChallenge();

      const authorizeUrl = new URL(`${xssBase}/oauth/authorize`);
      authorizeUrl.searchParams.set("client_id", client.client_id);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl, { redirect: "manual" });
      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).not.toContain("<script>alert('xss')</script>");
      expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    } finally {
      await xssBridge.close();
      cleanup(xssWorkspaceRoot);
    }
  });

  it("sets browser security headers on the pairing page", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("rejects PKCE verifier mismatch", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const token = await exchangeToken(clientId, code!, "wrong-verifier-wrong-verifier-wrong");
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("invalid_grant");
  });

  it("authorization codes are one-time", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const first = await exchangeToken(clientId, code!, verifier);
    expect(first.status).toBe(200);
    const second = await exchangeToken(clientId, code!, verifier);
    expect(second.status).toBe(400);
  });

  it("requires PKCE at the authorization endpoint", async () => {
    const clientId = await registerClient();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=invalid_request");
  });

  it("rejects registration with non-https redirect uris", async () => {
    const response = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
    });
    expect(response.status).toBe(400);
  });
});

describe("token enforcement on /mcp", () => {
  const mcpCall = (token?: string): Promise<Response> =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("401 without a token, with resource metadata pointer", async () => {
    const response = await mcpCall();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("401 with an invalid token", async () => {
    const response = await mcpCall("c2c_at_totally-invalid");
    expect(response.status).toBe(401);
  });

  it("401 with an expired token", async () => {
    const expired = bridge.authStore.issueTokens({
      clientId: "test",
      scopes: ["workspace.read"],
      accessTtlMs: -1000,
    });
    const response = await mcpCall(expired.accessToken);
    expect(response.status).toBe(401);
  });

  it("accepts any valid token for the machine-scoped store", async () => {
    // v0.2.6: one store per machine — a token is not bound to a workspace,
    // so there is no cross-workspace 403 any more.
    const other = bridge.authStore.issueTokens({
      clientId: "test",
      scopes: ["workspace.read"],
      workspaceId: "deadbeef0000",
    });
    const response = await mcpCall(other.accessToken);
    expect(response.status).toBe(200);
  });

  it("401 after revocation", async () => {
    const tokens = bridge.authStore.issueTokens({ clientId: "test", scopes: ["workspace.read"] });
    expect((await mcpCall(tokens.accessToken)).status).toBe(200);
    bridge.authStore.revokeToken(tokens.accessToken);
    expect((await mcpCall(tokens.accessToken)).status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it("rotates refresh tokens and invalidates the old one", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const initial = await exchangeToken(clientId, code!, verifier);

    const refresh = async (refreshToken: string): Promise<{ status: number; body: Record<string, string> }> => {
      const response = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, string> };
    };

    const rotated = await refresh(initial.body.refresh_token);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(initial.body.refresh_token);

    const replayed = await refresh(initial.body.refresh_token);
    expect(replayed.status).toBe(400);
  });
});

describe("pairingIpKey", () => {
  it("uses the last XFF hop so forged entries cannot rotate the rate-limit key", () => {
    const req = {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as Request;
    expect(pairingIpKey(req)).toBe("5.6.7.8");
  });

  it("falls back to the socket address when no proxy chain is present", () => {
    const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as Request;
    expect(pairingIpKey(req)).toBe("127.0.0.1");
  });
});

describe("scope handling", () => {
  it("redirects with invalid_scope when only unknown scopes are requested", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "admin:write total:pwn");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=invalid_scope");
  });

  it("shows and grants only the supported subset of a mixed scope request", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "workspace.read bogus_scope");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Read files in the registered workspaces");
    expect(html).not.toContain("bogus_scope");
  });
});

describe("unauthenticated endpoint bounds", () => {
  async function withBridge(
    fn: (bridge: Bridge, base: string) => Promise<void>
  ): Promise<void> {
    const root = makeTmpDir("oauth-bounds");
    write(root, "hello.txt", "bounds\n");
    const boundsBridge = await startBridge({
      workspaceRoots: [root],
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth-bounds"), "store.json"),
    });
    try {
      await fn(boundsBridge, boundsBridge.localBaseUrl());
    } finally {
      await boundsBridge.close();
      cleanup(root);
    }
  }

  it("rejects authorize requests beyond the pending cap (429)", async () => {
    await withBridge(async (boundsBridge, boundsBase) => {
      const clientId = boundsBridge.authStore.registerClient({ redirectUris: [REDIRECT_URI] }).clientId;
      const { challenge } = pkceVerifierAndChallenge();
      const authorizeUrl = new URL(`${boundsBase}/oauth/authorize`);
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      for (let i = 0; i < 50; i += 1) {
        const response = await fetch(authorizeUrl, { redirect: "manual" });
        expect(response.status).toBe(200);
      }
      const overflow = await fetch(authorizeUrl, { redirect: "manual" });
      expect(overflow.status).toBe(429);
    });
  });

  it("rejects client registration beyond the client cap (429)", async () => {
    await withBridge(async (_boundsBridge, boundsBase) => {
      for (let i = 0; i < 200; i += 1) {
        const response = await fetch(`${boundsBase}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_name: `c-${i}`, redirect_uris: [REDIRECT_URI] }),
        });
        expect(response.status).toBe(201);
      }
      const overflow = await fetch(`${boundsBase}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "one-too-many", redirect_uris: [REDIRECT_URI] }),
      });
      expect(overflow.status).toBe(429);
      expect(((await overflow.json()) as { error: string }).error).toBe("too_many_clients");
    });
  });
});
