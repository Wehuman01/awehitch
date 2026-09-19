import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPATCH_MARKER,
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
    expect(isDispatchAuthorized("@opencode fix the login page", "@opencode")).toBe(true);
    expect(isDispatchAuthorized("please @opencode, fix it", "@opencode")).toBe(true);
    expect(isDispatchAuthorized("@opencode", "@opencode")).toBe(true);
  });

  it("rejects markers embedded in longer tokens", () => {
    expect(isDispatchAuthorized("not@opencode", "@opencode")).toBe(false);
    expect(isDispatchAuthorized("@opencode-x", "@opencode")).toBe(false);
    expect(isDispatchAuthorized("email@opencode.com", "@opencode")).toBe(false);
    expect(isDispatchAuthorized("@opencode_zzz", "@opencode")).toBe(false);
  });

  it("rejects missing or marker-less messages", () => {
    expect(isDispatchAuthorized(null, "@opencode")).toBe(false);
    expect(isDispatchAuthorized(undefined, "@opencode")).toBe(false);
    expect(isDispatchAuthorized("", "@opencode")).toBe(false);
    expect(isDispatchAuthorized("just chatting about @openai models", "@opencode")).toBe(false);
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
