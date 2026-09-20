import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createDispatchToolHandler, type DispatchToolDeps } from "../src/dispatch/tool.js";
import type { SpawnPlan } from "../src/dispatch/spawn.js";
import { activeSession, claimConversation, noteClaimPid, releaseConversation, dispatchTaskId } from "../src/dispatch/spawn.js";
import type { HarnessId } from "../src/adapters/paths.js";
import type { Logger } from "../src/logger/index.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

let stateDir: string;

beforeEach(() => {
  stateDir = isolateStateDir();
});

afterEach(() => {
  cleanup(stateDir);
});

const CHAT_URL = "https://chatgpt.com/c/conv-1";

/** Fake workspace: only the fields the tool handler touches. */
function fakeWorkspace(root: string): { root: string; id: string; name: string } {
  return { root, id: "ws-tool", name: "tool" };
}

/** Latest task passed to `call` — the default fake user message mirrors it. */
let lastTaskText = "";

function deps(opts: {
  installed?: HarnessId[];
  watched?: string[];
  resolve?: string | null;
  /** The conversation's latest user message; default mirrors the task text. */
  userMessage?: string | null;
  /** Simulate an unreadable conversation (verification fails closed). */
  userMessageUnreadable?: boolean;
  launchStyle?: "headless" | "interactive";
  openInteractive?: (launch: { harness: HarnessId; workspaceRoot: string; prompt: string; chatUrl?: string }) => Promise<boolean>;
} = {}): { deps: DispatchToolDeps; plans: SpawnPlan[]; logger: Logger } {
  const plans: SpawnPlan[] = [];
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
  return {
    logger,
    plans,
    deps: {
      installedHarnesses: () => opts.installed ?? (["codex", "opencode"] as HarnessId[]),
      spawn: async (plan: SpawnPlan) => {
        plans.push(plan);
        return { exitCode: 0 };
      },
      watchedConversations: () => opts.watched ?? [],
      readUserMessage: async () =>
        opts.userMessageUnreadable
          ? { readable: false, reason: "NOT_LOGGED_IN" }
          : { readable: true, text: opts.userMessage === undefined ? lastTaskText : opts.userMessage },
      launchStyle: () => opts.launchStyle ?? "headless",
      openInteractive: opts.openInteractive ?? (async () => true),
      logger,
    },
  };
}

const resolveVia = (url: string | null) => async () => url;

const handler = (d: DispatchToolDeps) => createDispatchToolHandler(d);

function call(
  d: DispatchToolDeps,
  task: string,
  extra: { harness?: string; chatUrl?: string; resolve?: string | null } = {}
) {
  const root = makeTmpDir("dispatch-tool-root");
  lastTaskText = task;
  return handler(d)({
    workspace: fakeWorkspace(root) as never,
    task,
    harness: extra.harness,
    chatUrl: extra.chatUrl,
    resolveConversation: resolveVia(extra.resolve === undefined ? CHAT_URL : extra.resolve),
  });
}

