// The commit gate and the marker guard: which commands are commits (C2's table, DESIGN.md), and what
// the PreToolUse hook decides for them against a real repository, harness-eval and marker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEST_GLOBS } from "../src/lib/config.ts";
import { isCommit, isMarkerPath, isTestPath } from "../src/lib/gate.ts";
import { describe, root, validatorFor, type Line } from "./validators.ts";

type Repo = { dir: string; g: (...args: string[]) => Buffer };

const SESSION = "11111111-2222-4333-8444-555555555555";

// ---- which commands are commits ------------------------------------------------------------------

const GATED = [
  // DESIGN.md's table (C2)
  'git commit -m "x"',
  'git -C ../svc-a commit -m "x"',
  'git -c user.name=x commit -m "x"',
  'GIT_AUTHOR_NAME=x git commit -m "x"',
  'npm test && git commit -am "x"',
  'git --git-dir .git commit -m "x"',
  'bash -c "git commit -m x"',
  'echo "git commit"',
  // and ways round it that cost nothing to close
  "git commit",
  "git status; git commit -m x",
  "git status\ngit commit -m x",
  "npm test || git commit -m x",
  "result=$(git commit -m x)",
  "`git commit -m x`",
  "git --no-pager -C 'a path' commit -m x",
  "git --work-tree=. --git-dir=.git commit -m x",
  "git --namespace ns commit",
  "sudo git commit -m x",
  "env -i git commit -m x",
  "/usr/bin/git commit -m x",
  "C:/Program\\ Files/Git/bin/git.exe commit -m x",
  '"C:/Program Files/Git/bin/git.exe" commit -m x',
  "git.exe commit -m x",
  "git commit --amend --no-edit",
];

const NOT_GATED = [
  "git log --grep commit",
  "git commit-tree HEAD^{tree} -m x", // denied by permission rules instead
  "git status",
  "git show HEAD --stat",
  'git log -1 --format="%H commit"',
  "npm run commitlint",
  "echo commit",
  "legit commit",
  "",
];

for (const command of GATED) test(`gated: ${JSON.stringify(command)}`, () => assert.equal(isCommit(command), true));
for (const command of NOT_GATED) test(`not gated: ${JSON.stringify(command)}`, () => assert.equal(isCommit(command), false));

test("the marker is recognised however its path is spelled", () => {
  for (const p of [".claude/state/eval-pass.json", "C:\\src\\pu\\.claude\\state\\eval-pass.json", "/repo/.claude//state/eval-pass.json.tmp"]) {
    assert.equal(isMarkerPath(p), true, p);
  }
  for (const p of [".claude/settings.json", "eval-pass.json", undefined]) assert.equal(isMarkerPath(p), false, String(p));
});

// ---- the hook, against a repository --------------------------------------------------------------

function makeRepo({ mode = "observe" }: { mode?: string } = {}): Repo {
  const dir = mkdtempSync(join(tmpdir(), "harness-gate-"));
  const g = (...args: string[]): Buffer => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".harness/\n.harness-home/\n.claude/state/\n");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  writeFileSync(join(dir, "routing.yaml"), [
    "version: 1",
    `mode: ${mode}`,
    "eval:",
    "  stages:",
    `    - { name: build, run: 'node -e "process.exit(0)"' }`,
    "gate:",
    "  marker_ttl_minutes: 30",
    "",
  ].join("\n"));
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return { dir, g };
}

const env = (dir: string): NodeJS.ProcessEnv => ({ ...process.env, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: root, HARNESS_HOME: join(dir, ".harness-home") });

const evaluate = (dir: string) => spawnSync("node", [join(root, "bin", "harness-eval.mjs")], { cwd: dir, env: env(dir), encoding: "utf8" });

