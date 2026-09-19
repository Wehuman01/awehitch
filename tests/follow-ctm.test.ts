import { afterEach, describe, expect, it, vi } from "vitest";
import { suggestedCtmCommand, verifyCtmEndpoint } from "../src/follow/ctm.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function serverInfoResult(mode: string, tools: string[]): unknown {
  return {
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [{ type: "text", text: "…" }],
      structuredContent: { permission_mode: mode, tools, tool_count: tools.length },
    },
  };
}

const READ_ONLY_CATALOG = ["read_file", "list_dir", "search_text", "git_status", "server_info"];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyCtmEndpoint", () => {
  it("accepts a readonly endpoint when chatWrite=false is declared", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(serverInfoResult("readonly", READ_ONLY_CATALOG)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyCtmEndpoint("https://t.example/mcp", {
      expectReadonly: true,
      workspaceRoot: "/tmp/repo",
    });

    expect(result.ok).toBe(true);
    expect(result.permissionMode).toBe("readonly");
    expect(result.problems).toEqual([]);
    expect(result.suggestion).toBeNull();
    // initialize → initialized notification → tools/call server_info
    const methods = fetchMock.mock.calls.map((call) =>
      JSON.parse((call[1] as RequestInit).body as string).method
    );
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });

  it("flags a writable endpoint when chatWrite=false is declared", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(serverInfoResult("safe", [...READ_ONLY_CATALOG, "apply_patch", "exec_command"]))
      )
    );

    const result = await verifyCtmEndpoint("https://t.example/mcp", { expectReadonly: true });

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("permission_mode=safe");
    expect(result.problems.some((p) => p.includes("apply_patch"))).toBe(true);
    expect(result.suggestion).toContain("--permission-mode readonly");
    expect(result.suggestion).toContain("mugpeng/coding-tools-mcp");
  });

  it("reports unreachable endpoints honestly and suggests a start command", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));

    const result = await verifyCtmEndpoint("https://t.example/mcp", {
      expectReadonly: true,
      ctmArgs: ["--http-port", "9000"],
    });

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("unreachable");
    expect(result.suggestion).toContain("--http-port 9000");
  });

  it("maps 401 to an auth hint instead of a raw error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 401 })));

    const result = await verifyCtmEndpoint("https://t.example/mcp", { expectReadonly: true });

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("authorization");
  });
});

describe("suggestedCtmCommand", () => {
  it("points readonly users at the fork, plain users at PyPI", () => {
    expect(suggestedCtmCommand({ expectReadonly: true, workspaceRoot: "/r" })).toContain(
      "git+https://github.com/mugpeng/coding-tools-mcp"
    );
    expect(suggestedCtmCommand({ expectReadonly: false, workspaceRoot: "/r" })).toContain(
      "uvx coding-tools-mcp"
    );
  });
});
