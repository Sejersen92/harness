// harness-doctor, harness-init (enrol) and harness-forget against throwaway repositories: what doctor
// finds in a bare one, that enrolling writes nothing into the repository and leaves one doctor passes,
// that the repository's own hooks keep running after the Harness's, and that forget puts it all back.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoHome } from "../src/lib/config.ts";
import { detectStages, homeDeny } from "../src/lib/home.ts";
import { checks, type CheckResult } from "../src/lib/setup.ts";
import { root } from "./validators.ts";

/** A routing.yaml whose one stage passes, so a commit's eval is quick and certain. */
const PASSING = [
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

/** A repository with one commit, and a scratch ~/.harness outside it holding the plugin record. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "harness-setup-"));
  const harnessHome = mkdtempSync(join(tmpdir(), "harness-setup-home-"));
  writeFileSync(join(harnessHome, "plugin.json"), JSON.stringify({ root, version: "test" }));
  const env: NodeJS.ProcessEnv = {
    ...process.env, CLAUDE_PROJECT_DIR: dir, HARNESS_HOME: harnessHome,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  const git = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync("git", ["-C", dir, "-c", "core.autocrlf=false", ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  git(["init", "-q"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint", test: "vitest run", build: "next build", dev: "next dev" } }));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  const run = (name: string, ...args: string[]) => spawnSync("node", [join(root, "bin", `${name}.mjs`), ...args], { cwd: dir, env, encoding: "utf8" });
  const setting = (key: string): string | null => {
    const result = git(["config", "--get", key]);
    return result.status === 0 ? result.stdout.trim() : null;
  };
  return { dir, harnessHome, git, run, setting };
}

/** Points HARNESS_HOME at the test's scratch folder for code run in this process, never the machine's. */
function useHarnessHome(t: TestContext, harnessHome: string): void {
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = harnessHome;
  t.after(() => (previous === undefined ? delete process.env.HARNESS_HOME : (process.env.HARNESS_HOME = previous)));
}

const status = (results: CheckResult[], name: string): CheckResult["status"] | undefined => results.find((r) => r.name === name)?.status;

test("doctor on a bare repository says it is not enrolled, and checks no layout it doesn't have", () => {
  const { run } = makeRepo();
  const result = run("harness-doctor");

  assert.equal(result.status, 1);
  assert.match(result.stdout, /fail\s+routing-yaml\s+not enrolled: there is no \S+routing\.yaml \(\/harness:init enrols the repository\)/);
  assert.match(result.stdout, /warn\s+spool-writable\s+not enrolled/);
  assert.doesNotMatch(result.stdout, /git-hooks|gitignore|permissions/);
});

test("init's dry run lists every change and makes none", (t) => {
  const { dir, harnessHome, git, run, setting } = makeRepo();
  useHarnessHome(t, harnessHome);
  const result = run("harness-init");

  assert.equal(result.status, 0);
  assert.match(result.stdout, /dry run: nothing is changed/);
  assert.match(result.stdout, /routing\.yaml \(mode observe; stages: lint, test, build\)/);
  assert.match(result.stdout, /git config core\.hooksPath \S+\/githooks in this clone \(it was unset/);
  assert.equal(existsSync(repoHome(dir)), false, "no home yet");
  assert.equal(setting("core.hooksPath"), null);
  assert.equal(git(["status", "--porcelain", "--ignored"]).stdout, "");
});

test("init --apply enrols with nothing in the repository, doctor passes, and again has nothing to do", (t) => {
  const { dir, harnessHome, git, run, setting } = makeRepo();
  useHarnessHome(t, harnessHome);
  const home = repoHome(dir);

  const applied = run("harness-init", "--apply");
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);

  const routing = readFileSync(join(home, "routing.yaml"), "utf8");
  assert.match(routing, /mode: observe/);
  assert.match(routing, /name: test\n\s+run: npm run test/);
  assert.doesNotMatch(routing, /npm run dev/);
  assert.match(routing, /strip_ai_attribution: false/);
  assert.equal(JSON.parse(readFileSync(join(home, "repo.json"), "utf8")).repo_dir, dir);

  const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions.deny, homeDeny(home));
  assert.ok(settings.permissions.deny.every((rule: string) => !rule.startsWith("Write(")), "Edit rules only (S9)");
  assert.equal(settings.worktree.baseRef, "head");

  assert.deepEqual(readdirSync(join(home, "githooks")).sort(), ["commit-msg", "harness", "post-commit", "pre-commit"]);
  assert.equal(setting("core.hooksPath"), join(home, "githooks").replace(/\\/g, "/"));
  assert.equal(setting("harness.previousHooksPath"), "", "it was unset, and that is remembered");
  assert.match(readFileSync(join(harnessHome, "spools.json"), "utf8"), /"metadata_dir"/);

  const results = checks(dir, { pluginRoot: root, claudeVersion: "2.1.285 (Claude Code)" });
  assert.deepEqual(results.filter((r) => r.status !== "pass").map((r) => r.name), [], JSON.stringify(results, null, 1));

  assert.equal(git(["status", "--porcelain", "--ignored"]).stdout, "", "nothing in the repository, ignored files included");
  assert.match(run("harness-init").stdout, /nothing to do/);
});