const preToolUse = (dir: string, tool_name: string, tool_input: Record<string, unknown>, agent_type?: string): Line | null => {
  const result = spawnSync("node", [join(root, "bin", "hook-pre-tool-use.mjs")], {
    cwd: dir, env: env(dir), encoding: "utf8",
    input: JSON.stringify({ session_id: SESSION, hook_event_name: "PreToolUse", tool_name, tool_input, ...(agent_type ? { agent_id: "a1", agent_type } : {}) }),
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? (JSON.parse(result.stdout) as { hookSpecificOutput: Line }).hookSpecificOutput : null;
};

/** A hook output the test expects to exist: fails the test when the hook said nothing. */
const decided = (out: Line | null): Line => {
  assert.ok(out, "the hook made no decision");
  return out;
};

const commit = (dir: string): Line | null => preToolUse(dir, "Bash", { command: 'git commit -m "change"' });

const decisions = (dir: string): Line[] => {
  const path = join(dir, ".harness", "events");
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .flatMap((f) => readFileSync(join(path, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line))
    .filter((e) => e.type === "gate.decision");
};

const stage = ({ dir, g }: Repo, text: string = "two\n"): void => {
  writeFileSync(join(dir, "tracked.txt"), text);
  g("add", "tracked.txt");
};

test("a commit with no eval pass is denied, and says how to get one", () => {
  const repo = makeRepo();
  stage(repo);

  const out = decided(commit(repo.dir));

  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /no_marker/);
  assert.match(out.permissionDecisionReason, /bin\/harness-eval\.mjs/);
  const [decision] = decisions(repo.dir);
  assert.ok(decision, "no gate.decision");
  assert.ok(validatorFor(decision)(decision), describe(validatorFor(decision)));
  assert.deepEqual(decision.data, { decision: "deny", reason: "no_marker" });
});

test("a commit of exactly what the eval passed is allowed, and recorded", () => {
  const repo = makeRepo();
  stage(repo);
  assert.equal(evaluate(repo.dir).status, 0);

  assert.equal(commit(repo.dir), null);
  assert.deepEqual(decisions(repo.dir).at(-1)?.data, { decision: "allow", reason: "pass" });
});

test("staging something else after the eval is a diff_mismatch", () => {
  const repo = makeRepo();
  stage(repo);
  assert.equal(evaluate(repo.dir).status, 0);
  stage(repo, "three\n");

  const out = decided(commit(repo.dir));
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /diff_mismatch.*staged diff/);
});

test("an unstaged edit after the eval is denied, because commit -a would take it unevaluated", () => {
  const repo = makeRepo();
  writeFileSync(join(repo.dir, "other.txt"), "x\n");
  repo.g("add", "other.txt");
  assert.equal(evaluate(repo.dir).status, 0);
  writeFileSync(join(repo.dir, "tracked.txt"), "edited later\n");

  const out = decided(preToolUse(repo.dir, "Bash", { command: 'git commit -am "change"' }));
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /unstaged/);
});

test("a pass on another HEAD is a diff_mismatch", () => {
  const repo = makeRepo();
  stage(repo);
  assert.equal(evaluate(repo.dir).status, 0);
  repo.g("commit", "-q", "--no-verify", "-m", "moved on");
  stage(repo, "four\n");
  // Point the marker at what is staged now, so HEAD is the only thing that differs.
  const marker = JSON.parse(readFileSync(join(repo.dir, ".claude", "state", "eval-pass.json"), "utf8"));
  marker.diff_sha256 = execFileSync("node", ["-e", "const c=require('crypto');process.stdout.write(c.createHash('sha256').update(require('child_process').execFileSync('git',['diff','--cached','--binary'])).digest('hex'))"], { cwd: repo.dir, encoding: "utf8" });
  writeFileSync(join(repo.dir, ".claude", "state", "eval-pass.json"), JSON.stringify(marker));

  const out = decided(commit(repo.dir));
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /HEAD has moved/);
});

test("an old pass is a stale_marker", () => {
  const repo = makeRepo();
  stage(repo);
  assert.equal(evaluate(repo.dir).status, 0);
  const path = join(repo.dir, ".claude", "state", "eval-pass.json");
  const marker = JSON.parse(readFileSync(path, "utf8"));
  marker.passed_at = new Date(Date.now() - 31 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(path, JSON.stringify(marker));

  const out = decided(commit(repo.dir));
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /stale_marker/);
});

test("commands that are not commits pass straight through and record nothing", () => {
  const repo = makeRepo();
  stage(repo);
  assert.equal(preToolUse(repo.dir, "Bash", { command: "git log --grep commit" }), null);
  assert.equal(preToolUse(repo.dir, "Edit", { file_path: join(repo.dir, "tracked.txt") }), null);
  assert.equal(decisions(repo.dir).length, 0);
});

