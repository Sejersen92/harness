// harness-eval [--task PLAN-7.2 ...] [--ci]
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
// Exit 0 pass, 1 fail, 2 refused (nothing to evaluate, or not a state worth evaluating).
import { join, relative } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import {
  clearMarker, hasStagedChanges, markerPath, passMarker, runStages, stagedDiffSha256, stageProblems, unstaged, writeMarker,
} from "../lib/eval.mjs";
import { emitEvent } from "../lib/spool.mjs";

const args = process.argv.slice(2);
const ci = args.includes("--ci");
const taskIds = [...new Set(args.flatMap((a, i) => (args[i - 1] === "--task" ? a.split(",") : [])).map((t) => t.trim()).filter(Boolean))];

const say = (line = "") => process.stdout.write(line + "\n");
const refuse = (why, details = []) => {
  say(`harness-eval: refused - ${why}`);
  for (const d of details.slice(0, 20)) say(`  ${d}`);
  if (details.length > 20) say(`  ... and ${details.length - 20} more`);
  process.exit(2);
};

const config = loadConfig();
if (config.mode === "off") {
  say(`harness-eval: the Harness is off here (${config.reason ?? "mode: off"}), so no eval is needed`);
  process.exit(0);
}

const problem = stageProblems(config.stages);
if (problem) refuse(problem);

if (!ci) {
  if (!hasStagedChanges(config.dir)) refuse("nothing is staged. Stage the change to commit (git add), then run harness-eval");
  const loose = unstaged(config.dir);
  if (loose.length) refuse("the working tree has changes that are not staged. Stage them or set them aside, so the eval tests exactly what will be committed:", loose);
  // A run that starts revokes the last pass: an eval that fails now must not leave an older pass behind.
  clearMarker(config.dir);
}

const diffSha256 = stagedDiffSha256(config.dir);
const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
// Inside Claude Code the run is recorded. A run by hand or in CI has no session to belong to, and is
// not counted as a failed write either: it is simply not part of a task.
const emit = (type, data) => {
  if (sessionId) emitEvent(config, type, taskIds.length === 1 ? { task_id: taskIds[0], plan_id: taskIds[0].replace(/\..*$/, "") } : {}, data);
};

say(`harness-eval: ${config.stages.length} stage(s) for ${ci ? "the checkout (ci)" : `staged diff ${diffSha256.slice(0, 12)}`}${taskIds.length ? ` (${taskIds.join(", ")})` : ""}`);
emit("eval.started", { task_ids: taskIds, diff_sha256: diffSha256, ci });

const logDir = join(config.metadataDir, "state", "eval");
const outcome = runStages(config.dir, config.stages, logDir, {
  // A progress line that the result overwrites only works on a terminal; in a log it is noise.
  onStage: (stage) => process.stdout.isTTY && process.stdout.write(`  ....  ${stage.name}\r`),
});

for (const stage of outcome.stages) {
  say(`  ${stage.status.padEnd(7)} ${stage.name.padEnd(24)} ${stage.status === "skipped" ? "" : `${(stage.duration_ms / 1000).toFixed(1)}s`}`);
}

emit("eval.completed", {
  result: outcome.result,
  stages: outcome.stages,
  failed_acs: outcome.failed_acs,
  task_ids: taskIds,
  diff_sha256: diffSha256,
  ...(outcome.failed_acs.length ? { attribution: "task" } : {}),
});

if (outcome.failed) {
  const tail = outcome.failed.output.trimEnd().split(/\r?\n/).slice(-60);
  say();
  say(`--- ${outcome.failed.stage}: last ${tail.length} lines (full log: ${relative(config.dir, join(logDir, `${outcome.failed.stage}.log`))}) ---`);
  for (const line of tail) say(line);
  say("---");
  if (outcome.failed_acs.length) say(`failing acceptance criteria: ${outcome.failed_acs.join(", ")}`);
  say(`harness-eval: FAIL at ${outcome.failed.stage}`);
  process.exit(1);
}

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

writeMarker(config.dir, passMarker(config.dir, { diffSha256, taskIds, configSha256: config.config_sha256 }));
say(`harness-eval: PASS - ${relative(config.dir, markerPath(config.dir))} written; a commit of this staged diff is allowed for ${config.markerTtlMinutes} minutes`);
process.exit(0);