test("a repository set up the old way keeps its routing.yaml when it is enrolled; the copy moves, nothing is deleted", (t) => {
  const { dir, harnessHome, run } = makeRepo();
  useHarnessHome(t, harnessHome);
  writeFileSync(join(dir, "routing.yaml"), PASSING.replace("mode: observe", "mode: route"));

  const applied = run("harness-init", "--apply");
  assert.equal(applied.status, 0, applied.stdout);
  assert.match(applied.stdout, /copy routing\.yaml into \S+ \(the repository's copy is left as it is\)/);
  assert.match(readFileSync(join(repoHome(dir), "routing.yaml"), "utf8"), /mode: route/);
  assert.ok(existsSync(join(dir, "routing.yaml")), "the repository's own copy is not touched");
});

test("the repository's own hooks still run, after the Harness's, and a failing one stops the commit", (t) => {
  const { dir, harnessHome, git, run, setting } = makeRepo();
  useHarnessHome(t, harnessHome);
  // Its own hooks, the way husky keeps them: a folder named by core.hooksPath, relative to the tree.
  mkdirSync(join(dir, ".husky"));
  const log = join(harnessHome, "husky.log");
  writeFileSync(join(dir, ".husky", "pre-commit"), `#!/bin/sh\necho pre-commit >> "${log.replace(/\\/g, "/")}"\n[ "$HUSKY_FAIL" = "1" ] && exit 1\nexit 0\n`);
  writeFileSync(join(dir, ".husky", "pre-push"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(dir, ".husky", "h"), "# a helper, not a hook\n");
  for (const f of ["pre-commit", "pre-push", "h"]) chmodSync(join(dir, ".husky", f), 0o755);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "husky"]);
  git(["config", "core.hooksPath", ".husky"]);
  // A routing.yaml whose eval passes, already in the home, which enrolment keeps.
  mkdirSync(repoHome(dir), { recursive: true });
  writeFileSync(join(repoHome(dir), "routing.yaml"), PASSING);

  // Commits here are gated: this is the branch the Harness is started on.
  const applied = run("harness-init", "--apply", "--branch", git(["branch", "--show-current"]).stdout.trim());
  assert.match(applied.stdout, /then the repository's own pre-commit, pre-push/);
  assert.equal(setting("harness.previousHooksPath"), ".husky");
  assert.deepEqual(readdirSync(join(repoHome(dir), "githooks")).sort(), ["commit-msg", "harness", "post-commit", "pre-commit", "pre-push"], "its helper file is not taken for a hook");

  writeFileSync(join(dir, "a.txt"), "one\n");
  git(["add", "a.txt"]);
  const committed = git(["commit", "-q", "-m", "change\n\nCo-Authored-By: Claude <noreply@anthropic.com>"]);
  assert.equal(committed.status, 0, committed.stdout + committed.stderr);
  assert.match(committed.stderr, /running harness-eval now/, "the Harness's gate ran");
  assert.equal(readFileSync(log, "utf8").trim(), "pre-commit", "and then the repository's own hook");
  assert.match(git(["log", "-1", "--format=%B"]).stdout, /Co-Authored-By: Claude/, "a home leaves the message alone by default");

  writeFileSync(join(dir, "a.txt"), "two\n");
  git(["add", "a.txt"]);
  const refused = git(["commit", "-q", "-m", "refused"], { HUSKY_FAIL: "1" });
  assert.notEqual(refused.status, 0, "the repository's failing hook stops the commit");
});

test("outside Claude Code, only Harness branches are gated; any other commit goes straight through", (t) => {
  const { dir, harnessHome, git, run } = makeRepo();
  useHarnessHome(t, harnessHome);
  const main = git(["branch", "--show-current"]).stdout.trim();
  // An eval that always fails, so a gated commit can't pass and an ungated one shows it was never asked.
  mkdirSync(repoHome(dir), { recursive: true });
  writeFileSync(join(repoHome(dir), "routing.yaml"), PASSING.replace('process.exit(0)', 'process.exit(1)'));
  git(["switch", "-q", "-c", "feat/harness-work"]);
  const applied = run("harness-init", "--apply", "--branch", "feat/harness-work");
  assert.match(applied.stdout, /mark feat\/harness-work as a Harness branch/);
  assert.match(applied.stdout, /pass\s+git-hooks\s+.*commits are gated on feat\/harness-work/);

  writeFileSync(join(dir, "a.txt"), "one\n");
  git(["add", "a.txt"]);
  const gated = git(["commit", "-q", "-m", "on the Harness branch"]);
  assert.notEqual(gated.status, 0, "a Harness branch's commit needs a passing eval");
  assert.match(gated.stderr, /running harness-eval now/);

  git(["stash", "-q"]);
  git(["switch", "-q", main]);
  git(["stash", "pop", "-q"]);
  git(["add", "a.txt"]);
  const hotfix = git(["commit", "-q", "-m", "a hand fix on another branch"]);
  assert.equal(hotfix.status, 0, hotfix.stderr);
  assert.doesNotMatch(hotfix.stderr, /harness-eval/, "the eval was never run");
});

test("inside Claude Code, a commit on a branch not recorded yet is gated too", (t) => {
  // A branch is recorded as a Harness branch only after its first commit (post-commit), and the
  // in-session gate reads the session's project, which a `cd other-repo && git commit` leaves. So
  // without this, a session's first commit on a new branch went through unevaluated.
  const { dir, harnessHome, git, run } = makeRepo();
  useHarnessHome(t, harnessHome);
  mkdirSync(repoHome(dir), { recursive: true });
  writeFileSync(join(repoHome(dir), "routing.yaml"), PASSING.replace('process.exit(0)', 'process.exit(1)'));
  git(["switch", "-q", "-c", "feat/harness-work"]);
  run("harness-init", "--apply", "--branch", "feat/harness-work");
  git(["switch", "-q", "-c", "fix/brand-new"]);

  writeFileSync(join(dir, "a.txt"), "one\n");
  git(["add", "a.txt"]);
  const first = git(["commit", "-q", "-m", "first commit on a new branch"], { CLAUDE_CODE_SESSION_ID: "11111111-2222-4333-8444-555555555555" });
  assert.notEqual(first.status, 0, "the failing eval stops it");
  assert.match(first.stderr, /running harness-eval now/);
});

test("a Harness session's branch becomes a Harness branch, and deleted branches drop off the list", (t) => {
  const { dir, harnessHome, git, run } = makeRepo();
  useHarnessHome(t, harnessHome);
  mkdirSync(repoHome(dir), { recursive: true });
  writeFileSync(join(repoHome(dir), "routing.yaml"), PASSING);
  git(["switch", "-q", "-c", "old"]);
  run("harness-init", "--apply", "--branch", "old");
  git(["switch", "-q", "-c", "next"]);
  git(["branch", "-q", "-D", "old"]);

  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: dir, HARNESS_HOME: harnessHome, CLAUDE_PLUGIN_ROOT: root };
  const start = spawnSync("node", [join(root, "bin", "hook-session-start.mjs")], { cwd: dir, env, input: "{}", encoding: "utf8" });
  assert.equal(start.status, 0, start.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(repoHome(dir), "repo.json"), "utf8")).harness_branches, ["next"]);
});

