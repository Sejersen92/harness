// harness-eval: runs routing.yaml's stages against what is staged, and is the only writer of the pass
// marker the commit gate reads. Runs the bundled bin/ script against throwaway git repos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, root, validatorFor, type Line } from "./validators.ts";
import { cleanEnv, git } from "./git.ts";

type Repo = { dir: string; g: (...args: string[]) => Buffer };

const SESSION = "11111111-2222-4333-8444-555555555555";

const pass = (name: string): string => `    - { name: ${name}, run: 'node -e "process.exit(0)"' }`;
const fail = (name: string, text: string = ""): string => `    - { name: ${name}, run: 'node -e "console.log(\\"${text}\\"); process.exit(1)"' }`;

function makeRepo(stageLines: string[], { mode = "observe" }: { mode?: string } = {}): Repo {
  const dir = mkdtempSync(join(tmpdir(), "harness-eval-"));
  const g = (...args: string[]): Buffer => git(["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".harness/\n.harness-home/\n.claude/state/\n");
  writeFileSync(join(dir, "routing.yaml"), [
    "version: 1",
    `mode: ${mode}`,
    "eval:",
    stageLines.length ? "  stages:" : "  stages: []",
    ...stageLines,
    "",
  ].join("\n"));
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return { dir, g };
}

const run = (dir: string, args: string[] = [], { session = true, extraEnv = {} }: { session?: boolean; extraEnv?: NodeJS.ProcessEnv } = {}) => {
  const env: NodeJS.ProcessEnv = { ...cleanEnv(), CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: root, HARNESS_HOME: join(dir, ".harness-home"), ...extraEnv };
  delete env.CLAUDE_CODE_SESSION_ID;
  if (session) env.CLAUDE_CODE_SESSION_ID = SESSION;
  return spawnSync("node", [join(root, "bin", "harness-eval.mjs"), ...args], { cwd: dir, env, encoding: "utf8" });
};

const stageChange = ({ dir, g }: Repo, name: string = "a.txt", text: string = "hello\n"): void => {
  writeFileSync(join(dir, name), text);
  g("add", name);
};

const marker = (dir: string): string => join(dir, ".claude", "state", "eval-pass.json");

const events = (dir: string): Line[] => {
  const path = join(dir, ".harness", "events");
  if (!existsSync(path)) return [];
  return readdirSync(path).flatMap((f) => readFileSync(join(path, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line));
};

function assertValid(event: Line | undefined): asserts event is Line {
  assert.ok(event, "the line is missing");
  const validate = validatorFor(event);
  assert.ok(validate(event), `${event.type} does not match its schema:\n  ${describe(validate)}`);
}

test("a pass writes the marker with the staged diff's hash and HEAD, and records both events", () => {
  const repo = makeRepo([pass("build"), pass("unit")]);
  stageChange(repo);

  const result = run(repo.dir, ["--task", "PLAN-1.1"]);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS/);
  const written = JSON.parse(readFileSync(marker(repo.dir), "utf8"));
  const diff = git(["-C", repo.dir, "diff", "--cached", "--binary"]);
  assert.equal(written.diff_sha256, createHash("sha256").update(diff).digest("hex"));
  assert.equal(written.head, git(["-C", repo.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  assert.deepEqual(written.task_ids, ["PLAN-1.1"]);

  const [started, completed] = events(repo.dir);
  for (const e of [started, completed]) assertValid(e);
  assert.equal(started.type, "eval.started");
  assert.equal(started.data.ci, false);
  assert.equal(completed.type, "eval.completed");
  assert.equal(completed.task_id, "PLAN-1.1");
  assert.equal(completed.data.result, "pass");
  assert.deepEqual(completed.data.stages.map((s: Line) => [s.name, s.status]), [["build", "pass"], ["unit", "pass"]]);
});

test("a failing stage stops the run: later stages are skipped, AC ids are collected, and the old pass is revoked", () => {
  const repo = makeRepo([pass("build"), fail("unit", "FAILED PLAN-1.1/AC-2 shows the count"), pass("lint")]);
  stageChange(repo);
  // An earlier pass must not survive a failing run.
  mkdirSync(join(repo.dir, ".claude", "state"), { recursive: true });
  writeFileSync(marker(repo.dir), "{}");

  const result = run(repo.dir, ["--task", "PLAN-1.1"]);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL at unit/);
  assert.match(result.stdout, /PLAN-1\.1\/AC-2 shows the count/);
  assert.equal(existsSync(marker(repo.dir)), false);
  assert.match(readFileSync(join(repo.dir, ".harness", "state", "eval", "unit.log"), "utf8"), /AC-2/);

  const completed = events(repo.dir).find((e) => e.type === "eval.completed");
  assertValid(completed);
  assert.equal(completed.data.result, "fail");
  assert.deepEqual(completed.data.stages.map((s: Line) => [s.name, s.status]), [["build", "pass"], ["unit", "fail"], ["lint", "skipped"]]);
  assert.deepEqual(completed.data.failed_acs, ["PLAN-1.1/AC-2"]);
  assert.equal(completed.data.attribution, "task");
});

test("nothing staged is refused, not passed", () => {
  const repo = makeRepo([pass("build")]);
  const result = run(repo.dir);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /nothing is staged/);
  assert.equal(existsSync(marker(repo.dir)), false);
});

test("unstaged edits and untracked files are refused and listed, since they would be tested but not committed", () => {
  const repo = makeRepo([pass("build")]);
  stageChange(repo);
  writeFileSync(join(repo.dir, "a.txt"), "edited after staging\n");
  writeFileSync(join(repo.dir, "new.txt"), "never staged\n");

  const result = run(repo.dir);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /modified: a\.txt/);
  assert.match(result.stdout, /untracked: new\.txt/);
  assert.equal(events(repo.dir).length, 0);
});

test("no stages is refused: an eval of nothing would be a hollow pass", () => {
  const repo = makeRepo([]);
  stageChange(repo);
  const result = run(repo.dir);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /no eval\.stages/);
});

test("a stage that changes the working tree voids the pass", () => {
  const repo = makeRepo([`    - { name: generate, run: 'node -e "require(\\"fs\\").writeFileSync(\\"gen.txt\\", \\"x\\")"' }`]);
  stageChange(repo);

  const result = run(repo.dir);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /changed while the eval ran/);
  assert.equal(existsSync(marker(repo.dir)), false);
});

