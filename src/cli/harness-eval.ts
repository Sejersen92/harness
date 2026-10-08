// harness-eval [--task PLAN-7.2 ...] [--ci [--config <path>]]
//
// Runs routing.yaml's eval.stages against what is staged, and on a pass writes the marker the commit
// gate checks: .claude/state/eval-pass.json, holding sha256(git diff --cached --binary) and HEAD. It is
// the only writer of that marker.
//
// It evaluates exactly what will be committed, so it refuses while anything is unstaged: the stages
// run on the working tree, and an unstaged edit or untracked file would be built and tested without
// being part of the commit the marker vouches for. --ci evaluates the checkout as it is, and writes
// no marker.
//
// --config <path> takes the stages from that file (eval.stages) instead of routing.yaml, for a CI runner,
// which has no home (C1). It only goes with --ci, since a marker belongs to a home.
//
// Exit 0 pass, 1 fail, 2 refused (nothing to evaluate, or not a state worth evaluating).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readCiStages } from "../lib/ci.ts";
import { loadConfig, projectDir } from "../lib/config.ts";
import {
  clearMarker, hasStagedChanges, passMarker, runStages, stagedDiffSha256, stageProblems, unstaged, writeMarker,
} from "../lib/eval.ts";
import { emitEvent } from "../lib/spool.ts";
import type { Stage } from "../lib/types.ts";

const args = process.argv.slice(2);
const ci = args.includes("--ci");
const taskIds = [...new Set(args.flatMap((a, i) => (args[i - 1] === "--task" ? a.split(",") : [])).map((t) => t.trim()).filter(Boolean))];

const say = (line: string = ""): boolean => process.stdout.write(line + "\n");
const refuse = (why: string, details: string[] = []): never => {
  say(`harness-eval: refused - ${why}`);
  for (const d of details.slice(0, 20)) say(`  ${d}`);
  if (details.length > 20) say(`  ... and ${details.length - 20} more`);
  return process.exit(2);
};

const configAt = args.indexOf("--config");
if (configAt >= 0) {
  const path = args[configAt + 1];
  if (!ci) refuse("--config goes only with --ci: outside CI the stages come from routing.yaml, and a pass marker belongs to a home");
  if (!path || path.startsWith("-")) refuse("--config needs the path of a file holding eval.stages, such as .github/harness-eval.yml");
  const dir = projectDir();
  const read = readCiStages(resolve(dir, path!));
  if ("problem" in read) refuse(read.problem);
  else {
    const problem = stageProblems(read.stages);
    if (problem) refuse(problem.replace("routing.yaml", path!));
    say(`harness-eval: ${read.stages.length} stage(s) for the checkout (ci, stages from ${path})`);
    // No home on a runner, so the stage logs go to a temporary folder; a failure's last lines are printed.
    const logDir = mkdtempSync(join(tmpdir(), "harness-eval-"));
    const failed = report(runStages(dir, read.stages, logDir, { onStage: progress }), logDir, (p) => p);
    if (failed) process.exit(1);
    say("harness-eval: PASS (ci, no marker written)");
    process.exit(0);
  }
}

const config = loadConfig();
if (config.mode === "off") {
  say(`harness-eval: the Harness is off here (${config.reason ?? "mode: off"}), so no eval is needed`);
  process.exit(0);
}

/** A path as a person reads it: relative inside the repository, whole when it is in the repository's home. */
const shown = (path: string): string => {
  const inside = relative(config.dir, path);
  return inside.startsWith("..") || isAbsolute(inside) ? path : inside;
};

const problem = stageProblems(config.stages);
if (problem) refuse(problem);

if (!ci) {
  if (!hasStagedChanges(config.dir)) refuse("nothing is staged. Stage the change to commit (git add), then run harness-eval");
  const loose = unstaged(config.dir);
  if (loose.length) refuse("the working tree has changes that are not staged. Stage them or set them aside, so the eval tests exactly what will be committed:", loose);
  // A run that starts revokes the last pass: an eval that fails now must not leave an older pass behind.
  clearMarker(config.layout.markerPath);
}

const diffSha256 = stagedDiffSha256(config.dir);
const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
// Inside Claude Code the run is recorded. A run by hand or in CI has no session to belong to, and is
// not counted as a failed write either: it is simply not part of a task.
const onlyTask = taskIds.length === 1 ? taskIds[0] : undefined;
const emit = (type: string, data: Record<string, unknown>): void => {
  if (sessionId) emitEvent(config, type, onlyTask ? { task_id: onlyTask, plan_id: onlyTask.replace(/\..*$/, "") } : {}, data);
};

say(`harness-eval: ${config.stages.length} stage(s) for ${ci ? "the checkout (ci)" : `staged diff ${diffSha256.slice(0, 12)}`}${taskIds.length ? ` (${taskIds.join(", ")})` : ""}`);
emit("eval.started", { task_ids: taskIds, diff_sha256: diffSha256, ci });

const logDir = join(config.metadataDir, "state", "eval");
const outcome = runStages(config.dir, config.stages, logDir, { onStage: progress });

emit("eval.completed", {
  result: outcome.result,
  stages: outcome.stages,
  failed_acs: outcome.failed_acs,
  task_ids: taskIds,
  diff_sha256: diffSha256,
  ...(outcome.failed_acs.length ? { attribution: "task" } : {}),
});

if (report(outcome, logDir, shown)) process.exit(1);

if (ci) {
  say("harness-eval: PASS (ci, no marker written)");
  process.exit(0);
}

// The stages ran on the working tree. If something changed what is staged meanwhile (a formatter, a
// generated file, a second hand), the pass is for a diff that no longer exists.
if (stagedDiffSha256(config.dir) !== diffSha256 || unstaged(config.dir).length) {
  say("harness-eval: FAIL - the staged diff or the working tree changed while the eval ran, so this pass would vouch for something else. Run it again.");
  process.exit(1);
}

writeMarker(config.layout.markerPath, passMarker(config.dir, { diffSha256, taskIds, configSha256: config.config_sha256 }));
say(`harness-eval: PASS - ${shown(config.layout.markerPath)} written; a commit of this staged diff is allowed for ${config.markerTtlMinutes} minutes`);
process.exit(0);

/** A progress line that the result overwrites. It only works on a terminal; in a log it is noise. */
function progress(stage: Stage): void {
  if (process.stdout.isTTY) process.stdout.write(`  ....  ${stage.name}\r`);
}

/** Prints each stage's result and, on a failure, its last lines. Returns whether a stage failed. */
function report(outcome: ReturnType<typeof runStages>, logDir: string, shown: (path: string) => string): boolean {
  for (const stage of outcome.stages) {
    say(`  ${stage.status.padEnd(7)} ${stage.name.padEnd(24)} ${stage.status === "skipped" ? "" : `${(stage.duration_ms / 1000).toFixed(1)}s`}`);
  }
  if (!outcome.failed) return false;
  const tail = outcome.failed.output.trimEnd().split(/\r?\n/).slice(-60);
  say();
  say(`--- ${outcome.failed.stage}: last ${tail.length} lines (full log: ${shown(join(logDir, `${outcome.failed.stage}.log`))}) ---`);
  for (const line of tail) say(line);
  say("---");
  if (outcome.failed_acs.length) say(`failing acceptance criteria: ${outcome.failed_acs.join(", ")}`);
  say(`harness-eval: FAIL at ${outcome.failed.stage}`);
  return true;
}
