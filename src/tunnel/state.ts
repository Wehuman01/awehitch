import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type TunnelPreference = "unset" | "quick" | "named";

export interface TunnelState {
  workspaceId: string;
  preference: TunnelPreference;
  askedAt?: string;
  provider?: "cloudflare-quick" | "cloudflare-named";
  tunnelName?: string;
  tunnelId?: string;
  hostname?: string;
  zone?: string;
  configuredAt?: string;
  fallbackReason?: string;
}

export function tunnelStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "tunnels", `${workspaceId}.json`);
}

export function readTunnelState(workspaceId: string): TunnelState {
  return (
    readJsonIfExists<TunnelState>(tunnelStateFile(workspaceId)) ?? {
      workspaceId,
      preference: "unset",
    }
  );
}

export function writeTunnelState(state: TunnelState): TunnelState {
  writeSecureJson(tunnelStateFile(state.workspaceId), state);
  return state;
}

export function needsTunnelChoice(state: TunnelState): boolean {
  return state.preference === "unset" || !state.askedAt;
}

export function isNamedTunnelReady(state: TunnelState): boolean {
  return (
    state.preference === "named" &&
    Boolean(state.tunnelName?.trim()) &&
    Boolean(state.hostname?.trim())
  );
}

export function namedTunnelBinding(state: TunnelState): { tunnelName: string; hostname: string } | null {
  if (!isNamedTunnelReady(state) || !state.tunnelName || !state.hostname) return null;
  return { tunnelName: state.tunnelName, hostname: state.hostname };
}

export const TUNNEL_CHOICE_PROMPT = `Before connecting to ChatGPT, one optional choice:
Do you have a Cloudflare account and a domain already added to Cloudflare?
- Yes: use a stable hostname. Configure the connector once; after a reboot you usually do not touch it again. One Cloudflare login, plus a subdomain under your domain.
- No: use a temporary URL. No signup, same features. After a reboot the URL often changes and the old ChatGPT connector goes stale. I will delete this project's connector and re-add it with the new URL; you may need to log in to ChatGPT again occasionally. It works, just slower to repair.
No account is fine. Which do you prefer? If you have a domain, just tell me (for example example.com).`;

export const NAMED_LOGIN_PROMPT =
  "A browser window will open. Log in to Cloudflare and select your domain, then say \"done\".";

export const NAMED_FALLBACK_MESSAGE =
  "Using a temporary address for now. Same features; connection repairs may be slower later. Tell me if you want a stable hostname.";

export const NAMED_REPAIR_MESSAGE =
  "The stable hostname is temporarily unreachable. Log in to Cloudflare in the upcoming window, select your domain, then say \"done\".";