test("outside Claude Code it still gates, but records nothing and counts no failure", () => {
  const repo = makeRepo([pass("build")]);
  stageChange(repo);

  const result = run(repo.dir, [], { session: false });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(marker(repo.dir)));
  assert.equal(events(repo.dir).length, 0);
  assert.equal(existsSync(join(repo.dir, ".harness", "emit-failures")), false);
});

test("--ci evaluates the checkout as it is and writes no marker", () => {
  const repo = makeRepo([pass("build")]);
  const result = run(repo.dir, ["--ci"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(marker(repo.dir)), false);
  const started = events(repo.dir).find((e) => e.type === "eval.started")!;
  assert.equal(started.data.ci, true);
});

test("with the Harness off there is nothing to gate", () => {
  const repo = makeRepo([fail("build")], { mode: "off" });
  stageChange(repo);
  const result = run(repo.dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /off/);
});

// PLAN-1.1: a git hook exports GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE and GIT_PREFIX. A stage that
// inherits them runs its git commands against that repository instead of its own. harness-eval runs
// here with --ci --config, so its only git commands are the stage's; the GIT_* variables below are
// set on the harness-eval child alone and always point at a throwaway repository, never this one.

/** Everything in a repository a stray git command could rewrite: its config, refs, HEAD and index bytes. */
const snapshot = ({ dir, g }: Repo) => ({
  config: readFileSync(join(dir, ".git", "config"), "utf8"),
  refs: g("for-each-ref").toString(),
  head: readFileSync(join(dir, ".git", "HEAD"), "utf8"),
  index: createHash("sha256").update(readFileSync(join(dir, ".git", "index"))).digest("hex"),
});

test("PLAN-1.1/AC-2 a stage's git commands run in the evaluated repository, not one inherited GIT_* variables point at", () => {
  const repo = makeRepo([
    "    - { name: git-writes, run: 'git branch harness-probe && git rm -q --cached routing.yaml && git config core.bare true' }",
  ]);
  const other = makeRepo([pass("build")]);
  const before = snapshot(other);

  const result = run(repo.dir, ["--ci", "--config", "routing.yaml"], {
    session: false,
    extraEnv: {
      GIT_DIR: join(other.dir, ".git"),
      GIT_INDEX_FILE: join(other.dir, ".git", "index"),
      GIT_WORK_TREE: other.dir,
    },
  });

  const after = snapshot(other);
  assert.equal(after.config, before.config, "PLAN-1.1/AC-2 the stage rewrote the other repository's config");
  assert.equal(after.refs, before.refs, "PLAN-1.1/AC-2 the stage changed the other repository's refs");
  assert.equal(after.head, before.head, "PLAN-1.1/AC-2 the stage changed the other repository's HEAD");
  assert.equal(after.index, before.index, "PLAN-1.1/AC-2 the stage rewrote the other repository's index");
  // And the stage did run, in its own repository, so an unchanged repository above is not a vacuous pass.
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(join(repo.dir, ".git", "config"), "utf8"), /bare = true/);
  assert.match(repo.g("for-each-ref").toString(), /refs\/heads\/harness-probe/);
});

test("PLAN-1.1/AC-1 a stage gets no inherited GIT_* variable but GIT_CONFIG_*, and its own env is applied after", () => {
  const repo = makeRepo([
    "    - name: env-probe",
    "      run: node env-probe.cjs",
    "      env: { GIT_AUTHOR_NAME: from-the-stage, GIT_COMMITTER_NAME: only-in-the-stage }",
  ]);
  writeFileSync(join(repo.dir, "env-probe.cjs"), [
    "const fs = require(\"fs\");",
    "const seen = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^GIT_/i.test(k)));",
    "fs.writeFileSync(\"env-probe.json\", JSON.stringify(seen));",
    "",
  ].join("\n"));
  // None of these is a real repository: the values only have to be recognisable if they leak through.
  const nowhere = join(tmpdir(), "harness-no-such-repo");

  const result = run(repo.dir, ["--ci", "--config", "routing.yaml"], {
    session: false,
    extraEnv: {
      GIT_DIR: join(nowhere, ".git"),
      GIT_INDEX_FILE: join(nowhere, ".git", "index"),
      GIT_WORK_TREE: nowhere,
      GIT_PREFIX: "sub/",
      GIT_AUTHOR_NAME: "from-the-hook",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "harness.probe",
      GIT_CONFIG_VALUE_0: "kept",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const seen = JSON.parse(readFileSync(join(repo.dir, "env-probe.json"), "utf8")) as Record<string, string>;
  assert.deepEqual(seen, {
    GIT_AUTHOR_NAME: "from-the-stage",
    GIT_COMMITTER_NAME: "only-in-the-stage",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "harness.probe",
    GIT_CONFIG_VALUE_0: "kept",
  }, "PLAN-1.1/AC-1 the stage's GIT_* environment");
});
