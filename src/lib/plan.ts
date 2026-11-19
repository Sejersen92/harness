import { existsSync, readFileSync } from "node:fs";
import { taskIdsIn } from "./ids.ts";

/**
 * Whether a plan's acceptance criteria may start (LN1). A plan made from a programme phase says so in its brief,
 * `- From: PROG-n/PHASE-k`, and then every acceptance criterion of its tasks cites the phase criterion it serves,
 * `AC-1 (C3) …`, so the lineage view links story, criterion, test and code by id rather than by wording. A plan not
 * from a programme isn't checked, and neither is a PLAN.md that isn't there (the intake gate speaks for that).
 */
export function citationVerdict(path: string, planId: string): { allowed: boolean; uncited: string[]; detail: string } {
  const allowed = { allowed: true, uncited: [] as string[], detail: "" };
  if (!existsSync(path)) return allowed;
  const lines = readFileSync(path, "utf8").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${planId}\\b(?!\\.)`).test(l));
  if (start < 0) return allowed;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  const body = lines.slice(start + 1, end < 0 ? undefined : end);

  const from = body.find((l) => /^\s*-\s*From:\s*PROG-\d+\/PHASE-\d+/.test(l))?.match(/PROG-\d+\/PHASE-\d+/)?.[0];
  if (!from) return allowed;

  const uncited: string[] = [];
  let task: string | null = null;
  for (const line of body) {
    const heading = line.match(/^###\s+(PLAN-\d+(?:\.\d+)+)\b/);
    if (heading) { task = heading[1] ?? null; continue; }
    const ac = line.match(/^\s+-\s+(AC-\d+)\b\s*(.*)$/);
    if (!ac || !task) continue;
    if (!/^\(\s*C[1-9]\d*(?:\s*,\s*C[1-9]\d*)*\s*\)/.test(ac[2] ?? "")) uncited.push(`${task}/${ac[1]}`);
  }
  if (uncited.length === 0) return allowed;
  return {
    allowed: false,
    uncited,
    detail: `${planId} comes from ${from}, so each acceptance criterion cites the phase criterion it serves, as AC-k (C<n>). These don't: ${uncited.join(", ")}`,
  };
}

/** What the routing log takes from a task's PLAN.md section. */
export interface PlanSection {
  declaredFiles: number;
  dependsOn: string[];
  parallelGroup: string | null;
  criteria: number;
  justifications: Record<string, string>;
}

const DIMENSIONS = ["ambiguity", "blast", "coupling", "novelty", "reversibility", "verification"];

/**
 * The parts of a task's PLAN.md section that the routing log needs. The section starts at
 * "### PLAN-7.2 — title" and runs to the next heading; the bullet format is the orchestrator's
 * template (agents/orchestrator.md). Returns null when the section isn't there.
 */
export function planSection(path: string, taskId: string): PlanSection | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^#{2,4}\\s+${taskId.replace(".", "\\.")}\\b`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,4}\s/.test(l));
  const body = lines.slice(start + 1, end < 0 ? undefined : end);

  const field = (name: string): string => body.find((l) => new RegExp(`^\\s*-\\s*${name}\\s*:`, "i").test(l))?.replace(/^[^:]*:\s*/, "") ?? "";
  const listUnder = (name: string): string[] => {
    const at = body.findIndex((l) => new RegExp(`^\\s*-\\s*${name}\\s*:\\s*$`, "i").test(l));
    if (at < 0) return [];
    const items: string[] = [];
    for (const l of body.slice(at + 1)) {
      if (/^\s{2,}-\s+/.test(l)) items.push(l.replace(/^\s+-\s+/, ""));
      else if (l.trim()) break;
    }
    return items;
  };

  const scope = field("Scope");
  const justifications: Record<string, string> = {};
  for (const item of listUnder("Justifications")) {
    const [name, ...reason] = item.split(":");
    const key = (name ?? "").trim().toLowerCase();
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
