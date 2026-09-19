import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

let dir: string;

beforeEach(() => {
  dir = makeTmpDir("dispatch-marker-config");
});

describe("dispatch marker config parsing", () => {
  it("has no marker configured by default", () => {
    const ws = new Workspace(dir);
    expect(ws.projectConfig.dispatchMarker).toBeUndefined();
  });

  it("reads the top-level dispatchMarker", () => {
    write(dir, ".c2c.json", JSON.stringify({ name: "myrepo", dispatchMarker: "@hand" }));
    const ws = new Workspace(dir);
    expect(ws.projectConfig.dispatchMarker).toBe("@hand");
  });

  it("still honors the legacy follow.dispatchMarker (v0.2.7 configs)", () => {
    write(
      dir,
      ".c2c.json",
      JSON.stringify({ mode: "follow", follow: { chatWrite: false, dispatchMarker: "@hand" } })
    );
    const ws = new Workspace(dir);
    expect(ws.projectConfig.dispatchMarker).toBe("@hand");
  });

  it("top-level dispatchMarker wins over the legacy follow block", () => {
    write(
      dir,
      ".c2c.json",
      JSON.stringify({ dispatchMarker: "@new", follow: { dispatchMarker: "@old" } })
    );
    const ws = new Workspace(dir);
    expect(ws.projectConfig.dispatchMarker).toBe("@new");
  });

  it("drops invalid marker values instead of failing the workspace", () => {
    write(
      dir,
      ".c2c.json",
      JSON.stringify({ dispatchMarker: "  ", follow: { dispatchMarker: 7 } })
    );
    const ws = new Workspace(dir);
    expect(ws.projectConfig.dispatchMarker).toBeUndefined();
  });

  it("does not create .c2c.json on read", () => {
    new Workspace(dir);
    expect(fs.existsSync(path.join(dir, ".c2c.json"))).toBe(false);
  });
});

afterEach(() => {
  cleanup(dir);
});
