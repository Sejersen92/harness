// H10: the security review of a T4 task. harness:security-reviewer writes one file per review round
// into the reviews folder (the home's, or .harness/ in the old layout), and harness-review-block
// turns a plan's or a series' files into the section a pull request carries.
//
// The file is the record, so its shape is fixed (agents/security-reviewer.md):
//
//   # Security review: PLAN-n.m, round k
//   ## Findings
//   | Severity | Where | Finding | Fix |
//   |---|---|---|---|
//   | medium | src/a.ts:12 | ... | ... |
//   ## Checked and sound
//   - ...
//
// A review with no findings keeps the table header and has no rows.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type Severity = "high" | "medium" | "low";
export const SEVERITIES: readonly Severity[] = ["high", "medium", "low"];

export interface Finding {
  severity: Severity;
  where: string;
  finding: string;
  fix: string;
}

export interface Review {
  task: string;
  round: number;
  findings: Finding[];
  sound: string[];
}

/** The reviews folder: next to the events, in the home or in the old layout's .harness/. */
export const reviewsDir = (metadataDir: string): string => join(metadataDir, "reviews");

/** The file for one round: round 1 is PLAN-n.m.security.md, later rounds add .round-k. */
export const reviewFileName = (task: string, round: number): string =>
  round <= 1 ? `${task}.security.md` : `${task}.security.round-${round}.md`;

const FILE = /^(PLAN-\d+(?:\.\d+)+)\.security(?:\.round-(\d+))?\.md$/;

/** Whether a path is inside the reviews folder: the only place the reviewer may write. */
export function isReviewPath(file: unknown, metadataDir: string): boolean {
  if (!file) return false;
  const dir = reviewsDir(metadataDir);
  const rel = relative(dir, resolve(dir, String(file))).replace(/\\/g, "/");
  return Boolean(rel) && !rel.startsWith("../") && !rel.includes("/") && !isAbsolute(rel) && FILE.test(rel);
}

const cells = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

/** Reads one review file. Rows whose severity isn't high, medium or low are kept as high: an unreadable severity is never quietly a low. */
export function parseReview(task: string, round: number, text: string): Review {
  const findings: Finding[] = [];
  const sound: string[] = [];
  let section: "findings" | "sound" | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^##\s+findings\b/i.test(line)) { section = "findings"; continue; }
    if (/^##\s+checked and sound\b/i.test(line)) { section = "sound"; continue; }
    if (/^#/.test(line)) { section = null; continue; }
    if (section === "findings" && line.startsWith("|")) {
      const [severity = "", where = "", finding = "", fix = ""] = cells(line);
      if (/^severity$/i.test(severity) || /^:?-{3,}:?$/.test(severity)) continue;
      const s = severity.toLowerCase();
      findings.push({ severity: (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : "high", where, finding, fix });
    }
    if (section === "sound" && /^[-*]\s+/.test(line)) sound.push(line.replace(/^[-*]\s+/, ""));
  }
  return { task, round, findings, sound };
}

/** Every review in the folder for the given plans, by task and round. */
export function readReviews(metadataDir: string, plans: readonly string[]): Review[] {
  const dir = reviewsDir(metadataDir);
  if (!existsSync(dir)) return [];
  const wanted = new Set(plans);
  return readdirSync(dir)
    .map((name) => ({ name, match: FILE.exec(name) }))
    .filter((f): f is { name: string; match: RegExpExecArray } => Boolean(f.match) && wanted.has(f.match![1]!.split(".")[0]!))
    .map(({ name, match }) => parseReview(match[1]!, Number(match[2] ?? 1), readFileSync(join(dir, name), "utf8")))
    .sort((a, b) => compareTasks(a.task, b.task) || a.round - b.round);
}

const compareTasks = (a: string, b: string): number => {
  const pa = a.replace("PLAN-", "").split(".").map(Number);
  const pb = b.replace("PLAN-", "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return d;
  }
  return 0;
};

/** The counts a security.reviewed event carries. */
export const counts = (review: Review): Record<Severity, number> => ({
  high: review.findings.filter((f) => f.severity === "high").length,
  medium: review.findings.filter((f) => f.severity === "medium").length,
  low: review.findings.filter((f) => f.severity === "low").length,
});

const escape = (text: string): string => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/**
 * The pull request's security section for some plans (H10). Per task, the last round is what was
 * committed: its findings are open. A high or medium finding of an earlier round is shown as fixed in
 * the round after it, because the dispatcher commits only when the last round has neither.
 * It ends in one unticked box: ticking it is a person's record that the review was read and accepted.
 */
export function reviewBlock(label: string, reviews: readonly Review[]): string {
  const out: string[] = ["## Security review", ""];
  const tasks = [...new Set(reviews.map((r) => r.task))];
  if (!tasks.length) {
    out.push(`No task in ${label} was T4, so no task needed a security review.`, "");
    return out.join("\n");
  }

  const rows: string[] = [];
  const sound: string[] = [];
  for (const task of tasks) {
    const rounds = reviews.filter((r) => r.task === task);
    const last = rounds[rounds.length - 1]!;
    for (const earlier of rounds.slice(0, -1)) {
      for (const f of earlier.findings.filter((f) => f.severity !== "low")) {
        rows.push(`| ${task} | ${f.severity} | ${escape(f.where)} | ${escape(f.finding)} | fixed in round ${earlier.round + 1} |`);
      }
    }
    for (const f of last.findings) {
      rows.push(`| ${task} | ${f.severity} | ${escape(f.where)} | ${escape(f.finding)} | ${f.severity === "low" ? "open" : "open (not committed by the dispatcher)"} |`);
    }
    for (const s of last.sound) sound.push(`- ${task}: ${s}`);
  }

  const reviewed = tasks.length === 1 ? "1 task" : `${tasks.length} tasks`;
  out.push(`${reviewed} in ${label} had a read-only security review before commit (harness:security-reviewer).`, "");
  if (rows.length) {
    out.push("| Task | Severity | Where | Finding | Status |", "|---|---|---|---|---|", ...rows, "");
  } else {
    out.push("No findings.", "");
  }
  if (sound.length) out.push("**Checked and found sound:**", "", ...sound, "");
  out.push("- [ ] Security review read and accepted by a person", "");
  return out.join("\n");
}
