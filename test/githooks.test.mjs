// The git hooks, end to end: real `git commit`s in throwaway repositories wired up the way a
// repository is with templates/githooks and core.hooksPath, finding the plugin through plugin.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAttribution } from "../src/lib/gate.mjs";
import { describe, root, validators } from "./validators.mjs";

const SESSION = "11111111-2222-4333-8444-555555555555";
const PASS = `node -e "process.exit(0)"`;
const FAIL = `node -e "process.exit(1)"`;

function makeRepo({ stage = PASS, plugin = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-githooks-"));
  const home = join(dir, ".harness-home");
  const env = {
    ...process.env, HARNESS_HOME: home,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_PROJECT_DIR;
  const git = (args, extra = {}, input = undefined) =>
    spawnSync("git", ["-C", dir, "-c", "core.autocrlf=false", ...args], { env: { ...env, ...extra }, input, encoding: "utf8" });

  git(["init", "-q"]);
  writeFileSync(join(dir, ".gitignore"), ".harness/\n.harness-home/\n.claude/state/\n");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  writeFileSync(join(dir, "routing.yaml"), `version: 1\nmode: observe\neval:\n  stages:\n    - { name: build, run: '${stage}' }\n`);
  // The wrappers are committed with the repository, as they are in a real one.
  mkdirSync(join(dir, ".githooks"));
  for (const name of ["harness", "pre-commit", "commit-msg", "post-commit"]) {
    copyFileSync(join(root, "templates", "githooks", name), join(dir, ".githooks", name));
    chmodSync(join(dir, ".githooks", name), 0o755);
  }
  assert.equal(git(["add", "-A"]).status, 0);
  assert.equal(git(["commit", "-q", "-m", "init"]).status, 0); // hooks are not switched on yet
  git(["config", "core.hooksPath", ".githooks"]);
  if (plugin) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "plugin.json"), JSON.stringify({ root, version: "test" }));
  }
  return { dir, git };
}

const change = ({ dir, git }, text = "two\n") => {
  writeFileSync(join(dir, "tracked.txt"), text);
  git(["add", "tracked.txt"]);
};

const head = ({ git }) => git(["rev-parse", "HEAD"]).stdout.trim();

test("a commit by hand with no pass runs the eval itself, and goes through when it passes", () => {
  const repo = makeRepo();
  change(repo);
  const before = head(repo);

  const result = repo.git(["commit", "-m", "by hand"]);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /running harness-eval now/);
  assert.notEqual(head(repo), before);
});

test("a failing eval stops the commit", () => {
  const repo = makeRepo({ stage: FAIL });
  change(repo);
  const before = head(repo);

  const result = repo.git(["commit", "-m", "by hand"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /commit stopped/);
  assert.equal(head(repo), before);
});

test("unstaged edits stop the commit, since the eval would test what isn't committed", () => {
  const repo = makeRepo();
  writeFileSync(join(repo.dir, "other.txt"), "x\n");
  repo.git(["add", "other.txt"]);
  writeFileSync(join(repo.dir, "tracked.txt"), "not staged\n");
  const before = head(repo);

  const result = repo.git(["commit", "-m", "partial"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /not staged/);
  assert.equal(head(repo), before);
});

test("commit -a is evaluated on everything it takes", () => {
  const repo = makeRepo();
  writeFileSync(join(repo.dir, "tracked.txt"), "changed, not staged\n");

  const result = repo.git(["commit", "-a", "-m", "all"]);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(repo.git(["show", "HEAD:tracked.txt"]).stdout, "changed, not staged\n");
});

test("a fresh pass for exactly this diff lets the commit through without running the eval again", () => {
  const repo = makeRepo();
  change(repo);
  const evaluated = spawnSync("node", [join(root, "bin", "harness-eval.mjs")], { cwd: repo.dir, env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir, CLAUDE_CODE_SESSION_ID: "", HARNESS_HOME: join(repo.dir, ".harness-home") }, encoding: "utf8" });
  assert.equal(evaluated.status, 0, evaluated.stdout);

  const result = repo.git(["commit", "-m", "already evaluated"]);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /running harness-eval/);
});

test("without the plugin on the machine, the commit is stopped with the setup steps, and --no-verify skips it", () => {
  const repo = makeRepo({ plugin: false });
  change(repo);

  const result = repo.git(["commit", "-m", "x"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not set up on this machine/);
  assert.match(result.stderr, /--plugin-dir/);

  assert.equal(repo.git(["commit", "--no-verify", "-m", "x"]).status, 0);
});

test("AI attribution trailers are stripped; anyone else's stay", () => {
  const repo = makeRepo();
  change(repo);
  const message = [
    "A change",
    "",
    "Why it was made.",
    "",
    "Co-Authored-By: Alice <alice@example.com>",
    "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
    "co-authored-by: GitHub Copilot <copilot@github.com>",
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    "",
  ].join("\n");

  const result = repo.git(["commit", "-F", "-"], {}, message);
  assert.equal(result.status, 0, result.stderr);

  const body = repo.git(["log", "-1", "--format=%B"]).stdout.trim();
  assert.equal(body, "A change\n\nWhy it was made.\n\nCo-Authored-By: Alice <alice@example.com>");
});

test("stripAttribution leaves a message without AI trailers alone", () => {
  assert.equal(stripAttribution("Fix a thing\n\nCo-Authored-By: Alice <a@example.com>\n"), null);
});

test("inside Claude Code the commit is recorded as commit.created, with the task the eval passed for", () => {
  const repo = makeRepo();
  writeFileSync(join(repo.dir, "tracked.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo.dir, "new.txt"), "x\n");
  repo.git(["add", "-A"]);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo.dir, CLAUDE_CODE_SESSION_ID: SESSION, HARNESS_HOME: join(repo.dir, ".harness-home") };
  assert.equal(spawnSync("node", [join(root, "bin", "harness-eval.mjs"), "--task", "PLAN-1.1"], { cwd: repo.dir, env, encoding: "utf8" }).status, 0);

  assert.equal(repo.git(["commit", "-m", "PLAN-1.1"], { CLAUDE_CODE_SESSION_ID: SESSION }).status, 0);

  const path = join(repo.dir, ".harness", "events");
  const created = readdirSync(path)
    .flatMap((f) => readFileSync(join(path, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)))
    .find((e) => e.type === "commit.created");
  assert.ok(created, "no commit.created");
  assert.ok(validators[created.schema](created), describe(validators[created.schema]));
  assert.equal(created.task_id, "PLAN-1.1");
  assert.deepEqual(created.data, {
    commit_sha: head(repo), task_ids: ["PLAN-1.1"], files_changed: 2, lines_added: 3, lines_removed: 0,
  });
});

test("a commit by hand records nothing", () => {
  const repo = makeRepo();
  change(repo);
  assert.equal(repo.git(["commit", "-m", "by hand"]).status, 0);
  assert.equal(existsSync(join(repo.dir, ".harness", "events")), false);
});