test("the marker can't be written by a tool call, only by harness-eval", () => {
  const repo = makeRepo();
  const marker = join(repo.dir, ".claude", "state", "eval-pass.json");
  for (const [tool, input] of [
    ["Write", { file_path: marker, content: "{}" }],
    ["Edit", { file_path: marker.replace(/\//g, "\\"), old_string: "a", new_string: "b" }],
    ["Bash", { command: `echo {} > .claude/state/eval-pass.json` }],
  ] as [string, Record<string, unknown>][]) {
    const out = decided(preToolUse(repo.dir, tool, input));
    assert.equal(out?.permissionDecision, "deny", `${tool} was let through`);
    assert.match(out.permissionDecisionReason, /only by harness-eval/);
  }
  assert.equal(preToolUse(repo.dir, "Bash", { command: "node /p/bin/harness-eval.mjs --task PLAN-1.1 # writes eval-pass.json" }), null);
});

test("what counts as a test: the default globs, relative to the repository", () => {
  const dir = join(tmpdir(), "repo");
  const yes = ["web/app/page.test.tsx", "src/x.spec.ts", "cli/PreviouslyUpcoming.Cli.Tests/HarnessSyncTests.cs", "test/eval.test.mjs",
    "pkg/thing_test.go", "app/tests/test_api.py", "web/__tests__/a.js", join(dir, "Svc.Tests", "A.cs")];
  const no = ["src/lib/gate.mjs", "cli/PreviouslyUpcoming.Cli/HarnessSync.cs", "docs/testing.md", "attest/x.cs", join(tmpdir(), "elsewhere", "a.test.js")];
  for (const p of yes) assert.equal(isTestPath(p, dir, DEFAULT_TEST_GLOBS), true, p);
  for (const p of no) assert.equal(isTestPath(p, dir, DEFAULT_TEST_GLOBS), false, p);
  assert.equal(isTestPath("src/e2e/login.ts", dir, ["src/e2e/**"]), true);
});

test("implementers can't edit tests; everyone else's edits are untouched", () => {
  const repo = makeRepo();
  const test = join(repo.dir, "test", "a.test.mjs");
  const code = join(repo.dir, "src", "a.mjs");

  const denied = preToolUse(repo.dir, "Edit", { file_path: test }, "harness:impl-t2");
  assert.equal(denied?.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /implementers don't change tests/);
  assert.equal(preToolUse(repo.dir, "Write", { file_path: code }, "harness:impl-t2"), null);
  assert.equal(preToolUse(repo.dir, "Edit", { file_path: test }), null, "the main thread is not policed");
  assert.equal(preToolUse(repo.dir, "Edit", { file_path: test }, "general-purpose"), null, "other agents are not policed");
});

test("the evaluator can edit tests and nothing else", () => {
  const repo = makeRepo();
  assert.equal(preToolUse(repo.dir, "Write", { file_path: join(repo.dir, "test", "a.test.mjs") }, "harness:evaluator"), null);

  const denied = preToolUse(repo.dir, "MultiEdit", { file_path: join(repo.dir, "src", "a.mjs") }, "harness:evaluator");
  assert.equal(denied?.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /writes tests only/);
});

test("routing.yaml's eval.tests replaces the default globs", () => {
  const repo = makeRepo();
  writeFileSync(join(repo.dir, "routing.yaml"), readFileSync(join(repo.dir, "routing.yaml"), "utf8").replace("eval:\n", "eval:\n  tests: [\"checks/**\"]\n"));
  assert.equal(preToolUse(repo.dir, "Write", { file_path: join(repo.dir, "checks", "a.mjs") }, "harness:evaluator"), null);
  assert.equal(preToolUse(repo.dir, "Write", { file_path: join(repo.dir, "test", "a.test.mjs") }, "harness:evaluator")?.permissionDecision, "deny");
});

test("with the Harness off nothing is gated", () => {
  const repo = makeRepo({ mode: "off" });
  stage(repo);
  assert.equal(commit(repo.dir), null);
  assert.equal(decisions(repo.dir).length, 0);
});
