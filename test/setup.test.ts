// harness-doctor and harness-init against throwaway repositories: what doctor finds in a bare one,
// that init's dry run changes nothing, and that --apply leaves a repository doctor passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DENY, checks, detectStages, settingsDiff, type CheckResult } from "../src/lib/setup.ts";
import { root } from "./validators.ts";

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "harness-setup-"));
  const home = join(dir, ".harness-home");
  execFileSync("git", ["init", "-q", dir]);
  mkdirSync(home);
  writeFileSync(join(home, "plugin.json"), JSON.stringify({ root, version: "test" }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint", test: "vitest run", build: "next build", dev: "next dev" } }));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: dir, HARNESS_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  const run = (name: string, ...args: string[]) => spawnSync("node", [join(root, "bin", `${name}.mjs`), ...args], { cwd: dir, env, encoding: "utf8" });
  return { dir, home, run };
}

const status = (results: CheckResult[], name: string): CheckResult["status"] | undefined => results.find((r) => r.name === name)?.status;

test("doctor on a bare repository fails what the Harness needs and says why", () => {
  const { run } = makeRepo();
  const result = run("harness-doctor");

  assert.equal(result.status, 1);
  assert.match(result.stdout, /fail\s+routing-yaml\s+not enrolled: there is no \S+routing\.yaml/);
  assert.match(result.stdout, /warn\s+spool-writable\s+not enrolled/);
  assert.match(result.stdout, /fail\s+git-hooks\s+core\.hooksPath is not set/);
  assert.match(result.stdout, /warn\s+permissions\s+19 deny rule\(s\) missing/);
});

test("init's dry run lists every change and makes none", () => {
  const { dir, run } = makeRepo();
  const result = run("harness-init");

  assert.equal(result.status, 0);
  assert.match(result.stdout, /dry run: nothing is changed/);
  assert.match(result.stdout, /write routing\.yaml \(mode observe; stages: lint, test, build\)/);
  assert.match(result.stdout, /every Claude Code session in this repository/);
  assert.match(result.stdout, /\+ Bash\(gh pr merge\*\)/);
  for (const f of ["routing.yaml", ".gitignore", ".githooks", join(".claude", "settings.json")]) assert.equal(existsSync(join(dir, f)), false, f);
  assert.equal(spawnSync("git", ["-C", dir, "config", "core.hooksPath"]).status, 1);
});

test("init --apply leaves a repository doctor passes, and running it again has nothing to do", (t) => {
  const { dir, home, run } = makeRepo();
  // checks() runs in this process below: point it at the test's plugin.json, never the machine's.
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  t.after(() => (previous === undefined ? delete process.env.HARNESS_HOME : (process.env.HARNESS_HOME = previous)));
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ model: "opus", permissions: { deny: ["Bash(rm -rf*)"] } }));

  const applied = run("harness-init", "--apply");
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);

  const routing = readFileSync(join(dir, "routing.yaml"), "utf8");
  assert.match(routing, /mode: observe/);
  assert.match(routing, /name: test\n\s+run: npm run test/);
  assert.doesNotMatch(routing, /npm run dev/);

  const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.model, "opus", "unrelated settings are kept");
  assert.ok(settings.permissions.deny.includes("Bash(rm -rf*)"), "existing deny rules are kept");
  for (const rule of DENY) assert.ok(settings.permissions.deny.includes(rule), rule);
  assert.equal(settings.attribution.commit, "");
  assert.equal(settings.worktree.baseRef, "head");

  assert.equal(execFileSync("git", ["-C", dir, "config", "core.hooksPath"], { encoding: "utf8" }).trim(), ".githooks");
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /\.harness\/\n\.claude\/state\/\n\/PLAN\.md/);
  assert.match(readFileSync(join(dir, ".gitattributes"), "utf8"), /\.githooks\/\* text eol=lf/);

  const results = checks(dir, { pluginRoot: root, claudeVersion: "2.1.285 (Claude Code)" });
  // init still sets a repository up in the repository itself, the layout from before homes, which the
  // doctor names as a warning. That one goes when init enrols into the home instead (ANY-REPO.md, H2).
  assert.deepEqual(results.filter((r) => r.status !== "pass").map((r) => r.name), ["layout"], JSON.stringify(results, null, 1));

  const again = run("harness-init");
  assert.match(again.stdout, /nothing to do/);
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

test("the settings change is described in words, not as a line diff", () => {
  const lines = settingsDiff({ attribution: { commit: "x" }, permissions: { deny: ["Bash(git reset --hard*)"] } },
    { attribution: { commit: "" }, permissions: { deny: ["Bash(git reset --hard*)", "Bash(gh pr merge*)"] }, worktree: { baseRef: "head" } });
  assert.deepEqual(lines, [
    "permissions.deny gains 1 rule(s):",
    "    + Bash(gh pr merge*)",
    'attribution.commit: "x" -> ""',
    'worktree.baseRef: (not set) -> "head"',
  ]);
});

test("an old Claude Code fails the doctor; a missing one only warns", () => {
  const { dir } = makeRepo();
  assert.equal(status(checks(dir, { pluginRoot: root, claudeVersion: "2.1.236 (Claude Code)" }), "claude-code"), "fail");
  assert.equal(status(checks(dir, { pluginRoot: root, claudeVersion: null }), "claude-code"), "warn");
});
