import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { IgnoreRules } from "./ignore.js";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runGit(root: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
  };
}

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

export function gitInfo(root: string): GitInfo {
  const check = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok || check.stdout.trim() !== "true") {
    return { isRepo: false, branch: null, commit: null, dirty: false };
  }
  const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = runGit(root, ["rev-parse", "--short", "HEAD"]);
  // Pathspec confines the result to the workspace subtree even when the
  // workspace root sits inside a larger repository.
  const status = runGit(root, ["status", "--porcelain", "--", "."]);
  return {
    isRepo: true,
    branch: branch.ok ? branch.stdout.trim() : null,
    commit: commit.ok ? commit.stdout.trim() : null,
    dirty: status.ok ? status.stdout.trim().length > 0 : false,
  };
}

/** Directory whose enclosing repo answers a scope: the scope itself, or its parent for a file. */
function scopedDir(root: string, relPath?: string): string {
  if (!relPath || relPath === "." || relPath === "") return root;
  const abs = path.resolve(root, relPath);
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(abs);
  } catch {
    // Missing path: keep the requested dir — git fails honestly from there.
  }
  return st?.isFile() ? path.dirname(abs) : abs;
}

/**
 * Repo root for a scope: the enclosing repo of the scope directory. A
 * workspace-rooted repo resolves to itself; a scoped subdirectory that is
 * its own repo (a project under a home-rooted workspace) resolves to that
 * repo. Git commands then run at the repo root, so rename pairing sees the
 * whole repo and diff paths stay repo-root-relative. The workspace stays the
 * read boundary: every token is converted to a workspace-relative path and
 * dropped when it escapes the workspace.
 */
function resolveRepoRoot(absDir: string): string | null {
  const top = runGit(absDir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  return top.stdout.trim() || null;
}

/** Workspace-relative form of a repo-root-relative path; null when it escapes the workspace. */
function toWsRel(root: string, repoRoot: string, repoRel: string): string | null {
  const abs = path.resolve(repoRoot, repoRel);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** Pathspec (relative to the repo root) for a workspace-relative path. */
function toRepoRel(dir: string, root: string, wsRel: string): string {
  return path.relative(dir, path.resolve(root, wsRel)).split(path.sep).join("/");
}

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: { path: string; change: string }[];
  unstaged: { path: string; change: string }[];
  untracked: string[];
  conflicted: string[];
}

export function gitStatus(root: string, relPath?: string): GitStatusResult {
  const empty: GitStatusResult = {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  const repoRoot = resolveRepoRoot(scopedDir(root, relPath));
  if (!repoRoot) return empty;
  const result = runGit(repoRoot, ["status", "--porcelain=v2", "--branch", "--", "."]);
  if (!result.ok) return empty;
  // Paths come back relative to the repo root; report them relative to the
  // workspace so callers see the same paths read_file expects. Paths outside
  // the workspace subtree are dropped (possible only when the workspace root
  // sits inside a larger repository).
  const toWs = (p: string): string | null => toWsRel(root, repoRoot, p);
  const out: GitStatusResult = { ...empty, isRepo: true };
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      out.branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      out.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        out.ahead = parseInt(m[1], 10);
        out.behind = parseInt(m[2], 10);
      }
    } else if (line.startsWith("1 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const ws = toWs(parts.slice(8).join(" "));
      if (!ws) continue;
      if (xy[0] !== ".") out.staged.push({ path: ws, change: xy[0] });
      if (xy[1] !== ".") out.unstaged.push({ path: ws, change: xy[1] });
    } else if (line.startsWith("2 ")) {
      const xy = line.split(" ")[1];
      const tab = line.split("\t");
      const toPath = toWs(tab[0].split(" ").slice(9).join(" "));
      const fromPath = tab[1] !== undefined ? toWs(tab[1]) : null;
      if (!toPath || !fromPath) continue;
      if (xy[0] !== ".") out.staged.push({ path: `${toPath} -> ${fromPath}`, change: xy[0] });
      if (xy[1] !== ".") out.unstaged.push({ path: `${toPath} -> ${fromPath}`, change: xy[1] });
    } else if (line.startsWith("? ")) {
      const ws = toWs(line.slice(2));
      if (ws) out.untracked.push(ws);
    } else if (line.startsWith("u ")) {
      const parts = line.split(" ");
      const ws = toWs(parts.slice(10).join(" "));
      if (ws) out.conflicted.push(ws);
    }
  }
  return out;
}

export type DiffMode = "unstaged" | "staged" | "head";

export interface GitDiffOptions {
  mode?: DiffMode;
  path?: string;
  offset?: number;
  maxBytes?: number;
}

export interface GitDiffResult {
  isRepo: boolean;
  mode: DiffMode;
  totalBytes: number;
  offset: number;
  returnedBytes: number;
  hasMore: boolean;
  nextOffset: number | null;
  diff: string;
}

export interface WorkspaceLike {
  root: string;
  ignoreRules?: IgnoreRules;
}

export type GitTarget = string | WorkspaceLike;

function getDiffModeArgs(mode: DiffMode): string[] {
  if (mode === "staged") return ["--cached"];
  if (mode === "head") return ["HEAD"];
  return [];
}

function chunkSafePaths(paths: string[], maxCount = 50, maxBytes = 32 * 1024): string[][] {
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentBytes = 0;

  for (const p of paths) {
    const pBytes = Buffer.byteLength(p, "utf8") + 12; // overhead for ":(literal)"
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxCount || currentBytes + pBytes > maxBytes)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }
    currentBatch.push(p);
    currentBytes += pBytes;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}

