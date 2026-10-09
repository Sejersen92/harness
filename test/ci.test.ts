// The eval in CI (C1): harness-eval --ci --config runs the stages in a file the repository commits, with
// no home and no routing.yaml; harness-init --ci writes that file and the workflow, never over one that
// exists, and remembers a no; the doctor warns when the two copies of the stages drift apart.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { CI_CONFIG, CI_WORKFLOW, ciConfigText, ciWorkflowText, readCiStages, sameStages } from "../src/lib/ci.ts";
import { repoHome } from "../src/lib/config.ts";
import { checks } from "../src/lib/setup.ts";
import type { Stage } from "../src/lib/types.ts";
import { root } from "./validators.ts";

const ok = (name: string): Stage => ({ name, run: `node -e "process.exit(0)"` });
const failing = (name: string, text: string): Stage => ({ name, run: `node -e "console.log('${text}'); process.exit(1)"` });

/** A repository with one commit and a package.json whose scripts enrolment turns into stages, plus a scratch ~/.harness. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "harness-ci-"));
  const harnessHome = mkdtempSync(join(tmpdir(), "harness-ci-home-"));
  writeFileSync(join(harnessHome, "plugin.json"), JSON.stringify({ root, version: "test" }));
  const env: NodeJS.ProcessEnv = {
    ...process.env, CLAUDE_PROJECT_DIR: dir, HARNESS_HOME: harnessHome,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, "-c", "core.autocrlf=false", ...args], { env, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "node build.mjs" } }));
  writeFileSync(join(dir, "package-lock.json"), "{}");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const run = (name: string, ...args: string[]) => spawnSync("node", [join(root, "bin", `${name}.mjs`), ...args], { cwd: dir, env, encoding: "utf8" });
  return { dir, harnessHome, git, run };
}

function useHarnessHome(t: TestContext, harnessHome: string): void {
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = harnessHome;
  t.after(() => (previous === undefined ? delete process.env.HARNESS_HOME : (process.env.HARNESS_HOME = previous)));
}

const writeCiConfig = (dir: string, stages: Stage[]): void => {
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, CI_CONFIG), ciConfigText(stages));
};

// harness-eval --ci --config

test("--ci --config runs the file's stages in a repository with no home and no routing.yaml", () => {
  const { dir, run } = makeRepo();
  writeCiConfig(dir, [ok("build"), ok("test")]);

  const result = run("harness-eval", "--ci", "--config", CI_CONFIG);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /2 stage\(s\) for the checkout \(ci, stages from \.github\/harness-eval\.yml\)/);
  assert.match(result.stdout, /pass\s+build/);
  assert.match(result.stdout, /PASS \(ci, no marker written\)/);
  assert.equal(existsSync(join(dir, ".claude")), false, "no marker, and nothing written into the checkout");
  assert.equal(existsSync(join(dir, ".harness")), false);
});

test("--ci --config fails on a failing stage and prints its last lines", () => {
  const { dir, run } = makeRepo();
  writeCiConfig(dir, [ok("build"), failing("test", "boom at line 3"), ok("lint")]);

  const result = run("harness-eval", "--ci", "--config", CI_CONFIG);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /fail\s+test/);
  assert.match(result.stdout, /skipped\s+lint/);
  assert.match(result.stdout, /boom at line 3/);
  assert.match(result.stdout, /FAIL at test/);
});

test("--config is refused without --ci, with no path, and for a missing or stage-less file", () => {
  const { dir, run } = makeRepo();
  writeCiConfig(dir, [ok("build")]);

  const local = run("harness-eval", "--config", CI_CONFIG);
  assert.equal(local.status, 2);
  assert.match(local.stdout, /--config goes only with --ci/);

  const noPath = run("harness-eval", "--ci", "--config");
  assert.equal(noPath.status, 2);
  assert.match(noPath.stdout, /--config needs the path/);

  const missing = run("harness-eval", "--ci", "--config", ".github/nope.yml");
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /there is no .*nope\.yml/);

  writeFileSync(join(dir, CI_CONFIG), "eval:\n  stages: []\n");
  const empty = run("harness-eval", "--ci", "--config", CI_CONFIG);
  assert.equal(empty.status, 2);
  assert.match(empty.stdout, /\.github\/harness-eval\.yml has no eval\.stages/);
});

// harness-init --ci

test("init --ci in a repository that isn't enrolled stops: there are no stages to copy", () => {
  const { run } = makeRepo();
  const result = run("harness-init", "--ci");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /is not enrolled/);
});

test("init --ci: the dry run says missing and changes nothing; --apply writes both files with the home's stages", (t) => {
  const { dir, harnessHome, git, run } = makeRepo();
  useHarnessHome(t, harnessHome);
  assert.equal(run("harness-init", "--apply").status, 0);

  const dry = run("harness-init", "--ci");
  assert.equal(dry.status, 0, dry.stdout);
  assert.match(dry.stdout, /^ {2}ci: missing$/m);
  assert.match(dry.stdout, /write \.github\/harness-eval\.yml \(stages: test, build\)/);
  assert.match(dry.stdout, /write \.github\/workflows\/harness-eval\.yml/);
  assert.equal(git("status", "--porcelain").stdout, "", "a dry run writes nothing");

  const applied = run("harness-init", "--ci", "--apply");
  assert.equal(applied.status, 0, applied.stdout);
  const read = readCiStages(join(dir, CI_CONFIG));
  assert.ok("stages" in read);
  assert.deepEqual(read.stages.map((s) => s.run), ["npm run test", "npm run build"]);

  const workflow = parse(readFileSync(join(dir, CI_WORKFLOW), "utf8")) as { jobs: { eval: { steps: Record<string, unknown>[] } } };
  const steps = workflow.jobs.eval.steps;
  assert.ok(steps.some((s) => (s.with as Record<string, unknown> | undefined)?.repository === "Sejersen92/harness"));
  assert.ok(!JSON.stringify(steps).includes("token"), "the Harness is public: no token");
  assert.ok(steps.some((s) => s.run === "npm ci"));
  assert.equal(steps.at(-1)?.run, "node .harness-plugin/bin/harness-eval.mjs --ci --config .github/harness-eval.yml");

  // Nothing committed: pu harness commits them on its branch.
  assert.match(git("status", "--porcelain").stdout, /\?\? \.github\//);

  const again = run("harness-init", "--ci");
  assert.match(again.stdout, /^ {2}ci: present$/m);
  assert.match(again.stdout, /nothing to do/);
});

test("init --ci never overwrites a file that exists: with one of the two, it is partial and writes only the other", (t) => {
  const { dir, harnessHome, run } = makeRepo();
  useHarnessHome(t, harnessHome);
  run("harness-init", "--apply");
  writeCiConfig(dir, [ok("mine")]);

  const applied = run("harness-init", "--ci", "--apply");

  assert.match(applied.stdout, /^ {2}ci: partial$/m);
  assert.doesNotMatch(applied.stdout, /write \.github\/harness-eval\.yml/);
  assert.match(readFileSync(join(dir, CI_CONFIG), "utf8"), /name: mine/);
  assert.ok(existsSync(join(dir, CI_WORKFLOW)));
});

test("init --ci --decline records the no in repo.json, and the state reads declined until a file appears", (t) => {
  const { dir, harnessHome, git, run } = makeRepo();
  useHarnessHome(t, harnessHome);
  run("harness-init", "--apply");

  const declined = run("harness-init", "--ci", "--decline");
  assert.equal(declined.status, 0, declined.stdout);
  assert.match(JSON.parse(readFileSync(join(repoHome(dir), "repo.json"), "utf8")).ci_declined, /^\d{4}-\d\d-\d\dT/);
  assert.equal(git("status", "--porcelain").stdout, "", "declining writes nothing into the repository");

  assert.match(run("harness-init", "--ci").stdout, /^ {2}ci: declined$/m);

  // A no isn't a lock: --apply still writes them.
  run("harness-init", "--ci", "--apply");
  assert.match(run("harness-init", "--ci").stdout, /^ {2}ci: present$/m);
});

// The workflow's toolchain, from the stages.

test("the workflow sets up .NET only for a dotnet stage, and installs npm dependencies where npm runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-ci-wf-"));
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web", "package-lock.json"), "{}");
  const text = ciWorkflowText(dir, [
    { name: "cli-build", run: "dotnet build cli --nologo" },
    { name: "web-lint", run: "npm run lint", cwd: "web" },
    { name: "web-test", run: "npm run test", cwd: "web" },
    { name: "docs", run: "npm run docs", cwd: "docs" },
  ]);
  const steps = (parse(text) as { jobs: { eval: { steps: Record<string, unknown>[] } } }).jobs.eval.steps;

  assert.ok(steps.some((s) => s.uses === "actions/setup-dotnet@v4"));
  assert.deepEqual(steps.filter((s) => String(s.name ?? "").startsWith("Install")).map((s) => [s.run, s["working-directory"]]),
    [["npm ci", "web"], ["npm install", "docs"]], "npm ci where there is a lock file, npm install where there isn't, once per folder");

  const plain = ciWorkflowText(dir, [ok("build")]);
  assert.doesNotMatch(plain, /setup-dotnet|Install dependencies/);
});

test("the workflow sets up and installs with the package manager a stage runs: pnpm, yarn, bun", () => {
  const workflow = (dir: string, stages: Stage[]) =>
    (parse(ciWorkflowText(dir, stages)) as { jobs: { eval: { steps: Record<string, unknown>[] } } }).jobs.eval.steps;
  const installs = (steps: Record<string, unknown>[]) => steps.filter((s) => String(s.name ?? "").startsWith("Install")).map((s) => s.run);

  // pnpm with a packageManager field: action-setup reads the version from it, before setup-node.
  const pnpm = mkdtempSync(join(tmpdir(), "harness-ci-pnpm-"));
  writeFileSync(join(pnpm, "package.json"), JSON.stringify({ packageManager: "pnpm@11.8.0" }));
  writeFileSync(join(pnpm, "pnpm-lock.yaml"), "");
  const steps = workflow(pnpm, [{ name: "lint", run: "pnpm run lint" }, { name: "build", run: "pnpm build" }]);
  const setup = steps.findIndex((s) => s.uses === "pnpm/action-setup@v4");
  assert.ok(setup >= 0 && setup < steps.findIndex((s) => s.uses === "actions/setup-node@v4"), "pnpm is set up before Node");
  assert.equal(steps[setup].with, undefined, "the version comes from packageManager");
  assert.deepEqual(installs(steps), ["pnpm install --frozen-lockfile"], "once for the folder, locked");
  assert.doesNotMatch(JSON.stringify(steps), /(?<!p)npm (ci|install)/);

  // pnpm with no field and no lock file: told the latest, installed unlocked.
  const loose = mkdtempSync(join(tmpdir(), "harness-ci-pnpm-loose-"));
  const looseSteps = workflow(loose, [{ name: "build", run: "pnpm run build" }]);
  assert.deepEqual(looseSteps.find((s) => s.uses === "pnpm/action-setup@v4")?.with, { version: "latest" });
  assert.deepEqual(installs(looseSteps), ["pnpm install"]);

  // A pnpm workspace member: the root's lock file makes it a locked install, in the member's folder.
  mkdirSync(join(pnpm, "web"));
  const member = workflow(pnpm, [{ name: "web-build", run: "pnpm run build", cwd: "web" }]);
  assert.deepEqual(member.filter((s) => s.name === "Install dependencies (web)").map((s) => [s.run, s["working-directory"]]), [["pnpm install --frozen-lockfile", "web"]]);

  const yarn = mkdtempSync(join(tmpdir(), "harness-ci-yarn-"));
  writeFileSync(join(yarn, "yarn.lock"), "");
  const yarnSteps = workflow(yarn, [{ name: "test", run: "yarn run test" }]);
  assert.ok(yarnSteps.some((s) => s.run === "corepack enable"));
  assert.deepEqual(installs(yarnSteps), ["yarn install --frozen-lockfile"]);

  const bun = mkdtempSync(join(tmpdir(), "harness-ci-bun-"));
  writeFileSync(join(bun, "bun.lock"), "");
  const bunSteps = workflow(bun, [{ name: "test", run: "bun run test" }]);
  assert.ok(bunSteps.some((s) => s.uses === "oven-sh/setup-bun@v2"));
  assert.deepEqual(installs(bunSteps), ["bun install --frozen-lockfile"]);
});

// The doctor.

test("doctor: the same stages in both places pass; different ones warn; a workflow without its stage file warns", (t) => {
  const { dir, harnessHome, run } = makeRepo();
  useHarnessHome(t, harnessHome);
  run("harness-init", "--apply");
  const ci = () => checks(dir, { pluginRoot: root, claudeVersion: "2.1.300" }).find((r) => r.name === "ci");

  assert.equal(ci(), undefined, "no CI files, no ci line");

  run("harness-init", "--ci", "--apply");
  assert.equal(ci()?.status, "pass");

  writeCiConfig(dir, [{ name: "test", run: "npm run test" }]);
  assert.equal(ci()?.status, "warn");
  assert.match(ci()!.detail, /differ/);

  writeFileSync(join(dir, CI_CONFIG), "not: stages\n");
  assert.equal(ci()?.status, "warn");
  assert.match(ci()!.detail, /has no eval\.stages list/);
});

test("sameStages compares what runs, not how the YAML was written", () => {
  const a: Stage[] = [{ name: "build", run: "npm run build", cwd: "web" }];
  assert.ok(sameStages(a, [{ cwd: "web", run: "npm run build", name: "build" }]));
  assert.ok(!sameStages(a, [{ name: "build", run: "npm run build" }]));
  assert.ok(!sameStages(a, [...a, ok("test")]));
});
