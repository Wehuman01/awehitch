import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Workspace, effectiveMode } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

let dir: string;

beforeEach(() => {
  dir = makeTmpDir("follow-config");
});

describe("follow config parsing", () => {
  it("defaults to lead mode with no follow block", () => {
    const ws = new Workspace(dir);
    expect(effectiveMode(ws.projectConfig)).toBe("lead");
    expect(ws.projectConfig.follow ?? {}).toEqual({});
  });

  it("reads mode and the follow block", () => {
    write(
      dir,
      ".c2c.json",
      JSON.stringify({
        name: "myrepo",
        mode: "follow",
        follow: { chatWrite: false, dispatchMarker: "@hand" },
      })
    );
    const ws = new Workspace(dir);
    expect(effectiveMode(ws.projectConfig)).toBe("follow");
    expect(ws.projectConfig.follow).toEqual({
      chatWrite: false,
      dispatchMarker: "@hand",
    });
  });

  it("drops invalid follow values instead of failing the workspace", () => {
    write(
      dir,
      ".c2c.json",
      JSON.stringify({
        mode: "follow",
        follow: { chatWrite: "no", dispatchMarker: "  " },
      })
    );
    const ws = new Workspace(dir);
    expect(effectiveMode(ws.projectConfig)).toBe("follow");
    expect(ws.projectConfig.follow).toEqual({});
  });

  it("treats an unknown mode as lead (unchanged behavior)", () => {
    write(dir, ".c2c.json", JSON.stringify({ mode: "sideways" }));
    expect(effectiveMode(new Workspace(dir).projectConfig)).toBe("lead");
    // And an explicitly written lead stays lead.
    write(dir, ".c2c.json", JSON.stringify({ mode: "lead" }));
    expect(effectiveMode(new Workspace(dir).projectConfig)).toBe("lead");
  });

  it("does not create .c2c.json on read", () => {
    new Workspace(dir);
    expect(fs.existsSync(path.join(dir, ".c2c.json"))).toBe(false);
  });
});

describe("setMode", () => {
  it("creates .c2c.json when absent and updates the live config", () => {
    const ws = new Workspace(dir);
    ws.setMode("follow");
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".c2c.json"), "utf8"))).toEqual({ mode: "follow" });
    expect(effectiveMode(ws.projectConfig)).toBe("follow");
    expect(effectiveMode(new Workspace(dir).projectConfig)).toBe("follow");
  });

  it("preserves every other field when switching", () => {
    write(
      dir,
      ".c2c.json",
      JSON.stringify({ name: "keep", maxIterations: 3, mode: "follow", follow: { dispatchMarker: "@x" } })
    );
    new Workspace(dir).setMode("lead");
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".c2c.json"), "utf8"))).toEqual({
      name: "keep",
      maxIterations: 3,
      mode: "lead",
      follow: { dispatchMarker: "@x" },
    });
  });

  it("refuses to clobber a broken .c2c.json", () => {
    write(dir, ".c2c.json", "{ not json");
    expect(() => new Workspace(dir).setMode("follow")).toThrow(/not valid JSON/);
    expect(fs.readFileSync(path.join(dir, ".c2c.json"), "utf8")).toBe("{ not json");
  });
});

afterEach(() => {
  cleanup(dir);
});
