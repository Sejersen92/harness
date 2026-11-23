// The eval's moving parts, shared by harness-eval (which writes the pass marker) and the commit gate
// (which reads it). The marker is the only link between them: an eval passed for this exact staged
// diff, on this HEAD, recently.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256, utcNow } from "./ids.ts";
import type { Marker, Stage } from "./types.ts";

/** One stage's result, as eval.completed records it. */
export interface StageResult {
  name: string;
  status: "pass" | "fail" | "skipped";
  duration_ms: number;
}

export interface StagesOutcome {
  result: "pass" | "fail";
  stages: StageResult[];
  failed: { stage: string; output: string } | null;
  failed_acs: string[];
}

const git = (dir: string, ...args: string[]): Buffer =>
  execFileSync("git", ["-C", dir, ...args], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });

/** sha256 of `git diff --cached --binary`: what the next commit would contain, byte for byte. */
export const stagedDiffSha256 = (dir: string): string => sha256(git(dir, "diff", "--cached", "--binary"));

export const hasStagedChanges = (dir: string): boolean => git(dir, "diff", "--cached", "--name-only").length > 0;

/** The staged files, repository-relative, with forward slashes. */
export const stagedFiles = (dir: string): string[] =>
  git(dir, "diff", "--cached", "--name-only").toString().split("\n").map((l) => l.trim()).filter(Boolean);

export function head(dir: string): string | null {
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
export function unstaged(dir: string): string[] {
  const modified = git(dir, "diff", "--name-only").toString().split("\n").filter(Boolean);
  const untracked = git(dir, "ls-files", "--others", "--exclude-standard").toString().split("\n").filter(Boolean);
  return [...modified.map((f) => `modified: ${f}`), ...untracked.map((f) => `untracked: ${f}`)];
}

// ---- the marker --------------------------------------------------------------------------------

// Where the marker is comes from the repository's layout (config.layout.markerPath): in its home, or
// in .claude/state/ for a repository still set up the old way.

export function readMarker(path: string): Partial<Marker> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<Marker>;
  } catch {
    return null;
  }
}

export function writeMarker(path: string, marker: Marker): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(marker, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}

export const clearMarker = (path: string): void => rmSync(path, { force: true });

// ---- stages ------------------------------------------------------------------------------------

/**
 * Whether a repository-relative path matches a glob: `**` is any run of folders (or none), `*` anything
 * within one folder, `?` one character. The whole path must match; backslashes count as slashes.
 */
export function globMatch(glob: string, path: string): boolean {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        pattern += "(?:.*/)?";
      } else pattern += ".*";
    } else if (c === "*") pattern += "[^/]*";
    else if (c === "?") pattern += "[^/]";
    else pattern += /[.+^${}()|[\]\\]/.test(c) ? "\\" + c : c;
  }
  return new RegExp("^" + pattern + "$").test(path.replace(/\\/g, "/"));
}

/**
 * Whether a stage applies to a commit of these staged files: always when it has no `paths`, otherwise when
 * a staged file matches one of its globs. Only a commit's eval asks; --ci runs every stage.
 */
export const stageApplies = (stage: Stage, files: readonly string[]): boolean =>
  !stage.paths || files.some((file) => stage.paths!.some((glob) => globMatch(glob, file)));

/** Why a stage list can't be run, or null. A stage is { name, run, cwd?, env?, timeout_minutes?, paths? }. */
export function stageProblems(stages: readonly Stage[]): string | null {
  if (!stages.length) return "routing.yaml has no eval.stages, so there is nothing to evaluate";
  const names = new Set<string>();
  for (const [i, stage] of stages.entries()) {
    if (!stage || typeof stage.name !== "string" || !stage.name) return `eval.stages[${i}] has no name`;
    if (typeof stage.run !== "string" || !stage.run.trim()) return `eval.stages[${i}] (${stage.name}) has no run command`;
    if (names.has(stage.name)) return `eval.stages has "${stage.name}" twice`;
    const paths: unknown = stage.paths;
    if (paths !== undefined && (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== "string" || !p.trim())))
      return `eval.stages[${i}] (${stage.name}) has paths that aren't a list of globs`;
    names.add(stage.name);
  }
  return null;
}

/**
 * A copy of `env` without the GIT_* variables a git hook exports (GIT_DIR, GIT_INDEX_FILE,
 * GIT_WORK_TREE, GIT_PREFIX, ...), keeping GIT_CONFIG_*. A stage that inherited them would point its
 * git commands at the hook's repository instead of the one being evaluated.
 */
export function withoutGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_/i.test(k) || /^GIT_CONFIG_/i.test(k)));
}

const AC_ID = /PLAN-\d+(?:\.\d+)+\/AC-\d+/g;

/**
 * Runs the stages in order through the shell, stopping at the first failure: later stages are
 * "skipped", since a build that fails makes its tests meaningless. Each stage's full output goes to
 * <logDir>/<name>.log. Returns the stage results, the failing stage's output, and the AC ids it names.
 */
export function runStages(
  dir: string, stages: readonly Stage[], logDir: string,
  { onStage = () => {}, applies = () => true }: { onStage?: (stage: Stage) => void; applies?: (stage: Stage) => boolean } = {},
): StagesOutcome {
  mkdirSync(logDir, { recursive: true });
  const results: StageResult[] = [];
  let failed: StagesOutcome["failed"] = null;

  for (const stage of stages) {
    // A stage whose paths no staged file matches is skipped, as a stage after a failure is (stageApplies).
    if (failed || !applies(stage)) {
      results.push({ name: stage.name, status: "skipped", duration_ms: 0 });
      continue;
    }
    onStage(stage);
    const started = Date.now();
    const run = spawnSync(stage.run, {
      cwd: resolve(dir, stage.cwd ?? "."),
      env: { ...withoutGitEnv(), ...Object.fromEntries(Object.entries(stage.env ?? {}).map(([k, v]) => [k, String(v)])) },
      shell: true,
      windowsHide: true,
      maxBuffer: 256 << 20,
      timeout: (stage.timeout_minutes ?? 15) * 60_000,
    });
    const output = Buffer.concat([run.stdout ?? Buffer.alloc(0), run.stderr ?? Buffer.alloc(0)]).toString("utf8")
      + (run.error ? `\n${(run.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? `timed out after ${stage.timeout_minutes ?? 15} minutes` : run.error.message}\n` : "");
    writeFileSync(join(logDir, `${stage.name}.log`), output);

    const status: StageResult["status"] = run.status === 0 && !run.error ? "pass" : "fail";
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
export const passMarker = (
  dir: string,
  { diffSha256, taskIds, configSha256, now = new Date() }: { diffSha256: string; taskIds: string[]; configSha256: string; now?: Date },
): Marker => ({
  diff_sha256: diffSha256,
  head: head(dir),
  passed_at: utcNow(now),
  task_ids: taskIds,
  config_sha256: configSha256,
});
