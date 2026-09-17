#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "cli", "index.js");

// Execute the compiled CLI as the Node entrypoint. Importing it here would
// bypass its main-entry guard, so npm-installed commands would silently do
// nothing.
const command = existsSync(dist)
  ? [process.execPath, dist]
  : [process.execPath, "--import", "tsx/esm", path.join(here, "..", "src", "cli", "index.ts")];
const result = spawnSync(command[0], [...command.slice(1), ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
