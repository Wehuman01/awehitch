import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPATCH_MARKER,
  isAgentInjected,
  isDispatchAuthorized,
  parseDirective,
  resolveDispatchMarker,
} from "../src/control-plane/dispatch.js";

describe("resolveDispatchMarker", () => {
  it("falls back to the default marker", () => {
    expect(resolveDispatchMarker(undefined)).toBe(DEFAULT_DISPATCH_MARKER);
    expect(resolveDispatchMarker("  ")).toBe(DEFAULT_DISPATCH_MARKER);
    expect(resolveDispatchMarker("@hand")).toBe("@hand");
  });
});

describe("isDispatchAuthorized", () => {
  it("authorizes a message that carries the marker as a token", () => {
    expect(isDispatchAuthorized("@agent fix the login page", "@agent")).toBe(true);
    expect(isDispatchAuthorized("please @agent, fix it", "@agent")).toBe(true);
    expect(isDispatchAuthorized("@agent", "@agent")).toBe(true);
  });

  it("rejects markers embedded in longer tokens", () => {
    expect(isDispatchAuthorized("not@agent", "@agent")).toBe(false);
    expect(isDispatchAuthorized("@agent-x", "@agent")).toBe(false);
    expect(isDispatchAuthorized("email@agent.com", "@agent")).toBe(false);
    expect(isDispatchAuthorized("@agent_zzz", "@agent")).toBe(false);
  });

  it("rejects missing or marker-less messages", () => {
    expect(isDispatchAuthorized(null, "@agent")).toBe(false);
    expect(isDispatchAuthorized(undefined, "@agent")).toBe(false);
    expect(isDispatchAuthorized("", "@agent")).toBe(false);
    expect(isDispatchAuthorized("just chatting about @openai models", "@agent")).toBe(false);
  });

  it("supports custom markers, CJK text around them", () => {
    expect(isDispatchAuthorized("来吧@干活的 修一下", "@干活的")).toBe(true);
    expect(isDispatchAuthorized("聊聊架构", "@干活的")).toBe(false);
  });
});

describe("parseDirective", () => {
  it("parses a directive with a one-line summary and a body", () => {
    const reply = "[C2C]\nDIRECTIVE: fix the Safari validation\nmigrate to src/utils/validation.ts\nrun tests";
    const { isDirective, body } = parseDirective(reply);
    expect(isDirective).toBe(true);
    expect(body).toBe("fix the Safari validation\nmigrate to src/utils/validation.ts\nrun tests");
  });

  it("accepts a directive that is only a header line", () => {
    const { isDirective, body } = parseDirective("[C2C]\nDIRECTIVE: stop");
    expect(isDirective).toBe(true);
    expect(body).toBe("stop");
  });

  it("rejects plain conversation and other control messages", () => {
    expect(parseDirective("The architecture looks fine overall.").isDirective).toBe(false);
    expect(parseDirective(null).isDirective).toBe(false);
    expect(parseDirective("[C2C]\nSTATE: DONE").isDirective).toBe(false);
  });

  it("rejects a state message that also carries a DIRECTIVE line", () => {
    const reply = "[C2C]\nSTATE: EXECUTED\nDIRECTIVE: echoed back somehow";
    expect(parseDirective(reply).isDirective).toBe(false);
  });
});

describe("isAgentInjected", () => {
  it("marks [C2C] composer sends as machine-authored", () => {
    expect(isAgentInjected("[C2C]\nSTATE: EXECUTED\nRESULT: ok")).toBe(true);
    expect(isAgentInjected("  [C2C]\nSTATE: EXECUTED")).toBe(true);
    expect(isAgentInjected("[C2C]\nSTATE: FOLLOW\n...")).toBe(true);
  });

  it("never marks user-typed text, even with a marker inside", () => {
    expect(isAgentInjected("@agent fix the login page")).toBe(false);
    expect(isAgentInjected("来吧 @opencode 修一下")).toBe(false);
    expect(isAgentInjected(null)).toBe(false);
    expect(isAgentInjected(undefined)).toBe(false);
    expect(isAgentInjected("")).toBe(false);
  });
});
