// harness-git-hook pre-commit | commit-msg <file> | post-commit
//
// The Harness's git hooks, for commits made outside Claude Code as well as inside it, run by the
// dispatcher in templates/githooks/harness, which enrolment puts in the repository's home.
//
// - pre-commit: the same check as commit-gate (lib/gate.ts). With no pass for what is staged, it
//   runs harness-eval itself and lets the commit through if that passes (decided 2026-10-07), so a
//   commit by hand needs no separate step. Exit 1 stops the commit.
// - commit-msg: strips AI attribution trailers when routing.yaml's commits.strip_ai_attribution says to
//   (a home's default is no; the old layout's is yes).
// - post-commit: records commit.created, inside Claude Code only (that is where the session id is).
//
// Git runs hooks from the top of the working tree, so that is the repository, whatever
// CLAUDE_PROJECT_DIR says: a `git -C ../other commit` from a session belongs to ../other.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, pluginRoot } from "../lib/config.ts";
import { readMarker } from "../lib/eval.ts";
import { checkMarker, stripAttribution } from "../lib/gate.ts";
import { emitEvent } from "../lib/spool.ts";
import { messageOf } from "../lib/types.ts";

const [hook, ...rest] = process.argv.slice(2);
const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const dir = (() => {
  try {
    return git("rev-parse", "--show-toplevel");
  } catch {
    return process.cwd();
  }
})();
const config = loadConfig(dir);
const say = (line: string): boolean => process.stderr.write(`${line}\n`);

if (hook === "commit-msg") {
  const file = rest[0] ?? "";
  if (config.mode === "off" || !config.stripAiAttribution) process.exit(0);
  try {
    const stripped = stripAttribution(readFileSync(file, "utf8"));
    if (stripped !== null) writeFileSync(file, stripped);
  } catch (error) {
    say(`harness: commit-msg could not read ${file}: ${messageOf(error)}`);
  }
  process.exit(0);
}

if (config.mode === "off") process.exit(0);

if (hook === "pre-commit") {
  const first = checkMarker(dir, config.layout.markerPath, config.markerTtlMinutes);
  if (first.decision === "allow") process.exit(0);

  say(`harness: no eval pass for this commit (${first.detail}), so running harness-eval now.`);
  const run = spawnSync("node", [join(pluginRoot() ?? "", "bin", "harness-eval.mjs")], {
    cwd: dir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const second = run.status === 0 ? checkMarker(dir, config.layout.markerPath, config.markerTtlMinutes) : null;
  if (second?.decision === "allow") process.exit(0);

  say(`harness: commit stopped - ${second ? second.detail : "harness-eval did not pass"}. (git commit --no-verify skips this check.)`);
  process.exit(1);
}

if (hook === "post-commit") {
  if (!process.env.CLAUDE_CODE_SESSION_ID) process.exit(0);
  try {
    const sha = git("rev-parse", "HEAD");
    let files = 0, added = 0, removed = 0;
    for (const line of git("show", "--numstat", "--format=", "HEAD").split("\n").filter(Boolean)) {
      const [a, r] = line.split("\t");
      files++;
      added += Number.parseInt(a ?? "", 10) || 0; // "-" for a binary file
      removed += Number.parseInt(r ?? "", 10) || 0;
    }
    const taskIds = readMarker(config.layout.markerPath)?.task_ids ?? [];
    const onlyTask = taskIds.length === 1 ? taskIds[0] : undefined;
    emitEvent(config, "commit.created", onlyTask ? { task_id: onlyTask, plan_id: onlyTask.replace(/\..*$/, "") } : {},
      { commit_sha: sha, task_ids: taskIds, files_changed: files, lines_added: added, lines_removed: removed });
  } catch (error) {
    say(`harness: post-commit could not record the commit: ${messageOf(error)}`);
  }
  process.exit(0);
}

say(`harness-git-hook: unknown hook "${hook ?? ""}"`);
process.exit(0);
