/**
 * Dispatch authority for a user-owned ChatGPT conversation (the one the
 * agent binds via `awehitch_open_chat` with the user's URL).
 *
 * The invariant this module enforces: the agent acts on a ChatGPT
 * conversation only when the dispatch was authorized by the USER — proven by
 * the dispatch marker appearing in the user's OWN latest message on the page.
 * ChatGPT text alone, however [C2C]-shaped, never authorizes execution: a
 * `[C2C] DIRECTIVE:` reply is only actionable while the user's own message
 * carries the marker. Page content stays untrusted for invocation purposes;
 * the marker is the one user-authored exception.
 */

/** Default marker the user types in the ChatGPT conversation. */
export const DEFAULT_DISPATCH_MARKER = "@agent";

export function resolveDispatchMarker(marker?: string): string {
  const trimmed = marker?.trim();
  return trimmed ? trimmed : DEFAULT_DISPATCH_MARKER;
}

/**
 * True when a user-turn on the page was injected by an agent (composer
 * sends through the control plane) rather than typed by the user: [C2C]
 * protocol messages are machine-authored, so they can never carry the
 * USER's own authorization — even when they echo a dispatch marker (task
 * text inside an EXECUTED report, say). Without this guard a report that
 * quotes the marker would re-authorize a dispatch loop.
 */
export function isAgentInjected(text: string | null | undefined): boolean {
  return typeof text === "string" && text.trimStart().startsWith("[C2C]");
}

/**
 * True when the user's own message authorizes a dispatch. The marker must
 * appear as a standalone token: not glued to Latin letters, digits, "@",
 * "_" or "-" on either side — so "not@agent", "@agent-x" or
 * "email@agent.com" do not authorize anything, while natural CJK typing
 * around the marker ("来吧@agent 修一下") still counts.
 */
export function isDispatchAuthorized(userText: string | null | undefined, marker: string): boolean {
  if (!userText) return false;
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9@_-])${escaped}(?![A-Za-z0-9@_-])`).test(userText);
}

/**
 * Parse a directive from an assistant reply in the user's conversation: a
 * `[C2C]` control message whose first header is `DIRECTIVE:`. Mirrors the STATE: parsing in
 * browser.ts — anything the page renders without that exact shape is just
 * conversation, not an actionable message.
 */
export function parseDirective(replyText: string | null | undefined): { isDirective: boolean; body: string | null } {
  const text = replyText?.trimStart() ?? "";
  if (!text.startsWith("[C2C]")) return { isDirective: false, body: null };
  const match = text.match(/^DIRECTIVE:[ \t]*(.*)$/m);
  if (!match) return { isDirective: false, body: null };
  const header = text.slice(0, match.index ?? 0);
  // DIRECTIVE is a header like STATE, not a state value: reject a reply that
  // first declared some other STATE (e.g. an EXECUTED ack echoed back).
  if (/^STATE:\s*\w+/m.test(header)) return { isDirective: false, body: null };
  // The directive body is the DIRECTIVE line plus everything after it — the
  // one-line summary and the actionable details that follow.
  const rest = text.slice((match.index ?? 0) + match[0].length).trim();
  const summary = match[1].trim();
  const body = rest ? `${summary}\n${rest}` : summary;
  return { isDirective: true, body: body || null };
}
