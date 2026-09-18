import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

let root: string;
let bridge: Bridge;
let base: string;

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("bridge-err");
  write(root, "a.txt", "a\n");
  bridge = await startBridge({
    workspaceRoots: [root],
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth-err"), "store.json"),
  });
  base = bridge.localBaseUrl();
});

afterAll(async () => {
  await bridge.close();
  cleanup(root);
});

describe("bridge error handling", () => {
  it("answers malformed request bodies with opaque JSON, never a stack trace", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer c2c_at_x" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toMatch(/\bat \b/); // no stack frames
    expect(text).not.toContain(root); // no absolute paths
    const body = JSON.parse(text) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toBe("Malformed request");
  });
});
