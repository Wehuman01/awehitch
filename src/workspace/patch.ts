import fs from "node:fs";
import path from "node:path";
import { Workspace, WorkspaceError } from "./manager.js";
import { writeFileAtomic } from "../fs/atomic.js";

/**
 * Structured multi-file patches — the only way ChatGPT can change files
 * (chatgptMode "write" and up). Staged, baseline-checked, atomic across
 * files, with rollback: every edit is validated against the current content
 * before anything is written, and a mid-apply failure restores every file
 * already touched to its previous state.
 */
export type PatchAction = "create" | "update" | "delete";

export interface PatchEdit {
  path: string;
  action: PatchAction;
  /** Text the current file must contain exactly once. Required for update. */
  oldText?: string;
  /** Replacement (or new-file) text. Empty string deletes oldText from the file. */
  newText?: string;
}

export interface ApplyPatchResult {
  applied: { path: string; action: PatchAction; bytesWritten: number }[];
}

const MAX_EDITS = 20;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

interface StagedEdit {
  rel: string;
  abs: string;
  action: PatchAction;
  /** Full new file content (create/update) — absent for delete. */
  newContent: string | null;
  /** Previous state, held for rollback. */
  existedBefore: boolean;
  previousContent: string | null;
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

export async function applyWorkspacePatch(workspace: Workspace, edits: PatchEdit[]): Promise<ApplyPatchResult> {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new WorkspaceError("INVALID_PATCH", "A patch needs at least one edit.");
  }
  if (edits.length > MAX_EDITS) {
    throw new WorkspaceError("TOO_MANY_EDITS", `A patch may contain at most ${MAX_EDITS} edits; got ${edits.length}.`);
  }

  // Phase 1: validate every edit against current content and stage new states.
  const staged: StagedEdit[] = [];
  let totalBytes = 0;
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") {
      throw new WorkspaceError("INVALID_PATCH", "Each edit must be an object with path and action.");
    }
    // resolve() throws PATH_OUTSIDE_WORKSPACE / ACCESS_DENIED_SENSITIVE_FILE —
    // the sensitive-file policy covers writes too, not just reads.
    const { abs, rel } = workspace.resolve(edit.path);
    const newText = edit.newText ?? "";
    if (edit.action !== "delete" && byteLength(newText) > MAX_TEXT_BYTES) {
      throw new WorkspaceError("PATCH_TOO_LARGE", `Edit for '${rel}' exceeds ${MAX_TEXT_BYTES} bytes.`);
    }
    totalBytes += edit.action === "delete" ? 0 : byteLength(newText);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new WorkspaceError("PATCH_TOO_LARGE", `Patch exceeds ${MAX_TOTAL_BYTES} bytes in total.`);
    }

    if (staged.some((s) => s.rel === rel)) {
      throw new WorkspaceError("INVALID_PATCH", `Patch edits '${rel}' more than once.`);
    }

    if (edit.action === "create") {
      if (fs.existsSync(abs)) {
        throw new WorkspaceError("FILE_EXISTS", `Cannot create '${rel}': the file already exists.`);
      }
      staged.push({ rel, abs, action: "create", newContent: newText, existedBefore: false, previousContent: null });
      continue;
    }

    let current: string;
    try {
      current = await fs.promises.readFile(abs, "utf8");
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${rel}`);
    }
    if (edit.action === "delete") {
      staged.push({ rel, abs, action: "delete", newContent: null, existedBefore: true, previousContent: current });
      continue;
    }
    // update: baseline check — oldText must match exactly once.
    const oldText = edit.oldText ?? "";
    if (oldText === "") {
      throw new WorkspaceError("INVALID_PATCH", `Update of '${rel}' needs oldText (the text being replaced).`);
    }
    const first = current.indexOf(oldText);
    if (first === -1) {
      throw new WorkspaceError(
        "BASELINE_MISMATCH",
        `oldText for '${rel}' does not match the current file content. Read the file again and retry with fresh oldText.`
      );
    }
    if (current.indexOf(oldText, first + 1) !== -1) {
      throw new WorkspaceError(
        "BASELINE_MISMATCH",
        `oldText for '${rel}' matches more than once. Include more surrounding lines so it is unambiguous.`
      );
    }
    const newContent = current.slice(0, first) + newText + current.slice(first + oldText.length);
    staged.push({ rel, abs, action: "update", newContent, existedBefore: true, previousContent: current });
  }

  // Phase 2: apply atomically; roll back everything on the first failure.
  const touched: StagedEdit[] = [];
  try {
    for (const edit of staged) {
      if (edit.action === "delete") {
        await fs.promises.unlink(edit.abs);
      } else {
        await fs.promises.mkdir(path.dirname(edit.abs), { recursive: true });
        writeFileAtomic(edit.abs, edit.newContent ?? "");
      }
      touched.push(edit);
    }
  } catch (error) {
    for (const edit of touched.reverse()) {
      try {
        if (!edit.existedBefore) {
          fs.rmSync(edit.abs, { force: true });
        } else {
          writeFileAtomic(edit.abs, edit.previousContent ?? "");
        }
      } catch {
        // rollback itself failed — surface the original write error; the
        // pre-write baseline is gone, which the error code says honestly.
      }
    }
    throw new WorkspaceError(
      "WRITE_FAILED",
      `Patch failed mid-apply and was rolled back: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    applied: staged.map((edit) => ({
      path: edit.rel,
      action: edit.action,
      bytesWritten: edit.action === "delete" ? 0 : byteLength(edit.newContent ?? ""),
    })),
  };
}
