import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";

export const CHATGPT_DEVELOPER_MODE_URL = "https://chatgpt.com/#settings/Security";
/** The settings modal's connector list — where the machine connector lives. */
export const CHATGPT_CONNECTORS_SETTINGS_URL = "https://chatgpt.com/#settings/Connectors";
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";
export const CHATGPT_CREATE_CONNECTOR_URL =
  "https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins";

export const DEFAULT_CONNECTOR_NAME = "awehitch";

export interface LastEndpoint {
  port: number;
  publicUrl: string | null;
  mcpUrl: string | null;
  connectorName?: string;
  savedAt: string;
}

export function endpointFile(): string {
  return path.join(getStateDir(), "endpoints", "machine.json");
}

export function readLastEndpoint(): LastEndpoint | null {
  return readJsonIfExists<LastEndpoint>(endpointFile());
}

export function writeLastEndpoint(endpoint: Omit<LastEndpoint, "savedAt">): LastEndpoint {
  const saved: LastEndpoint = { ...endpoint, savedAt: new Date().toISOString() };
  writeSecureJson(endpointFile(), saved);
  return saved;
}

/**
 * Pre-0.2.6 endpoint records (one per workspace). Read once during connector
 * naming so a legacy connector pointing at the SAME mcpUrl keeps its title:
 * the connector in ChatGPT then survives the upgrade untouched.
 */
export function readLegacyEndpoints(): { workspaceId: string; endpoint: LastEndpoint }[] {
  const dir = path.join(getStateDir(), "endpoints");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: { workspaceId: string; endpoint: LastEndpoint }[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || name === "machine.json") continue;
    const raw = readJsonIfExists<LastEndpoint & { workspaceId?: string }>(path.join(dir, name));
    if (raw && typeof raw.workspaceId === "string") {
      const { workspaceId, ...endpoint } = raw;
      out.push({ workspaceId, endpoint });
    }
  }
  return out;
}

export function normalizePublicUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function mcpUrlFromPublic(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  const base = normalizePublicUrl(publicUrl).replace(/\/mcp$/, "");
  return `${base}/mcp`;
}

/** What the Skill should do to the machine's ChatGPT connector.
 *  `update` means the public address changed: Delete the old connector
 *  in ChatGPT, then create it again. Never click Reconnect (the old
 *  URL is dead and hangs on "This site cannot be reached"). */
export function connectorAction(
  previousMcpUrl: string | null | undefined,
  nextMcpUrl: string | null | undefined
): "none" | "create" | "update" {
  if (!nextMcpUrl) return "none";
  if (!previousMcpUrl) return "create";
  return normalizePublicUrl(previousMcpUrl) === normalizePublicUrl(nextMcpUrl) ? "none" : "update";
}

export function sanitizeConnectorLabel(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._\- ]+/gu, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 40) || "awehitch";
}

/**
 * The machine keeps one connector title forever. When no machine record
 * exists yet, a legacy per-workspace connector pointing at the same mcpUrl is
 * adopted by title so the upgrade does not orphan it in ChatGPT.
 */
export function connectorNameFor(opts: {
  previousName?: string | null;
  legacyMatch?: LastEndpoint | null;
}): string {
  if (opts.previousName?.trim()) return opts.previousName.trim();
  if (opts.legacyMatch?.connectorName?.trim()) return opts.legacyMatch.connectorName.trim();
  return DEFAULT_CONNECTOR_NAME;
}

/** Find the legacy endpoint whose connector already points at this mcpUrl. */
export function legacyEndpointForMcpUrl(mcpUrl: string | null | undefined): LastEndpoint | null {
  if (!mcpUrl) return null;
  return (
    readLegacyEndpoints().find(
      (entry) => entry.endpoint.mcpUrl && normalizePublicUrl(entry.endpoint.mcpUrl) === normalizePublicUrl(mcpUrl)
    )?.endpoint ?? null
  );
}

export function reclaimUserMessage(connectorName: string): string {
  return `This machine's secure connection address expired. I will delete "${connectorName}" and re-add it with the new address; other connectors are untouched. Please wait.`;
}
