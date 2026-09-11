import { parseArgs } from "node:util";
import { runStdioServer } from "./server.js";

/**
 * Test-only stdio entry: same as the CLI `control-plane` command but without
 * commander. Keeps the spawn-able surface minimal for tests.
 * NOT part of the public API — tests spawn this file through tsx.
 */
const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
  },
});
if (!values.workspace) {
  process.stderr.write("--workspace is required\n");
  process.exit(1);
}
await runStdioServer(values.workspace);
