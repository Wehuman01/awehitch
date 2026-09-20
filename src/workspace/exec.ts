import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { Workspace, WorkspaceError } from "./manager.js";

/**
 * Gated command execution for chatgptMode "write-exec". No shell anywhere:
 * argv goes to spawn verbatim, so expansion, pipes and redirection are
 * structurally impossible. Network clients, privilege escalation and
 * destructive system tools are denied by executable name; git's
 * network-touching subcommands are denied too. The child inherits no
 * environment — only PATH and LANG — so secrets never reach it.
 */
const DENIED_EXECUTABLES = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "ssh",
  "scp",
  "sftp",
  "telnet",
  "ftp",
  "rsync",
  "sudo",
  "su",
  "doas",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "mkfs",
  "mkfs.ext4",
  "mkfs.apfs",
  "dd",
  "fdisk",
  "diskutil",
]);

const DENIED_GIT_SUBCOMMANDS = new Set(["push", "fetch", "pull", "clone", "remote", "submodule"]);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface RunCommandOptions {
  command: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface RunCommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export async function runWorkspaceCommand(
  workspace: Workspace,
  opts: RunCommandOptions
): Promise<RunCommandResult> {
  const argv = opts.command;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string" || a.includes("\0"))) {
    throw new WorkspaceError("INVALID_ARGUMENTS", "command must be a non-empty array of strings (argv, no shell).");
  }

  const exe = path.basename(argv[0]);
  if (DENIED_EXECUTABLES.has(exe)) {
    throw new WorkspaceError(
      "COMMAND_DENIED",
      `'${exe}' is not allowed in write-exec mode (network clients, privilege escalation and destructive system tools are denied).`
    );
  }
  if (exe === "git" && argv.length > 1 && DENIED_GIT_SUBCOMMANDS.has(argv[1])) {
    throw new WorkspaceError(
      "COMMAND_DENIED",
      `git ${argv[1]} is not allowed in write-exec mode (git's network-touching subcommands are denied).`
    );
  }

  const { abs } = workspace.resolve(opts.cwd ?? ".");
  let cwdIsDirectory: boolean;
  try {
    cwdIsDirectory = fs.statSync(abs).isDirectory();
  } catch {
    throw new WorkspaceError("FILE_NOT_FOUND", `cwd not found: ${opts.cwd ?? "."}`);
  }
  if (!cwdIsDirectory) {
    throw new WorkspaceError("NOT_A_DIRECTORY", `cwd is not a directory: ${opts.cwd ?? "."}`);
  }

  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
  const started = Date.now();

  return await new Promise<RunCommandResult>((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: abs,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: process.env.LANG ?? "en_US.UTF-8", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      stderr += chunk.toString("utf8");
    });

    let settled = false;
    const finish = (exitCode: number | null, timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: argv.join(" "),
        cwd: path.relative(workspace.root, abs) || ".",
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        truncated,
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, true);
    }, timeoutMs);

    child.on("error", (error) => {
      stderr += `\n${error.message}`;
      finish(null, false);
    });
    child.on("close", (code) => finish(code, false));
  });
}
