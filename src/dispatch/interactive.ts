/**
 * Interactive dispatch: instead of a headless `opencode run` (or codex exec /
 * zcode --prompt), the harness's own TUI opens in a visible terminal window.
 * The user can then switch profiles, steer the run, or just keep talking to
 * the agent there. macOS only for now: a small .command script (Terminal runs
 * it in a new window) prints the dispatch prompt, copies it to the clipboard,
 * then execs the TUI. The prompt body only ever travels through a file — it
 * never becomes shell syntax.
 */

import { execFileSync, spawn as nodeSpawn } from "node:child_process";
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
  /**
   * aweswitch profile names usable for this harness (launch mode). Detected
   * from `aweswitch list` when omitted; pass [] to skip the picker.
   */
  aweswitchProfiles?: string[];
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Profile names aweswitch offers for this harness (`oc-…`, `cx-…`, `zc-…`). */
export function detectAweswitchProfiles(harness: HarnessId): string[] {
  try {
    const out = execFileSync("aweswitch", ["list"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    return out
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length >= 3 && fields[1] === harness)
      .map((fields) => fields[0]);
  } catch {
    return [];
  }
}

/**
 * aweswitch is a dependency of interactive dispatch: the profile picker in
 * the launched terminal needs it. If it is not on PATH, install it (pip).
 */
export async function ensureAweswitch(
  run: (cmd: string, args: string[]) => Promise<number | null> = (cmd, args) =>
    new Promise((resolve) => {
      const child = nodeSpawn(cmd, args, { stdio: "ignore" });
      child.on("exit", (code) => resolve(code));
      child.on("error", () => resolve(-1));
    })
): Promise<{ ok: boolean; alreadyPresent: boolean; note?: string }> {
  if (onPath("aweswitch")) return { ok: true, alreadyPresent: true };
  const code = await run("pip3", ["install", "--user", "aweswitch"]);
  if (code !== 0) {
    return { ok: false, alreadyPresent: false, note: "`pip3 install --user aweswitch` failed — install it yourself (pip3 install aweswitch) for the dispatch profile picker" };
  }
  if (!onPath("aweswitch")) {
    return { ok: false, alreadyPresent: false, note: "aweswitch was installed but is not on PATH yet — open a new terminal (or add pip's user bin dir to PATH) for the dispatch profile picker" };
  }
  return { ok: true, alreadyPresent: false };
}

function onPath(cmd: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function buildCommandScript(launch: InteractiveLaunch, id: string): { script: string; scriptPath: string; promptPath: string } {
  const dir = path.join(getStateDir(), "dispatch");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const promptPath = path.join(dir, `prompt-${id}.md`);
  const scriptPath = path.join(dir, `session-${id}.command`);
  fs.writeFileSync(promptPath, launch.prompt + "\n", { mode: 0o600 });

  const tui = resolveInteractiveCommand(launch.harness, launch.workspaceRoot, launch.commandOverride);
  const tuiLine = `${shellQuote(tui.cmd)}${tui.args.length ? " " + tui.args.map(shellQuote).join(" ") : ""}`;
  const profiles =
    launch.aweswitchProfiles === undefined ? detectAweswitchProfiles(launch.harness) : launch.aweswitchProfiles;
  const profileMenu = profiles.length
    ? [
        'PROFILE=""',
        `profiles=(${profiles.map(shellQuote).join(" ")})`,
        "print -- 'Pick an aweswitch profile for this run:'",
        'i=1; for p in "${profiles[@]}"; do printf "  %%2d) %%s\\n" "$i" "$p"; ((i++)); done',
        'read "reply?Profile number (Enter = plain launch, no profile switch): "',
        'if [[ "$reply" =~ ^[0-9]+$ ]] && (( reply >= 1 && reply <= ${#profiles} )); then',
        '  PROFILE=${profiles[reply]}',
        '  print -- "launching with aweswitch profile: $PROFILE"',
        "fi",
        `if [[ -n "$PROFILE" ]]; then exec aweswitch "$PROFILE" ${tuiLine}; else exec ${tuiLine}; fi`,
      ]
    : [`exec ${tuiLine}`];

  const script = [
    "#!/bin/zsh",
    `cd ${shellQuote(launch.workspaceRoot)}`,
    "clear",
    `cat ${shellQuote(promptPath)}`,
    `printf '\\n———— prompt copied to the clipboard — paste it into the agent below ————\\n\\n'`,
    `pbcopy < ${shellQuote(promptPath)}`,
    ...profileMenu,
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
