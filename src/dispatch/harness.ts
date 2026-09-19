/**
 * Which agent runs a dispatched task, and how to launch it.
 *
 * Selection order: a harness named in the directive text ("用 opencode …",
 * "call codex") wins — the user asked for it in their own message; then the
 * harness pinned on the watch; then the first installed one. Spawning runs
 * the harness's non-interactive mode with the directive as the prompt; the
 * harness's own permission settings apply to the run.
 */

import fs from "node:fs";
import path from "node:path";
import type { HarnessId } from "../adapters/paths.js";
import { HARNESS_IDS } from "../adapters/paths.js";
import { detectHarnesses } from "../adapters/detect.js";

export type HarnessPick =
  | { ok: true; harness: HarnessId }
  | { ok: false; reason: string };

export function pickHarness(
  watch: { harness?: HarnessId },
  directiveText: string,
  installed: readonly HarnessId[] = detectHarnesses()
): HarnessPick {
  const notRunnable = (id: HarnessId): HarnessPick => ({
    ok: false,
    reason: `the dispatch names ${id}, but it is not installed and connected on this machine (installed: ${installed.length ? installed.join(", ") : "none"}; run \`awehitch up\` first)`,
  });
  const mentioned = HARNESS_IDS.find((id) =>
    new RegExp(`(^|[^A-Za-z0-9_-])${id}([^A-Za-z0-9_-]|$)`, "i").test(directiveText)
  );
  if (mentioned) return installed.includes(mentioned) ? { ok: true, harness: mentioned } : notRunnable(mentioned);
  if (watch.harness) return installed.includes(watch.harness) ? { ok: true, harness: watch.harness } : notRunnable(watch.harness);
  const fallback = installed[0];
  return fallback ? { ok: true, harness: fallback } : { ok: false, reason: "no coding agent is installed and connected on this machine; run `awehitch up` in the project first" };
}

export interface SpawnPlan {
  harness: HarnessId;
  cmd: string;
  args: string[];
  cwd: string;
}

/**
 * Non-interactive launch per harness. codex exec is told the root twice
 * (--cd and cwd) so it also accepts non-git workspaces; zcode is resolved
 * from PATH first and falls back to the macOS app bundle's CLI entry, run
 * by this process's own Node. The prompt travels as argv (no shell), so a
 * directive body can never become shell syntax.
 */
export function planSpawn(
  harness: HarnessId,
  workspaceRoot: string,
  prompt: string,
  commandOverride?: string
): SpawnPlan {
  switch (harness) {
    case "codex":
      return {
        harness,
        cmd: commandOverride ?? "codex",
        args: ["exec", "--cd", workspaceRoot, "--skip-git-repo-check", prompt],
        cwd: workspaceRoot,
      };
    case "opencode":
      return { harness, cmd: commandOverride ?? "opencode", args: ["run", prompt], cwd: workspaceRoot };
    case "zcode": {
      if (commandOverride) return { harness, cmd: commandOverride, args: ["--prompt", prompt, "--cwd", workspaceRoot], cwd: workspaceRoot };
      if (!onPath("zcode") && process.platform === "darwin") {
        const bundled = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
        if (fs.existsSync(bundled)) {
          return { harness, cmd: process.execPath, args: [bundled, "--prompt", prompt, "--cwd", workspaceRoot], cwd: workspaceRoot };
        }
      }
      return { harness, cmd: "zcode", args: ["--prompt", prompt, "--cwd", workspaceRoot], cwd: workspaceRoot };
    }
  }
}

/**
 * The command behind an interactive dispatch: the harness's own TUI in the
 * workspace, started by a visible terminal window the user can type into
 * (switch profile, steer, continue the conversation).
 */
export function resolveInteractiveCommand(
  harness: HarnessId,
  workspaceRoot: string,
  commandOverride?: string
): { cmd: string; args: string[] } {
  switch (harness) {
    case "codex":
      return { cmd: commandOverride ?? "codex", args: ["--cd", workspaceRoot] };
    case "opencode":
      return { cmd: commandOverride ?? "opencode", args: [] };
    case "zcode": {
      if (commandOverride) return { cmd: commandOverride, args: [] };
      if (!onPath("zcode") && process.platform === "darwin") {
        const bundled = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
        if (fs.existsSync(bundled)) return { cmd: process.execPath, args: [bundled] };
      }
      return { cmd: "zcode", args: [] };
    }
  }
}

function onPath(cmd: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