describe("dispatch_agent tool", () => {
  it("spawns the @-mentioned harness with the task and the conversation URL", async () => {
    const { deps: d, plans } = deps();
    releaseConversation(CHAT_URL);
    const result = await call(d, "@opencode 在桌面建一个 demo 文件夹");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.harness).toBe("opencode");
    expect(plans).toHaveLength(1);
    expect(plans[0].cmd).toBe("opencode");
    expect(plans[0].args.at(-1)).toContain("TASK:\n在桌面建一个 demo 文件夹");
    expect(plans[0].args.at(-1)).toContain(CHAT_URL);
    expect(plans[0].args.at(-1)).toContain(`task_id: ${dispatchTaskId(CHAT_URL)}`); // stable conversation identity
    expect(plans[0].args.at(-1)).toContain("STATE: FOLLOW"); // the spawned run introduces the protocol
  });

  it("refuses when the user's own message has no @-mention (hard gate)", async () => {
    const { deps: d, plans } = deps({ userMessage: "please create test2 on the desktop" });
    releaseConversation(CHAT_URL);
    const result = await call(d, "在桌面创建 test2 文件夹"); // ChatGPT's task text, no user @
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DISPATCH_UNAUTHORIZED");
    expect(plans).toHaveLength(0);
  });

  it("refuses an @-mention ChatGPT wrote into the task but the user never sent", async () => {
    const { deps: d, plans } = deps({ userMessage: "再创建个test2" });
    const result = await call(d, "@opencode 再创建个test2");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DISPATCH_UNAUTHORIZED");
    expect(plans).toHaveLength(0);
  });

  it("refuses a harness argument the user did not @-mention", async () => {
    const { deps: d, plans } = deps({ userMessage: "@opencode do X" });
    const result = await call(d, "do X", { harness: "codex" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EXECUTOR_MISMATCH");
    expect(plans).toHaveLength(0);
  });

  it("fails closed when the user message cannot be read", async () => {
    const { deps: d, plans } = deps({ userMessageUnreadable: true });
    const result = await call(d, "@opencode do X");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DISPATCH_UNVERIFIED");
    expect(plans).toHaveLength(0);
  });

  it("a [C2C]-injected user turn never authorizes a dispatch", async () => {
    const { deps: d, plans } = deps({ userMessage: "[C2C] STATE … @opencode do X" });
    const result = await call(d, "do X");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DISPATCH_UNAUTHORIZED");
    expect(plans).toHaveLength(0);
  });

  it("refuses honestly with no harness named anywhere", async () => {
    const { deps: d, plans } = deps({ userMessage: "just do the thing" });
    const result = await call(d, "just do the thing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DISPATCH_UNAUTHORIZED");
    expect(plans).toHaveLength(0);
  });

  it("refuses an uninstalled harness", async () => {
    const { deps: d } = deps({ installed: ["codex"], userMessage: "@opencode do X" });
    const mentioned = await call(d, "do X");
    expect(mentioned.ok).toBe(false);
    if (!mentioned.ok) expect(mentioned.code).toBe("HARNESS_NOT_INSTALLED");
  });

  it("one conversation, one agent: a busy conversation is refused", async () => {
    const { deps: d, plans } = deps();
    releaseConversation(CHAT_URL);
    expect(claimConversation(CHAT_URL, "opencode")).toBe(true);
    noteClaimPid(CHAT_URL, process.pid); // a live holder, so the claim stays
    const result = await call(d, "@opencode second task");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CONVERSATION_BUSY");
    expect(plans).toHaveLength(0);
    releaseConversation(CHAT_URL);
  });

  it("a claim the spawn released can be taken again", async () => {
    releaseConversation(CHAT_URL);
    expect(claimConversation(CHAT_URL, "opencode")).toBe(true);
    expect(activeSession(CHAT_URL)?.harness).toBe("opencode");
    expect(activeSession(CHAT_URL)?.taskId).toBe(dispatchTaskId(CHAT_URL));
    releaseConversation(CHAT_URL);
    expect(activeSession(CHAT_URL)).toBeNull();
    expect(claimConversation(CHAT_URL, "codex")).toBe(true);
    releaseConversation(CHAT_URL);
  });

  it("a claim with a dead pid is stale and reclaimable; a live pid holds it", () => {
    releaseConversation(CHAT_URL);
    expect(claimConversation(CHAT_URL, "opencode")).toBe(true);
    noteClaimPid(CHAT_URL, 999999999); // no such process on this machine
    expect(activeSession(CHAT_URL)).toBeNull(); // dead pid: the claim freed itself
    expect(claimConversation(CHAT_URL, "codex")).toBe(true);
    noteClaimPid(CHAT_URL, process.pid); // the bridge itself is alive
    expect(activeSession(CHAT_URL)?.harness).toBe("codex");
    expect(claimConversation(CHAT_URL, "opencode")).toBe(false);
    releaseConversation(CHAT_URL);
  });

  it("defers to a conversation the pinned watcher serves", async () => {
    const { deps: d, plans } = deps({ watched: [CHAT_URL] });
    const result = await call(d, "@opencode do X");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CONVERSATION_WATCHED");
    expect(plans).toHaveLength(0);
  });

  it("fails honestly when the conversation cannot be resolved", async () => {
    const { deps: d, plans } = deps();
    const result = await call(d, "@opencode do X", { resolve: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CONVERSATION_UNRESOLVED");
    expect(plans).toHaveLength(0);
  });

  it("rejects an empty task", async () => {
    const { deps: d } = deps();
    const result = await call(d, "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_TASK");
  });
});

describe("dispatch tool (interactive launch)", () => {
  it("opens the TUI instead of a background run, claiming the conversation for that session", async () => {
    const launches: { harness: HarnessId; prompt: string; chatUrl?: string }[] = [];
    const { deps: d, plans } = deps({
      launchStyle: "interactive",
      openInteractive: async (launch) => {
        launches.push({ harness: launch.harness, prompt: launch.prompt, chatUrl: launch.chatUrl });
        return true;
      },
    });
    const result = await call(d, "@opencode 在桌面建一个名叫 demo 的文件夹");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toContain("interactive opencode terminal");
      expect(result.harness).toBe("opencode");
    }
    expect(plans).toHaveLength(0);
    expect(launches).toHaveLength(1);
    expect(launches[0].harness).toBe("opencode");
    expect(launches[0].chatUrl).toBe(CHAT_URL);
    expect(launches[0].prompt).not.toContain("@opencode");
    expect(activeSession(CHAT_URL)?.harness).toBe("opencode"); // the terminal releases it on exit
    releaseConversation(CHAT_URL);
  });

  it("a busy conversation is refused in interactive mode too, and a failed open releases the claim", async () => {
    const { deps: d, plans } = deps({
      launchStyle: "interactive",
      openInteractive: async () => false,
    });
    const result = await call(d, "@opencode do X");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INTERACTIVE_LAUNCH_FAILED");
    expect(plans).toHaveLength(0);
    expect(activeSession(CHAT_URL)).toBeNull(); // released: the terminal never opened
  });
});
