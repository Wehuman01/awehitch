/**
 * Follow-mode data-plane verification (verify, don't manage).
 *
 * In mode "follow" the workspace view ChatGPT uses is served by an external
 * MCP data plane — typically coding-tools-mcp behind a tunnel. awehitch never
 * starts, stops or configures it: `up`/`doctor` VERIFY that the declared
 * endpoint matches the workspace's `follow.chatWrite` intent (chatWrite:false
 * → the endpoint must report a read-only permission mode and no mutating
 * tools) and, when it does not, print the command that would fix it.
 */

/** Tools that can change the tree or the machine; must be absent when
 * chatWrite is false. Mirrors coding-tools-mcp's MUTATING_TOOLS. */
export const CTM_MUTATING_TOOLS = ["apply_patch", "apply_changes", "exec_command", "write_stdin", "kill_command"] as const;

export interface CtmVerifyResult {
  ok: boolean;
  endpoint: string;
  /** Permission mode the endpoint reports, when reachable. */
  permissionMode: string | null;
  /** Advertised tool names, when reachable. */
  tools: string[] | null;
  /** Human-readable problems; empty when the endpoint matches the intent. */
  problems: string[];
  /** Start command to copy when the endpoint needs fixing. */
  suggestion: string | null;
}

/** One JSON-RPC round trip against a Streamable HTTP MCP endpoint. */
async function rpc(url: string, body: unknown, sessionId?: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const sessionHeader = response.headers.get("mcp-session-id") ?? undefined;
  const contentType = response.headers.get("content-type") ?? "";
  let payload: unknown;
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    const line = text.split("\n").find((entry) => entry.startsWith("data:"));
    payload = line ? JSON.parse(line.slice(5).trim()) : null;
  } else {
    payload = await response.json();
  }
  return { payload, sessionHeader };
}

function resultOf(message: unknown): { result?: Record<string, unknown>; error?: { message?: string } } {
  if (message && typeof message === "object") {
    return message as { result?: Record<string, unknown>; error?: { message?: string } };
  }
  return {};
}

/**
 * Verify the data-plane endpoint against the workspace's chatWrite intent.
 * The check is read-only (one `server_info` tool call) and never side-effecting.
 */
export async function verifyCtmEndpoint(
  endpoint: string,
  opts: { expectReadonly: boolean; workspaceRoot?: string; ctmArgs?: string[] }
): Promise<CtmVerifyResult> {
  const problems: string[] = [];
  let permissionMode: string | null = null;
  let tools: string[] | null = null;
  try {
    const init = await rpc(endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "awehitch-doctor", version: "1.0.0" },
      },
    });
    const session = (init as { sessionHeader?: string }).sessionHeader;
    await rpc(
      endpoint,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      session
    ).catch(() => undefined);
    const call = await rpc(
      endpoint,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "server_info", arguments: {} },
      },
      session
    );
    const { result, error } = resultOf((call as { payload: unknown }).payload);
    if (error) {
      problems.push(`server_info call failed: ${error.message ?? "unknown error"}`);
    } else {
      const structured = (result?.structuredContent ?? {}) as Record<string, unknown>;
      permissionMode = typeof structured.permission_mode === "string" ? structured.permission_mode : null;
      tools = Array.isArray(structured.tools)
        ? structured.tools.filter((entry): entry is string => typeof entry === "string")
        : null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = message === "HTTP 401" || message === "HTTP 403"
      ? "the endpoint requires authorization (bearer/OAuth); verify it from the ChatGPT connector instead"
      : `endpoint unreachable (${message})`;
    problems.push(hint);
    return { ok: false, endpoint, permissionMode, tools, problems, suggestion: suggestedCtmCommand(opts) };
  }

  if (permissionMode === null) {
    problems.push("the endpoint did not report a permission mode; is it a coding-tools-mcp server?");
  } else if (opts.expectReadonly && permissionMode !== "readonly") {
    problems.push(
      `the data plane allows workspace writes (permission_mode=${permissionMode}) but this workspace declares chatWrite=false`
    );
  }
  if (opts.expectReadonly && tools) {
    const present = CTM_MUTATING_TOOLS.filter((tool) => tools!.includes(tool));
    if (present.length > 0) {
      problems.push(`mutating tools are advertised despite chatWrite=false: ${present.join(", ")}`);
    }
  }
  return {
    ok: problems.length === 0,
    endpoint,
    permissionMode,
    tools,
    problems,
    suggestion: problems.length === 0 ? null : suggestedCtmCommand(opts),
  };
}

/**
 * The data-plane start command doctor/up print when verification fails.
 * `--permission-mode readonly` ships in the mugpeng fork of
 * coding-tools-mcp, not yet upstream — say so instead of handing the user a
 * command that errors on the PyPI build.
 */
export function suggestedCtmCommand(opts: {
  expectReadonly: boolean;
  workspaceRoot?: string;
  ctmArgs?: string[];
}): string {
  const root = opts.workspaceRoot ?? "/path/to/repo";
  const extra = opts.ctmArgs?.length ? ` ${opts.ctmArgs.join(" ")}` : "";
  if (opts.expectReadonly) {
    return (
      `uvx --from git+https://github.com/mugpeng/coding-tools-mcp coding-tools-mcp ` +
      `--permission-mode readonly --workspace ${root}${extra}`
    );
  }
  return `uvx coding-tools-mcp --workspace ${root}${extra}`;
}
