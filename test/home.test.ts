// A repository's home (ANY-REPO.md, H1): everything the Harness keeps for a repository lives in
// ~/.harness/repos/<name>-<hash>/, and the repository itself is left exactly as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, NOT_ENROLLED, repoHome } from "../src/lib/config.ts";
import { isMarkerPath } from "../src/lib/gate.ts";
import { root, type Line } from "./validators.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";
const ROUTING = [
  "version: 1",
  "mode: observe",
  "tiers:",
  "  T1: { max_score: 2,  agent: impl-t1, model: sonnet, effort: low }",
  "  T2: { max_score: 6,  agent: impl-t2, model: sonnet, effort: medium }",
  "  T3: { max_score: 9,  agent: impl-t3, model: sonnet, effort: high }",
  "  T4: { max_score: 12, agent: impl-t4, model: opus,   effort: medium }",
  "eval:",
  "  stages:",
  `    - { name: build, run: 'node -e "process.exit(0)"' }`,
  "",
].join("\n");

/** Runs fn with HARNESS_HOME pointing at a scratch folder: a test never touches the real ~/.harness. */
function withHarnessHome<T>(harnessHome: string, fn: () => T): T {
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = harnessHome;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous;
  }
}

/** A repository with one commit and no Harness file in it, plus a scratch ~/.harness outside it. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "harness-home-repo-"));
  const harnessHome = mkdtempSync(join(tmpdir(), "harness-home-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(dir, "readme.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: root, HARNESS_HOME: harnessHome };
  const node = (script: string, args: string[] = [], input?: string) =>
    spawnSync("node", [join(root, "bin", `${script}.mjs`), ...args], { cwd: dir, env, encoding: "utf8", input });
  return { dir, harnessHome, git, node };
}

/** Enrolls by hand, the way H2's enrol will: a routing.yaml in the repository's home. */
function enrol(dir: string, harnessHome: string): string {
  const home = withHarnessHome(harnessHome, () => repoHome(dir));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "routing.yaml"), ROUTING);
  return home;
}

test("a repository's home is one folder per clone, however its path is spelled", () => {
  const harnessHome = mkdtempSync(join(tmpdir(), "harness-home-"));
  withHarnessHome(harnessHome, () => {
    const home = repoHome("C:\\src\\PreviouslyUpcoming");
    assert.equal(repoHome("c:/src/previouslyupcoming/"), home, "case, separators and a trailing slash don't matter");
    assert.match(home.replace(/\\/g, "/"), /\/repos\/previouslyupcoming-[0-9a-f]{8}$/);
    assert.ok(home.startsWith(harnessHome), "it is under HARNESS_HOME");
    assert.notEqual(repoHome("C:\\work\\PreviouslyUpcoming"), home, "a second clone of the same repository gets its own home");
    assert.match(repoHome("C:\\src\\My Repo (old)").replace(/\\/g, "/"), /\/repos\/my-repo-old-?-[0-9a-f]{8}$/, "the name is made safe for a folder");
  });
});

test("loadConfig finds the home first, then a routing.yaml in the repository, and is off with neither", () => {
  const { dir, harnessHome } = makeRepo();
  withHarnessHome(harnessHome, () => {
    const off = loadConfig(dir);
    assert.equal(off.mode, "off");
    assert.equal(off.reason, NOT_ENROLLED);
    assert.equal(off.home, repoHome(dir));

    writeFileSync(join(dir, "routing.yaml"), ROUTING.replace("mode: observe", "mode: route"));
    const old = loadConfig(dir);
    assert.equal(old.layout?.kind, "repository");
    assert.equal(old.mode, "route");
    assert.equal(old.layout?.markerPath, join(dir, ".claude", "state", "eval-pass.json"));
    assert.equal(old.layout?.planPath, join(dir, "PLAN.md"));
    assert.equal(old.metadataDir, join(dir, ".harness"));

    const home = enrol(dir, harnessHome);
    const homed = loadConfig(dir);
    assert.equal(homed.layout?.kind, "home", "a home wins over a routing.yaml left in the repository");
    assert.equal(homed.mode, "observe");
    assert.equal(homed.layout?.markerPath, join(home, "state", "eval-pass.json"));
    assert.equal(homed.layout?.planPath, join(home, "PLAN.md"));
    assert.equal(homed.metadataDir, home);
  });
});

test("the marker guard knows a home's marker as well as the old one", () => {
  for (const path of [
    "C:\\Users\\u\\.harness\\repos\\pu-1a2b3c4d\\state\\eval-pass.json",
    "/home/u/.harness/repos/pu-1a2b3c4d/state/eval-pass.json.tmp",
    "C:/src/pu/.claude/state/eval-pass.json",
    ".claude\\state\\eval-pass.json",
  ]) assert.equal(isMarkerPath(path), true, path);
  for (const path of ["C:/src/pu/state.json", "C:/src/pu/eval-pass.json", "C:/src/pu/statement/eval-pass.json"]) assert.equal(isMarkerPath(path), false, path);
});

test("an enrolled repository is evaluated, recorded and gated with nothing written into it", () => {
  const { dir, harnessHome, git, node } = makeRepo();
  const home = enrol(dir, harnessHome);

  // Work to commit, staged, as the evaluator leaves it.
  writeFileSync(join(dir, "change.txt"), "two\n");
  git("add", "change.txt");

  const evaluated = node("harness-eval", ["--task", "PLAN-1.1"]);
  assert.equal(evaluated.status, 0, evaluated.stdout + evaluated.stderr);
  assert.ok(existsSync(join(home, "state", "eval-pass.json")), "the marker is in the home");
  assert.match(evaluated.stdout, /PASS - .*state[\\/]eval-pass\.json written/);

  const emitted = node("harness-emit", ["plan.created", "--plan", "PLAN-1", "--data", JSON.stringify({ title: "t", task_ids: ["PLAN-1.1"] })]);
  assert.equal(emitted.status, 0, emitted.stderr);
  const day = readFileSync(join(home, "events", `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
  const types = day.trim().split("\n").map((l) => (JSON.parse(l) as Line).type);
  assert.deepEqual(types, ["eval.started", "eval.completed", "plan.created"], "every line went to the home's spool");

  const gate = node("hook-pre-tool-use", [], JSON.stringify({ session_id: SESSION, tool_name: "Bash", tool_input: { command: 'git commit -m "x"' } }));
  assert.equal(gate.status, 0, gate.stderr);
  assert.equal(gate.stdout, "", "the commit is allowed by the marker in the home");

  const start = node("hook-session-start", [], JSON.stringify({ session_id: SESSION, source: "startup" }));
  const context = (JSON.parse(start.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  assert.ok(context.includes(join(home, "PLAN.md").replace(/\\/g, "/")), "the session is told where its plan is");

  const doctor = node("harness-doctor");
  assert.match(doctor.stdout, /pass\s+layout\s+nothing in the repository/);
  assert.match(doctor.stdout, /pass\s+spool-writable/);

  // The repository holds the person's change and nothing of the Harness's, ignored files included.
  assert.equal(git("status", "--porcelain", "--ignored").trim(), "A  change.txt");
  assert.ok(existsSync(join(harnessHome, "spools.json")), "the spool is registered for pu sync");
  assert.match(readFileSync(join(harnessHome, "spools.json"), "utf8"), /"metadata_dir"/);
});
