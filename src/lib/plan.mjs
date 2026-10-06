import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { taskIdsIn } from "./ids.mjs";

const DIMENSIONS = ["ambiguity", "blast", "coupling", "novelty", "reversibility", "verification"];

/**
 * The parts of a task's PLAN.md section that the routing log needs. The section starts at
 * "### PLAN-7.2 — title" and runs to the next heading; the bullet format is the orchestrator's
 * template (agents/orchestrator.md). Returns null when the section isn't there.
 */
export function planSection(dir, taskId) {
  const path = join(dir, "PLAN.md");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^#{2,4}\\s+${taskId.replace(".", "\\.")}\\b`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,4}\s/.test(l));
  const body = lines.slice(start + 1, end < 0 ? undefined : end);

  const field = (name) => body.find((l) => new RegExp(`^\\s*-\\s*${name}\\s*:`, "i").test(l))?.replace(/^[^:]*:\s*/, "") ?? "";
  const listUnder = (name) => {
    const at = body.findIndex((l) => new RegExp(`^\\s*-\\s*${name}\\s*:\\s*$`, "i").test(l));
    if (at < 0) return [];
    const items = [];
    for (const l of body.slice(at + 1)) {
      if (/^\s{2,}-\s+/.test(l)) items.push(l.replace(/^\s+-\s+/, ""));
      else if (l.trim()) break;
    }
    return items;
  };

  const scope = field("Scope");
  const justifications = {};
  for (const item of listUnder("Justifications")) {
    const [name, ...reason] = item.split(":");
    const key = name.trim().toLowerCase();
    if (DIMENSIONS.includes(key) && reason.join(":").trim()) justifications[key] = reason.join(":").trim().slice(0, 200);
  }
  return {
    declaredFiles: scope && !/^none$/i.test(scope.trim()) ? scope.split(",").filter((s) => s.trim()).length : 0,
    dependsOn: taskIdsIn(field("Depends on")),
    parallelGroup: field("Parallel group").trim() || null,
    criteria: listUnder("Acceptance criteria").filter((l) => /^AC-\d+/.test(l)).length,
    justifications,
  };
}
