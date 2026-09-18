import type { NextFunction, Request, Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthStore } from "./store.js";
import type { Logger } from "../logger/index.js";

export interface BearerAuthDeps {
  store: AuthStore;
  getBaseUrl: (req: Request) => string;
  logger: Logger;
}

/**
 * Bearer-token guard for /mcp.
 * - missing/invalid/expired token  -> 401 (+ WWW-Authenticate with resource metadata)
 *
 * v0.2.6: the store is machine-scoped, so a valid token authorizes the whole
 * registry — no per-workspace comparison is needed (or possible) any more.
 */
export function bearerAuth(deps: BearerAuthDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const challenge = (error: string, description: string): string =>
      `Bearer realm="c2c", error="${error}", error_description="${description}", ` +
      `resource_metadata="${deps.getBaseUrl(req)}/.well-known/oauth-protected-resource/mcp"`;

    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      res
        .status(401)
        .set("WWW-Authenticate", challenge("invalid_token", "Missing bearer token"))
        .json({ error: "unauthorized", error_description: "Authentication required" });
      return;
    }
    const token = header.slice(7).trim();
    const verdict = deps.store.verifyAccessToken(token);
    if (!verdict.ok) {
      deps.logger.warn(`Rejected MCP request: token ${verdict.reason}`);
      res
        .status(401)
        .set("WWW-Authenticate", challenge("invalid_token", `Token ${verdict.reason}`))
        .json({ error: "unauthorized", error_description: `Token ${verdict.reason}` });
      return;
    }
    const authInfo: AuthInfo = {
      token,
      clientId: verdict.record.clientId,
      scopes: verdict.record.scopes,
      expiresAt: Math.floor(verdict.record.expiresAt / 1000),
    };
    (req as Request & { auth?: AuthInfo }).auth = authInfo;
    next();
  };
}