test("forget puts the clone back as it was, and its dry run changes nothing", (t) => {
  const { dir, harnessHome, git, run, setting } = makeRepo();
  useHarnessHome(t, harnessHome);
  git(["config", "core.hooksPath", ".husky"]);
  run("harness-init", "--apply");
  const home = repoHome(dir);
  assert.ok(existsSync(home));

  const dry = run("harness-forget");
  assert.match(dry.stdout, /dry run/);
  assert.match(dry.stdout, /git config core\.hooksPath "\.husky"/);
  assert.match(dry.stdout, /Not removed: what PU has already received/);
  assert.ok(existsSync(home), "a dry run deletes nothing");

  const forgot = run("harness-forget", "--yes");
  assert.equal(forgot.status, 0, forgot.stdout);
  assert.equal(existsSync(home), false);
  assert.equal(setting("core.hooksPath"), ".husky", "core.hooksPath is what it was before enrolment");
  assert.equal(setting("harness.previousHooksPath"), null);
  assert.doesNotMatch(readFileSync(join(harnessHome, "spools.json"), "utf8"), /"metadata_dir"/);
  assert.equal(git(["status", "--porcelain", "--ignored"]).stdout, "");
  assert.match(run("harness-forget").stdout, /nothing to do: this repository is not enrolled/);
});