function isPathInScope(filePath: string, scope?: string): boolean {
  if (!scope || scope === ".") return true;
  return filePath === scope || filePath.startsWith(scope + "/");
}

function notARepo(mode: DiffMode): GitDiffResult {
  return {
    isRepo: false,
    mode,
    totalBytes: 0,
    offset: 0,
    returnedBytes: 0,
    hasMore: false,
    nextOffset: null,
    diff: "",
  };
}

export function gitDiff(
  target: GitTarget,
  opts: GitDiffOptions = {},
  relPath?: string
): GitDiffResult {
  const root = typeof target === "string" ? target : target.root;
  const ignoreRules =
    typeof target === "object" && target.ignoreRules
      ? target.ignoreRules
      : new IgnoreRules(root);

  const mode = opts.mode ?? "unstaged";
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const maxBytes = Math.min(256 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? 64 * 1024)));
  const modeArgs = getDiffModeArgs(mode);

  // A scope inside its own repo (home-rooted workspaces) diffs that repo;
  // without a scope this is the repo containing the workspace root. The
  // inventory must cover the WHOLE resolved repo (pathspec "." at the repo
  // root): rename pairing needs both sides, so a scoped inventory could
  // misread a cross-boundary rename as a clean new file.
  const repoRoot = resolveRepoRoot(scopedDir(root, relPath));
  if (!repoRoot) return notARepo(mode);

  // 1. Full-repo inventory using NUL separation and global rename detection
  const listArgs = [
    "diff",
    "--name-status",
    "-z",
    "--find-renames=1%",
    ...modeArgs,
    "--",
    ".",
  ];
  const listResult = runGit(repoRoot, listArgs);
  if (!listResult.ok) return notARepo(mode);

  const tokens = listResult.stdout.split("\0");
  // Safety/scope checks run on workspace-relative paths so .c2cignore rules
  // and scopes mean the same thing regardless of which repo was resolved;
  // safePaths carry repo-root-relative pathspecs, and the batch diff runs at
  // the repo root so diff text shows the same paths as an unscoped diff.
  const safePaths: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath && newPath) {
        const wsOld = toWsRel(root, repoRoot, oldPath);
        const wsNew = toWsRel(root, repoRoot, newPath);
        if (!wsOld || !wsNew) continue;
        // Layer 1: Security - EITHER side sensitive -> completely unsafe
        const isSafe = !ignoreRules.isSensitive(wsOld) && !ignoreRules.isSensitive(wsNew);
        // Layer 2: Scope - EITHER side in scope -> relevant
        const isRelevant = isPathInScope(wsOld, relPath) || isPathInScope(wsNew, relPath);
        if (isSafe && isRelevant) {
          safePaths.push(toRepoRel(repoRoot, root, wsOld), toRepoRel(repoRoot, root, wsNew));
        }
      }
    } else {
      const filePath = tokens[i++];
      if (filePath) {
        const ws = toWsRel(root, repoRoot, filePath);
        if (!ws) continue;
        const isSafe = !ignoreRules.isSensitive(ws);
        const isRelevant = isPathInScope(ws, relPath);
        if (isSafe && isRelevant) {
          safePaths.push(toRepoRel(repoRoot, root, ws));
        }
      }
    }
  }

  if (safePaths.length === 0) {
    return {
      isRepo: true,
      mode,
      totalBytes: 0,
      offset: 0,
      returnedBytes: 0,
      hasMore: false,
      nextOffset: null,
      diff: "",
    };
  }

  // 2. Fetch diffs for safe paths in bounded batches (path count + argv bytes)
  const batches = chunkSafePaths(safePaths);
  let combinedDiff = "";
  let totalAggregateBytes = 0;
  const MAX_AGGREGATE_DIFF_BYTES = 64 * 1024 * 1024;

  for (const batch of batches) {
    const pathspecs = batch.map((p) => `:(literal)${p}`);
    const diffArgs = [
      "diff",
      "--no-color",
      "--find-renames=1%",
      ...modeArgs,
      "--",
      ...pathspecs,
    ];
    const diffResult = runGit(repoRoot, diffArgs);
    if (!diffResult.ok) {
      // Fail closed on any batch error: never return partial silent success
      return notARepo(mode);
    }
    if (diffResult.stdout) {
      const chunkBytes = Buffer.byteLength(diffResult.stdout, "utf8");
      if (totalAggregateBytes + chunkBytes > MAX_AGGREGATE_DIFF_BYTES) {
        // Fail closed on aggregate cap: do not fake a partial successful diff
        return notARepo(mode);
      }
      combinedDiff += diffResult.stdout;
      totalAggregateBytes += chunkBytes;
    }
  }

  const full = Buffer.from(combinedDiff, "utf8");
  const slice = full.subarray(offset, offset + maxBytes);
  let text = slice.toString("utf8");
  let sliceLen = slice.length;
  // Avoid cutting mid-line when more content follows.
  if (offset + sliceLen < full.length) {
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline > 0) {
      text = text.slice(0, lastNewline + 1);
      sliceLen = Buffer.byteLength(text, "utf8");
    }
  }
  const hasMore = offset + sliceLen < full.length;
  return {
    isRepo: true,
    mode,
    totalBytes: full.length,
    offset,
    returnedBytes: sliceLen,
    hasMore,
    nextOffset: hasMore ? offset + sliceLen : null,
    diff: text,
  };
}
