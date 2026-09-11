import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one instruction asset: skill/SKILL.md.template, filled per harness.
 * Adapters share it so the orchestration semantics stay identical across
 * codex / opencode / zcode — only the harness name differs.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(here, "..", "..", "skill", "SKILL.md.template");

export function renderSkill(opts: { harness: string; connectorName: string }): string {
  const template = fs.readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{HARNESS}}", opts.harness)
    .replaceAll("{{CONNECTOR_NAME}}", opts.connectorName);
}