test("forget --all removes every home, orphans included, and unsets a hooksPath that was unset", (t) => {
  const first = makeRepo();
  useHarnessHome(t, first.harnessHome);
  first.run("harness-init", "--apply");
  // An orphan: a home whose clone has gone.
  const orphan = join(first.harnessHome, "repos", "gone-00000000");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "repo.json"), JSON.stringify({ schema: "harness.repo/v1", repo_dir: join(tmpdir(), "no-such-clone"), enrolled: "2026-10-08T00:00:00Z" }));
  assert.equal(status(checks(first.dir, { pluginRoot: root, claudeVersion: "2.1.285" }), "orphans"), "warn");

  const forgot = first.run("harness-forget", "--all", "--yes");
  assert.equal(forgot.status, 0, forgot.stdout);
  assert.match(forgot.stdout, /forgot 2 repository/);
  assert.deepEqual(readdirSync(join(first.harnessHome, "repos")), []);
  assert.equal(first.setting("core.hooksPath"), null, "it was unset before, so it is unset again");
});

test("stages are found for npm scripts and for a .NET test project", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-stages-"));
  mkdirSync(join(dir, "cli", "Thing.Tests"), { recursive: true });
  writeFileSync(join(dir, "cli", "Thing.Tests", "Thing.Tests.csproj"), "<Project />");
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web", "package.json"), JSON.stringify({ scripts: { build: "next build", lint: "eslint" } }));

  assert.deepEqual(detectStages(dir), [
    { name: "cli-build", run: "dotnet build cli/Thing.Tests --nologo -v q" },
    { name: "cli-test", run: "dotnet test cli/Thing.Tests --no-build --nologo" },
    { name: "web-lint", run: "npm run lint", cwd: "web" },
    { name: "web-build", run: "npm run build", cwd: "web" },
  ]);
});

test("stages run a package.json script with the package manager the repository uses, not always npm", () => {
  const stage = (files: Record<string, string>, pkg: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "harness-pm-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint" }, ...pkg }));
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    return detectStages(dir)[0].run;
  };
  assert.equal(stage({}), "npm run lint", "nothing says otherwise: npm");
  assert.equal(stage({ "pnpm-lock.yaml": "" }), "pnpm run lint");
  assert.equal(stage({ "yarn.lock": "" }), "yarn run lint");
  assert.equal(stage({ "bun.lock": "" }), "bun run lint");
  assert.equal(stage({ "package-lock.json": "{}" }, { packageManager: "pnpm@11.8.0" }), "pnpm run lint", "the packageManager field wins over a stray lock file");

  // A workspace member has no lock file of its own: the root's decides.
  const dir = mkdtempSync(join(tmpdir(), "harness-pm-ws-"));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web", "package.json"), JSON.stringify({ scripts: { build: "next build" } }));
  assert.deepEqual(detectStages(dir), [{ name: "web-build", run: "pnpm run build", cwd: "web" }]);
});

test("an old Claude Code fails the doctor; a missing one only warns", () => {
  const { dir } = makeRepo();
  assert.equal(status(checks(dir, { pluginRoot: root, claudeVersion: "2.1.236 (Claude Code)" }), "claude-code"), "fail");
  assert.equal(status(checks(dir, { pluginRoot: root, claudeVersion: null }), "claude-code"), "warn");
});
