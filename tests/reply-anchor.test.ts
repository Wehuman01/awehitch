import { describe, expect, it } from "vitest";
import { isFreshReply } from "../src/control-plane/browser.js";

/**
 * Unit tests for the stale-reply guard: waits must not report the previous
 * turn's reply as the answer to the last send.
 */

const anchor = { count: 2, text: "[C2C]\nSTATE: PLAN\n..." };

describe("isFreshReply", () => {
  it("accepts any reply when no send anchor exists (fresh process)", () => {
    expect(isFreshReply({ messageCount: 5, text: "old text" }, null)).toBe(true);
  });

  it("rejects the pre-send reply (the stale case)", () => {
    expect(isFreshReply({ messageCount: 2, text: "[C2C]\nSTATE: PLAN\n..." }, anchor)).toBe(false);
  });

  it("accepts a newly appended reply", () => {
    expect(isFreshReply({ messageCount: 3, text: "[C2C]\nSTATE: DONE\n..." }, anchor)).toBe(true);
  });

  it("accepts a last message that changed in place", () => {
    expect(isFreshReply({ messageCount: 2, text: "[C2C]\nSTATE: DONE\n..." }, anchor)).toBe(true);
  });

  it("accepts a different conversation (count moved)", () => {
    expect(isFreshReply({ messageCount: 1, text: "hello" }, anchor)).toBe(true);
  });
});
