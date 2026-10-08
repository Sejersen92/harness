// What a repository needs for the Harness to work in it, as checks (harness-doctor) and as the changes
// that would make those checks pass (harness-init). One list, so init never sets up something doctor
// doesn't check, and doctor never asks for something init can't do.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { loadConfig, NOT_ENROLLED } from "./config.ts";
import { pluginRecordPath } from "./spool.ts";
import { messageOf } from "./types.ts";

/** One doctor check. */
export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

/** One change init would make: what it is, in words, and the function that makes it. */
export interface InitStep {
  what: string;
  apply: () => void;
}

/** The parts of a Claude Code settings file init and the doctor read. Everything else is kept as it is. */
export interface Settings {
  permissions?: { deny?: string[]; [key: string]: unknown };
  attribution?: { commit?: string; [key: string]: unknown };
  worktree?: { baseRef?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export const MIN_CLAUDE_CODE = [2, 1, 284];
export const MIN_NODE = 22;

/**
 * The permission rules init merges into .claude/settings.json (S7: a plugin can't ship them). The
 * source design's deny list, minus its Vercel and Azure rules, which belong to repositories that use
 * them. These apply to every Claude Code session in the repository, not only the Harness's.
 */
export const DENY = [
  // Agents can't edit their own guardrails: the pass marker, the settings, the git hooks, CI.
  "Edit(.claude/state/**)", "Write(.claude/state/**)",
  "Edit(.claude/settings.json)",
  "Edit(.githooks/**)", "Write(.githooks/**)",
  "Edit(.github/workflows/**)",
  // Nothing skips the gate, or builds a commit around it (C2).
  "Bash(git commit --no-verify*)", "Bash(git commit * --no-verify*)", "Bash(git commit -n*)",
  "Bash(git commit-tree*)", "Bash(git * commit-tree*)",
  // No history rewrites and no merges to main from an agent: those stay human actions.
  "Bash(git push --force*)", "Bash(git push * --force*)", "Bash(git push * main*)",
  "Bash(git reset --hard*)",
  "Bash(gh pr merge*)", "Bash(gh release*)", "Bash(gh repo delete*)", "Bash(gh secret*)",
];

export const GITIGNORE = [".harness/", ".claude/state/", "/PLAN.md"];
export const HOOKS = ["harness", "pre-commit", "commit-msg", "post-commit"];

const git = (dir: string, ...args: string[]): string | null => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

const settingsPath = (dir: string): string => join(dir, ".claude", "settings.json");
const version = (text: unknown): number[] => (String(text).match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
const atLeast = (have: readonly number[], want: readonly number[]): boolean => {
  for (let i = 0; i < want.length; i++) if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  return true;
};

// ---- checks ---------------------------------------------------------------------------------

/** Every check, in the order doctor prints them: { name, status: pass|warn|fail, detail }. */
export function checks(
  dir: string, { pluginRoot, claudeVersion = readClaudeVersion() }: { pluginRoot?: string | null; claudeVersion?: string | null } = {},
): CheckResult[] {
  const config = loadConfig(dir);
  const results: CheckResult[] = [];
  const add = (name: string, status: CheckResult["status"], detail: string): void => {
    results.push({ name, status, detail });
  };

  const node = version(process.versions.node);
  add("node", atLeast(node, [MIN_NODE]) ? "pass" : "fail", `Node ${process.versions.node} (needs ${MIN_NODE}+)`);

  if (!claudeVersion) add("claude-code", "warn", "the claude CLI is not on PATH, so its version can't be checked");
  else add("claude-code", atLeast(version(claudeVersion), MIN_CLAUDE_CODE) ? "pass" : "fail", `Claude Code ${claudeVersion} (needs ${MIN_CLAUDE_CODE.join(".")}+)`);

  const recorded = readJson<{ root?: string; version?: string }>(pluginRecordPath());
  if (!recorded?.root) add("plugin-recorded", "fail", `${pluginRecordPath()} is missing: start Claude Code once with the plugin so git hooks can find it`);
  else if (!existsSync(join(recorded.root, "bin", "harness-git-hook.mjs"))) add("plugin-recorded", "fail", `${pluginRecordPath()} points at ${recorded.root}, which has no bin/harness-git-hook.mjs`);
  else if (pluginRoot && realpathSync.native(recorded.root).toLowerCase() !== realpathSync.native(pluginRoot).toLowerCase()) add("plugin-recorded", "warn", `git hooks use ${recorded.root}, not this copy (${pluginRoot})`);
  else add("plugin-recorded", "pass", `git hooks use ${recorded.root} (${recorded.version})`);

  if (config.mode === "off") {
    add("routing-yaml", "fail", config.reason === NOT_ENROLLED ? `not enrolled: there is no ${join(config.home, "routing.yaml")} (harness-init sets one up)` : "mode is off or not recognised");
  } else {
    const tiers = ["T1", "T2", "T3", "T4"].filter((t) => Number.isInteger(config.tiers?.[t]?.max_score) && typeof config.tiers?.[t]?.model === "string");
    if (tiers.length < 4) add("routing-yaml", "fail", `tiers ${["T1", "T2", "T3", "T4"].filter((t) => !tiers.includes(t)).join(", ")} are missing or malformed`);
    else if (!config.stages.length) add("routing-yaml", "fail", "eval.stages is empty, so no eval can pass and no commit can be made");
    else add("routing-yaml", "pass", `mode ${config.mode}, ${config.stages.length} eval stage(s)`);
  }

  if (config.layout?.kind === "home") add("layout", "pass", `nothing in the repository; its files are in ${config.layout.root}`);
  else if (config.layout) add("layout", "warn", `routing.yaml is in the repository, the layout from before homes; it still works, and enrolling moves it to ${config.home}`);

  // Probed only where a spool belongs. Not enrolled, there is none yet, and creating one would put a
  // folder in a repository that has asked for nothing.
  if (!config.metadataDir) add("spool-writable", "warn", "not enrolled, so there is no spool yet");
  else {
    try {
      mkdirSync(config.metadataDir, { recursive: true });
      const probe = join(config.metadataDir, `.doctor-${process.pid}`);
      writeFileSync(probe, "");
      rmSync(probe);
      add("spool-writable", "pass", config.metadataDir);
    } catch (error) {
      add("spool-writable", "fail", messageOf(error));
    }
  }

  const hooksPath = git(dir, "config", "core.hooksPath");
  const missingHooks = HOOKS.filter((h) => !existsSync(join(dir, ".githooks", h)));
  if (hooksPath !== ".githooks") add("git-hooks", "fail", `core.hooksPath is ${hooksPath ? `"${hooksPath}"` : "not set"}: commits made outside Claude Code are not gated`);
  else if (missingHooks.length) add("git-hooks", "fail", `.githooks is missing ${missingHooks.join(", ")}`);
  else add("git-hooks", "pass", "pre-commit, commit-msg and post-commit are on");

  const notIgnored = GITIGNORE.filter((p) => git(dir, "check-ignore", "-q", "--no-index", p.replace(/^\//, "").replace(/\/$/, "/x")) === null);
  add("gitignore", notIgnored.length ? "warn" : "pass", notIgnored.length ? `not ignored: ${notIgnored.join(", ")}` : GITIGNORE.join(", "));

  const settings = readJson<Settings>(settingsPath(dir)) ?? {};
  add("attribution-off", settings.attribution?.commit === "" ? "pass" : "warn",
    settings.attribution?.commit === "" ? "Claude Code adds no attribution to commits" : "attribution.commit is not \"\" in .claude/settings.json; the commit-msg hook strips it anyway");

  const denied = new Set(settings.permissions?.deny ?? []);
  const missingDeny = DENY.filter((rule) => !denied.has(rule));
  add("permissions", missingDeny.length ? "warn" : "pass",
    missingDeny.length ? `${missingDeny.length} deny rule(s) missing, e.g. ${missingDeny.slice(0, 2).join(", ")}` : `all ${DENY.length} deny rules are in place`);

  add("worktree-base", settings.worktree?.baseRef === "head" ? "pass" : "warn",
    settings.worktree?.baseRef === "head" ? "worktrees start from HEAD" : "worktree.baseRef is not \"head\" (needed only for parallel groups, M6)");

  try {
    // resolve() first: git reports C:/src/x, the disk C:\src\x, and only the letters' case is the question.
    const spelled = resolve(dir);
    const real = realpathSync.native(spelled);
    if (real === spelled) add("path-casing", "pass", spelled);
    else if (real.toLowerCase() === spelled.toLowerCase()) add("path-casing", "warn", `the working directory is spelled ${spelled}, the disk says ${real}; Claude Code refused a worktree for this (S6)`);
    else add("path-casing", "pass", `${spelled} (reached through a link to ${real})`);
  } catch (error) {
    add("path-casing", "warn", messageOf(error));
  }

  const failures = Number.parseInt(readSafely(join(config.metadataDir ?? config.home, "emit-failures")), 10) || 0;
  add("emit-failures", failures ? "warn" : "pass", failures ? `${failures} metadata write(s) failed; see stderr from the hooks` : "none");

  return results;
}

function readSafely(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function readClaudeVersion(): string | null {
  try {
    return execFileSync("claude", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000, shell: process.platform === "win32" }).trim();
  } catch {
    return null;
  }
}

// ---- init -----------------------------------------------------------------------------------

/** Eval stages for a new routing.yaml, from what the repository has: npm scripts and .NET projects. */
export function detectStages(dir: string): { name: string; run: string; cwd?: string }[] {
  const stages: { name: string; run: string; cwd?: string }[] = [];
  const shallow = [".", ...readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name)];

  for (const sub of shallow) {
    const root = join(dir, sub);
    // A solution if there is one; else a *.Tests project, whose build builds what it tests.
    const solution = readdirSync(root).filter((f) => /\.(sln|slnx)$/.test(f))[0];
    const testProject = solution ? null : readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /\.Tests?$/.test(e.name) && readdirSync(join(root, e.name)).some((f) => f.endsWith(".csproj")))
      .map((e) => e.name)[0];
    const dotnet = solution ?? testProject;
    if (dotnet) {
      const where = sub === "." ? dotnet : `${sub}/${dotnet}`;
      stages.push({ name: `${sub === "." ? "" : `${sub}-`}build`, run: `dotnet build ${where} --nologo -v q` });
      stages.push({ name: `${sub === "." ? "" : `${sub}-`}test`, run: `dotnet test ${where} --no-build --nologo` });
    }
    const pkg = readJson<{ scripts?: Record<string, string> }>(join(root, "package.json"));
    for (const script of ["lint", "test", "build"]) {
      if (!pkg?.scripts?.[script]) continue;
      stages.push({ name: `${sub === "." ? "" : `${sub}-`}${script}`.replace(/^-/, ""), run: `npm run ${script}`, ...(sub === "." ? {} : { cwd: sub }) });
    }
  }
  return stages;
}

/**
 * What init would change, without changing it: [{ what, apply }], plus the settings file before and
 * after so the person can see the diff first (S7). Each step leaves what is already right alone.
 */
export function initPlan(dir: string, pluginRoot: string): { steps: InitStep[]; settingsBefore: Settings; settingsAfter: Settings } {
  const steps: InitStep[] = [];

  if (!existsSync(join(dir, "routing.yaml"))) {
    const template = readFileSync(join(pluginRoot, "templates", "routing.yaml"), "utf8");
    const stages = detectStages(dir);
    const block = stages.length
      ? `  stages:\n${stringify(stages, { flow: false }).split("\n").filter(Boolean).map((l) => `    ${l}`).join("\n")}`
      : "  stages: []             # none detected: add the build and test commands this repository uses";
    const text = template.replace(/^ {2}stages: \[\].*$/m, block);
    steps.push({ what: `write routing.yaml (mode observe; stages: ${stages.map((s) => s.name).join(", ") || "none detected"})`, apply: () => writeFileSync(join(dir, "routing.yaml"), text) });
  }

  const gitignorePath = join(dir, ".gitignore");
  const ignored = readSafely(gitignorePath);
  const missing = GITIGNORE.filter((p) => !ignored.split(/\r?\n/).includes(p));
  if (missing.length) {
    steps.push({
      what: `add ${missing.join(", ")} to .gitignore`,
      apply: () => writeFileSync(gitignorePath, `${ignored}${ignored && !ignored.endsWith("\n") ? "\n" : ""}# The Harness: its metadata spool, the eval pass marker, and the orchestrator's plan.\n${missing.join("\n")}\n`),
    });
  }

  const attributes = readSafely(join(dir, ".gitattributes"));
  if (!/^\.githooks\/\*\s+text\s+eol=lf/m.test(attributes)) {
    steps.push({
      what: "keep .githooks/* LF in .gitattributes (a CRLF #! line breaks a hook on Windows)",
      apply: () => writeFileSync(join(dir, ".gitattributes"), `${attributes}${attributes && !attributes.endsWith("\n") ? "\n" : ""}.githooks/* text eol=lf\n`),
    });
  }

  const staleHooks = HOOKS.filter((h) => readSafely(join(dir, ".githooks", h)) !== readSafely(join(pluginRoot, "templates", "githooks", h)));
  if (staleHooks.length) {
    steps.push({
      what: `install .githooks/${staleHooks.join(", .githooks/")}`,
      apply: () => {
        mkdirSync(join(dir, ".githooks"), { recursive: true });
        for (const h of staleHooks) {
          copyFileSync(join(pluginRoot, "templates", "githooks", h), join(dir, ".githooks", h));
          chmodSync(join(dir, ".githooks", h), 0o755);
        }
      },
    });
  }

  if (git(dir, "config", "core.hooksPath") !== ".githooks") {
    steps.push({ what: "git config core.hooksPath .githooks (this clone)", apply: () => execFileSync("git", ["-C", dir, "config", "core.hooksPath", ".githooks"]) });
  }

  const before = readJson<Settings>(settingsPath(dir)) ?? {};
  const after = structuredClone(before);
  after.permissions ??= {};
  after.permissions.deny = [...new Set([...(after.permissions.deny ?? []), ...DENY])];
  after.attribution = { ...(after.attribution ?? {}), commit: "" };
  after.worktree = { ...(after.worktree ?? {}), baseRef: "head" };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    steps.push({
      what: ".claude/settings.json: the deny rules, attribution.commit \"\", worktree.baseRef \"head\"",
      apply: () => {
        mkdirSync(join(dir, ".claude"), { recursive: true });
        writeFileSync(settingsPath(dir), JSON.stringify(after, null, 2) + "\n");
      },
    });
  }

  return { steps, settingsBefore: before, settingsAfter: after };
}

/**
 * The settings change in words, for a person to read before it is written: the deny rules added, and
 * each setting that changes from what to what. Init only ever adds rules and sets these two values, so
 * that is the whole change; nothing else in the file is touched.
 */
export function settingsDiff(before: Settings, after: Settings): string[] {
  const lines: string[] = [];
  const had = new Set(before.permissions?.deny ?? []);
  const added = (after.permissions?.deny ?? []).filter((rule) => !had.has(rule));
  if (added.length) lines.push(`permissions.deny gains ${added.length} rule(s):`, ...added.map((rule) => `    + ${rule}`));
  const shown = (value: unknown): string => (value === undefined ? "(not set)" : JSON.stringify(value));
  const changes: [string, unknown, unknown][] = [
    ["attribution.commit", before.attribution?.commit, after.attribution?.commit],
    ["worktree.baseRef", before.worktree?.baseRef, after.worktree?.baseRef],
  ];
  for (const [label, from, to] of changes) {
    if (from !== to) lines.push(`${label}: ${shown(from)} -> ${shown(to)}`);
  }
  return lines;
}
