// The eval's moving parts, shared by harness-eval (which writes the pass marker) and the commit gate
// (which reads it). The marker is the only link between them: an eval passed for this exact staged
// diff, on this HEAD, recently.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256, utcNow } from "./ids.mjs";

const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });

/** sha256 of `git diff --cached --binary`: what the next commit would contain, byte for byte. */
export const stagedDiffSha256 = (dir) => sha256(git(dir, "diff", "--cached", "--binary"));

export const hasStagedChanges = (dir) => git(dir, "diff", "--cached", "--name-only").length > 0;

export function head(dir) {
  try {
    return git(dir, "rev-parse", "HEAD").toString().trim();
  } catch {
    return null; // a repository with no commits yet
  }
}

/**
 * What is on disk but not staged: tracked files with unstaged edits, and untracked files git would
 * not ignore. The stages run on the working tree, so anything listed here would be built and tested
 * without being part of the commit the marker vouches for.
 */
export function unstaged(dir) {
  const modified = git(dir, "diff", "--name-only").toString().split("\n").filter(Boolean);
  const untracked = git(dir, "ls-files", "--others", "--exclude-standard").toString().split("\n").filter(Boolean);
  return [...modified.map((f) => `modified: ${f}`), ...untracked.map((f) => `untracked: ${f}`)];
}

// ---- the marker --------------------------------------------------------------------------------

export const markerPath = (dir) => join(dir, ".claude", "state", "eval-pass.json");

export function readMarker(dir) {
  try {
    return JSON.parse(readFileSync(markerPath(dir), "utf8"));
  } catch {
    return null;
  }
}

export function writeMarker(dir, marker) {
  const path = markerPath(dir);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(marker, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}

export const clearMarker = (dir) => rmSync(markerPath(dir), { force: true });

// ---- stages ------------------------------------------------------------------------------------

/** Why a stage list can't be run, or null. A stage is { name, run, cwd?, env?, timeout_minutes? }. */
export function stageProblems(stages) {
  if (!stages.length) return "routing.yaml has no eval.stages, so there is nothing to evaluate";
  const names = new Set();
  for (const [i, stage] of stages.entries()) {
    if (!stage || typeof stage.name !== "string" || !stage.name) return `eval.stages[${i}] has no name`;
    if (typeof stage.run !== "string" || !stage.run.trim()) return `eval.stages[${i}] (${stage.name}) has no run command`;
    if (names.has(stage.name)) return `eval.stages has "${stage.name}" twice`;
    names.add(stage.name);
  }
  return null;
}

const AC_ID = /PLAN-\d+(?:\.\d+)+\/AC-\d+/g;

/**
 * Runs the stages in order through the shell, stopping at the first failure: later stages are
 * "skipped", since a build that fails makes its tests meaningless. Each stage's full output goes to
 * <logDir>/<name>.log. Returns the stage results, the failing stage's output, and the AC ids it names.
 */
export function runStages(dir, stages, logDir, { onStage = () => {} } = {}) {
  mkdirSync(logDir, { recursive: true });
  const results = [];
  let failed = null;

  for (const stage of stages) {
    if (failed) {
      results.push({ name: stage.name, status: "skipped", duration_ms: 0 });
      continue;
    }
    onStage(stage);
    const started = Date.now();
    const run = spawnSync(stage.run, {
      cwd: resolve(dir, stage.cwd ?? "."),
      env: { ...process.env, ...Object.fromEntries(Object.entries(stage.env ?? {}).map(([k, v]) => [k, String(v)])) },
      shell: true,
      windowsHide: true,
      maxBuffer: 256 << 20,
      timeout: (stage.timeout_minutes ?? 15) * 60_000,
    });
    const output = Buffer.concat([run.stdout ?? Buffer.alloc(0), run.stderr ?? Buffer.alloc(0)]).toString("utf8")
      + (run.error ? `\n${run.error.code === "ETIMEDOUT" ? `timed out after ${stage.timeout_minutes ?? 15} minutes` : run.error.message}\n` : "");
    writeFileSync(join(logDir, `${stage.name}.log`), output);

    const status = run.status === 0 && !run.error ? "pass" : "fail";
    results.push({ name: stage.name, status, duration_ms: Date.now() - started });
    if (status === "fail") failed = { stage: stage.name, output };
  }

  return {
    result: failed ? "fail" : "pass",
    stages: results,
    failed,
    failed_acs: failed ? [...new Set(failed.output.match(AC_ID) ?? [])] : [],
  };
}

/** The marker a passing run leaves, for the gate to check against. */
export const passMarker = (dir, { diffSha256, taskIds, configSha256, now = new Date() }) => ({
  diff_sha256: diffSha256,
  head: head(dir),
  passed_at: utcNow(now),
  task_ids: taskIds,
  config_sha256: configSha256,
});
