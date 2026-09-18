import { afterEach, describe, expect, it } from "vitest";
import {
  buildHandoffMessage,
  clearChatPointer,
  mergeSession,
  normalizeProjectUrl,
  projectIdFromUrl,
  readSession,
  resolveConversation,
  writeSession,
  type TaskCheckpoint,
} from "../src/session/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const PROJECT = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";

describe("normalizeProjectUrl", () => {
  it("accepts the collection URL and strips extras", () => {
    expect(normalizeProjectUrl(`${PROJECT}/`)).toBe(PROJECT);
    expect(normalizeProjectUrl("https://www.chatgpt.com/g/g-p-abc123/project?foo=1")).toBe(
      "https://chatgpt.com/g/g-p-abc123/project"
    );
    expect(projectIdFromUrl(PROJECT)).toBe("g-p-6a94399430e08191860ab5364b7748b8");
  });

  it("rejects a normal chat URL or a guessed name", () => {
    expect(normalizeProjectUrl("https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBeNull();
    expect(normalizeProjectUrl("https://chatgpt.com/")).toBeNull();
    expect(normalizeProjectUrl("https://example.com/g/g-p-abc/project")).toBeNull();
  });
});

describe("resolveConversation", () => {
  it("treats a missing file as a new workspace (Project by default)", () => {
    const view = resolveConversation(null);
    expect(view.mode).toBe("project");
    expect(view.reason).toBe("new-workspace");
    expect(view.reuseSavedChat).toBe(false);
    expect(view.projectReady).toBe(false);
  });

  it("keeps a legacy session file on long-chat and does not migrate", () => {
    const view = resolveConversation({
      url: "https://chatgpt.com/c/old-chat",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("long-chat");
    expect(view.reason).toBe("existing-long-chat");
    expect(view.reuseSavedChat).toBe(true);
    expect(view.chatUrl).toBe("https://chatgpt.com/c/old-chat");
  });

  it("lets an explicit long-chat opt-out win over a leftover collection URL", () => {
    const view = resolveConversation({
      conversationMode: "long-chat",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/keep",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("long-chat");
    expect(view.reuseSavedChat).toBe(true);
  });

  it("uses Project when a collection URL is stored", () => {
    const view = resolveConversation({
      conversationMode: "project",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/thread-1",
      connectorName: "Codex with ChatGPT · Demo",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("project");
    expect(view.projectReady).toBe(true);
    expect(view.reuseSavedChat).toBe(false);
    expect(view.connectorName).toBe("Codex with ChatGPT · Demo");
  });
});

describe("mergeSession", () => {
  it("keeps Project fields when only the chat URL is updated", () => {
    const next = mergeSession(
      {
        conversationMode: "project",
        projectUrl: PROJECT,
        connectorName: "Codex with ChatGPT · Demo",
        url: "https://chatgpt.com/c/old",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      { url: "https://chatgpt.com/c/new", taskId: "c2c_ab12", iteration: 1 }
    );
    expect(next.projectUrl).toBe(PROJECT);
    expect(next.conversationMode).toBe("project");
    expect(next.url).toBe("https://chatgpt.com/c/new");
    expect(next.connectorName).toBe("Codex with ChatGPT · Demo");
    expect(next.taskId).toBe("c2c_ab12");
  });

  it("writes and clears a checkpoint without dropping the chat URL", () => {
    const withCheckpoint = mergeSession(
      {
        url: "https://chatgpt.com/c/keep",
        taskId: "c2c_ab12",
        iteration: 7,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "EXECUTED_SENT",
          waitingFor: "GPT_REVIEW",
          originalGoal: "dark mode",
          nextExpectedStep: "wait for review",
        },
      }
    );
    expect(withCheckpoint.url).toBe("https://chatgpt.com/c/keep");
    expect(withCheckpoint.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(withCheckpoint.checkpoint?.waitingFor).toBe("GPT_REVIEW");
    expect(withCheckpoint.checkpoint?.taskId).toBe("c2c_ab12");
    const cleared = mergeSession(withCheckpoint, { clearCheckpoint: true });
    expect(cleared.checkpoint).toBeUndefined();
    expect(cleared.url).toBe("https://chatgpt.com/c/keep");
  });

  it("keeps an existing checkpoint when only the chat URL is updated", () => {
    const previous = mergeSession(
      {
        url: "https://chatgpt.com/c/keep",
        taskId: "c2c_ab12",
        iteration: 7,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "EXECUTED_SENT",
          waitingFor: "GPT_REVIEW",
          originalGoal: "dark mode",
        },
      }
    );
    const next = mergeSession(previous, { url: "https://chatgpt.com/c/new" });
    expect(next.url).toBe("https://chatgpt.com/c/new");
    expect(next.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(next.checkpoint?.originalGoal).toBe("dark mode");
  });

  it("caps checkpoint text so it cannot become a log dump", () => {
    const next = mergeSession(
      {
        url: "https://chatgpt.com/c/keep",
        taskId: "c2c_ab12",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "PLAN_RECEIVED",
          originalGoal: "x".repeat(600),
        },
      }
    );
    expect(next.checkpoint?.originalGoal?.length).toBeLessThanOrEqual(501);
    expect(next.checkpoint?.originalGoal?.endsWith("…")).toBe(true);
  });

  it("leaves legacy sessions without a checkpoint unchanged", () => {
    const next = mergeSession(
      {
        url: "https://chatgpt.com/c/old",
        taskId: "c2c_aa01",
        iteration: 2,
        lastState: "EXECUTED",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      { iteration: 3, lastState: "EXECUTED" }
    );
    expect(next.checkpoint).toBeUndefined();
    expect(next.taskId).toBe("c2c_aa01");
  });

  it("rejects a non-collection project URL", () => {
    expect(() =>
      mergeSession(null, {
        conversationMode: "project",
        projectUrl: "https://chatgpt.com/c/nope",
      })
    ).toThrow(/project URL/);
  });
});

describe("clearChatPointer", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.AWEHITCH_STATE_DIR;
  });

  it("keeps the collection binding in Project mode", () => {
    const dir = makeTmpDir("session-clear");
    dirs.push(dir);
    process.env.AWEHITCH_STATE_DIR = dir;
    writeSession("abc123abc123", {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/gone",
      connectorName: "Codex with ChatGPT · Demo",
      checkpoint: {
        taskId: "c2c_ab12",
        iteration: 4,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        originalGoal: "dark mode",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(clearChatPointer("abc123abc123")).toEqual({ cleared: true, keptProject: true });
    const saved = readSession("abc123abc123");
    expect(saved?.projectUrl).toBe(PROJECT);
    expect(saved?.url).toBeUndefined();
    expect(saved?.checkpoint?.protocolState).toBe("EXECUTED_SENT");
  });

  it("deletes a legacy long-chat file", () => {
    const dir = makeTmpDir("session-clear-legacy");
    dirs.push(dir);
    process.env.AWEHITCH_STATE_DIR = dir;
    writeSession("def456def456", {
      url: "https://chatgpt.com/c/legacy",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(clearChatPointer("def456def456")).toEqual({ cleared: true, keptProject: false });
    expect(readSession("def456def456")).toBeNull();
  });

  it("isolates checkpoints per harness", () => {
    const dir = makeTmpDir("session-harness");
    dirs.push(dir);
    process.env.AWEHITCH_STATE_DIR = dir;
    writeSession(
      "abc123abc123",
      {
        taskId: "task_codex",
        savedAt: "2026-01-01T00:00:00.000Z",
        checkpoint: {
          taskId: "task_codex",
          iteration: 1,
          protocolState: "EXECUTED_SENT",
          waitingFor: "GPT_REVIEW",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      "codex"
    );
    writeSession(
      "abc123abc123",
      {
        taskId: "task_zcode",
        savedAt: "2026-01-01T00:00:00.000Z",
        checkpoint: {
          taskId: "task_zcode",
          iteration: 2,
          protocolState: "PLAN_RECEIVED",
          waitingFor: "none",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      "zcode"
    );
    // Two harnesses never see each other's loop state.
    expect(readSession("abc123abc123", "codex")?.checkpoint?.taskId).toBe("task_codex");
    expect(readSession("abc123abc123", "zcode")?.checkpoint?.taskId).toBe("task_zcode");
    expect(readSession("abc123abc123")).toBeNull();
    // Clearing one slice leaves the other intact.
    clearChatPointer("abc123abc123", "codex");
    expect(readSession("abc123abc123", "codex")).toBeNull();
    expect(readSession("abc123abc123", "zcode")?.checkpoint?.taskId).toBe("task_zcode");
  });
});

describe("buildHandoffMessage", () => {
  const checkpoint: TaskCheckpoint = {
    taskId: "c2c_f81a",
    iteration: 4,
    protocolState: "EXECUTED_SENT",
    waitingFor: "GPT_REVIEW",
    originalGoal: "Implement dark mode.",
    completedSubtasks: "- Iter 1-2: theme context + toggle\n- Iter 3: persistence",
    knownIssues: "Flash-on-load fix needs verification.",
    nextExpectedStep: "Review iteration 4 via git_diff, reply PLAN or DONE.",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("renders the [C2C] HANDOFF brief with headers and sections", () => {
    const message = buildHandoffMessage(checkpoint);
    expect(message.startsWith("[C2C]\nSTATE: HANDOFF")).toBe(true);
    expect(message).toContain("TASK_ID: c2c_f81a");
    expect(message).toContain("ITERATION: 4");
    expect(message).toContain("ORIGINAL_GOAL:\nImplement dark mode.");
    expect(message).toContain("PROGRESS:\n- Iter 1-2: theme context + toggle");
    expect(message).toContain("CURRENT_STATE:\nEXECUTED_SENT (waiting for GPT_REVIEW)");
    expect(message).toContain("KNOWN_ISSUES:\nFlash-on-load fix needs verification.");
    expect(message).toContain("NEXT_EXPECTED_STEP:\nReview iteration 4 via git_diff");
  });

  it("states missing fields honestly instead of inventing history", () => {
    const message = buildHandoffMessage({
      taskId: "c2c_0000",
      iteration: 0,
      protocolState: "INIT",
      waitingFor: "GPT_PLAN",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(message).toContain("ORIGINAL_GOAL:\n(not recorded)");
    expect(message).toContain("PROGRESS:\n(not recorded)");
    expect(message).toContain("KNOWN_ISSUES:\n(none)");
    expect(message).toContain("NEXT_EXPECTED_STEP:\n(not recorded)");
  });

  it("stays under the 2 KB control-message limit even with capped CJK fields", () => {
    const message = buildHandoffMessage({
      ...checkpoint,
      originalGoal: "暗".repeat(500),
      completedSubtasks: "进".repeat(800),
      knownIssues: "问".repeat(800),
      nextExpectedStep: "步".repeat(400),
    });
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(2048);
    expect(message).toContain("…");
  });
});
