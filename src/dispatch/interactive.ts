/**
 * Interactive dispatch: instead of a headless `opencode run` (or codex exec /
 * zcode --prompt), the harness's own TUI opens in a visible terminal window.
 * The user can then switch profiles, steer the run, or just keep talking to
 * the agent there. macOS only for now: a small .command script (Terminal runs
 * it in a new window) prints the dispatch prompt, copies it to the clipboard,
 * then execs the TUI. The prompt body only ever travels through a file — it
 * never becomes shell syntax.
 */

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HarnessId } from "../adapters/paths.js";
import { resolveInteractiveCommand } from "./harness.js";
import { getStateDir } from "../config/paths.js";

export interface InteractiveLaunch {
  harness: HarnessId;
  workspaceRoot: string;
  prompt: string;
  commandOverride?: string;
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

export function buildCommandScript(launch: InteractiveLaunch, id: string): { script: string; scriptPath: string; promptPath: string } {
  const dir = path.join(getStateDir(), "dispatch");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const promptPath = path.join(dir, `prompt-${id}.md`);
  const scriptPath = path.join(dir, `session-${id}.command`);
  fs.writeFileSync(promptPath, launch.prompt + "\n", { mode: 0o600 });

  const tui = resolveInteractiveCommand(launch.harness, launch.workspaceRoot, launch.commandOverride);
  const script = [
    "#!/bin/zsh",
    `cd ${shellQuote(launch.workspaceRoot)}`,
    "clear",
    `cat ${shellQuote(promptPath)}`,
    `printf '\\n———— prompt copied to the clipboard — paste it into the agent below (switch profile first if you like) ————\\n\\n'`,
    `pbcopy < ${shellQuote(promptPath)}`,
    `exec ${shellQuote(tui.cmd)}${tui.args.length ? " " + tui.args.map(shellQuote).join(" ") : ""}`,
    "",
  ].join("\n");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  return { script, scriptPath, promptPath };
}

export async function openInteractiveTerminal(launch: InteractiveLaunch): Promise<{ ok: true; scriptPath: string } | { ok: false; reason: string }> {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "interactive dispatch needs macOS Terminal; use `awehitch dispatch launch headless`" };
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const { scriptPath } = buildCommandScript(launch, id);
  const exit = await new Promise<number | null>((resolve) => {
    const child = nodeSpawn("open", ["-a", "Terminal", scriptPath], { stdio: "ignore", detached: true });
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(-1));
  });
  if (exit !== 0) {
    return { ok: false, reason: `opening Terminal failed with exit code ${exit}` };
  }
  return { ok: true, scriptPath };
}
