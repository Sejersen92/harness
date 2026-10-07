// harness-eval: runs routing.yaml's stages against what is staged, and is the only writer of the pass
// marker the commit gate reads. Runs the bundled bin/ script against throwaway git repos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, root, validators } from "./validators.mjs";

const SESSION = "11111111-2222-4333-8444-555555555555";

const pass = (name) => `    - { name: ${name}, run: 'node -e "process.exit(0)"' }`;
const fail = (name, text = "") => `    - { name: ${name}, run: 'node -e "console.log(\\"${text}\\"); process.exit(1)"' }`;

function makeRepo(stageLines, { mode = "observe" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-eval-"));
  const g = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { stdio: ["ignore", "pipe", "pipe"] });
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

const run = (dir, args = [], { session = true } = {}) => {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: root, HARNESS_HOME: join(dir, ".harness-home") };
  delete env.CLAUDE_CODE_SESSION_ID;
  if (session) env.CLAUDE_CODE_SESSION_ID = SESSION;
  return spawnSync("node", [join(root, "bin", "harness-eval.mjs"), ...args], { cwd: dir, env, encoding: "utf8" });
};

const stageChange = ({ dir, g }, name = "a.txt", text = "hello\n") => {
  writeFileSync(join(dir, name), text);
  g("add", name);
};

const marker = (dir) => join(dir, ".claude", "state", "eval-pass.json");

const events = (dir) => {
  const path = join(dir, ".harness", "events");
  if (!existsSync(path)) return [];
  return readdirSync(path).flatMap((f) => readFileSync(join(path, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
};

const assertValid = (event) => {
  const validate = validators[event.schema];
  assert.ok(validate(event), `${event.type} does not match its schema:\n  ${describe(validate)}`);
};

test("a pass writes the marker with the staged diff's hash and HEAD, and records both events", () => {
  const repo = makeRepo([pass("build"), pass("unit")]);
  stageChange(repo);

  const result = run(repo.dir, ["--task", "PLAN-1.1"]);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS/);
  const written = JSON.parse(readFileSync(marker(repo.dir), "utf8"));
  const diff = execFileSync("git", ["-C", repo.dir, "diff", "--cached", "--binary"]);
  assert.equal(written.diff_sha256, createHash("sha256").update(diff).digest("hex"));
  assert.equal(written.head, execFileSync("git", ["-C", repo.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  assert.deepEqual(written.task_ids, ["PLAN-1.1"]);

  const [started, completed] = events(repo.dir);
  for (const e of [started, completed]) assertValid(e);
  assert.equal(started.type, "eval.started");
  assert.equal(started.data.ci, false);
  assert.equal(completed.type, "eval.completed");
  assert.equal(completed.task_id, "PLAN-1.1");
  assert.equal(completed.data.result, "pass");
  assert.deepEqual(completed.data.stages.map((s) => [s.name, s.status]), [["build", "pass"], ["unit", "pass"]]);
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
  assert.deepEqual(completed.data.stages.map((s) => [s.name, s.status]), [["build", "pass"], ["unit", "fail"], ["lint", "skipped"]]);
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
  const started = events(repo.dir).find((e) => e.type === "eval.started");
  assert.equal(started.data.ci, true);
});

test("with the Harness off there is nothing to gate", () => {
  const repo = makeRepo([fail("build")], { mode: "off" });
  stageChange(repo);
  const result = run(repo.dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /off/);
});
