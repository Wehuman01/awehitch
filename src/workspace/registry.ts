import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { Workspace } from "./manager.js";

/**
 * Machine workspace registry: the list of directory roots the ONE bridge
 * serves. v0.2.6 replaced "one bridge per workspace, last up wins" with a
 * single machine-scoped bridge; `up -w <root>` adds the root here and every
 * registered root is readable through the ChatGPT connector.
 */

export interface WorkspaceRegistry {
  roots: string[];
  savedAt: string;
}

export function registryFile(): string {
  return path.join(getStateDir(), "workspaces.json");
}

export function readRegistryRoots(): string[] {
  const data = readJsonIfExists<WorkspaceRegistry>(registryFile());
  if (!data || !Array.isArray(data.roots)) return [];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const root of data.roots) {
    if (typeof root !== "string") continue;
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

/**
 * Load the registry as Workspace objects. Roots whose directory vanished are
 * pruned from the file (honesty over nostalgia: a missing root cannot be
 * served), so the persisted list stays a list of servable workspaces.
 */
export function loadRegisteredWorkspaces(): Workspace[] {
  const roots = readRegistryRoots();
  const workspaces: Workspace[] = [];
  const kept: string[] = [];
  for (const root of roots) {
    try {
      workspaces.push(new Workspace(root));
      kept.push(root);
    } catch {
      // Directory is gone: drop it from the registry on next write.
    }
  }
  if (kept.length !== roots.length) writeRegistry(kept);
  workspaces.sort((a, b) => a.name.localeCompare(b.name));
  return workspaces;
}

export function writeRegistry(roots: string[]): void {
  writeSecureJson(registryFile(), { roots, savedAt: new Date().toISOString() } satisfies WorkspaceRegistry);
}

/** Add a root (must be an existing directory). Returns true when newly added. */
export function addWorkspaceRoot(rootInput: string): { root: string; added: boolean } {
  const workspace = new Workspace(rootInput); // throws when the root is invalid
  const roots = readRegistryRoots();
  const already = roots.some((candidate) => candidate.toLowerCase() === workspace.root.toLowerCase());
  if (!already) {
    roots.push(workspace.root);
    writeRegistry(roots);
  }
  return { root: workspace.root, added: !already };
}

export function isWorkspaceRegistered(rootInput: string): boolean {
  let root: string;
  try {
    root = new Workspace(rootInput).root;
  } catch {
    return false;
  }
  return readRegistryRoots().some((candidate) => candidate.toLowerCase() === root.toLowerCase());
}

/** Only used by tests and `status` display; the registry is the source of truth. */
export function registryExists(): boolean {
  return fs.existsSync(registryFile());
}
