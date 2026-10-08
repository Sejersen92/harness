// What a repository needs for the Harness to work in it, checked by harness-doctor. Enrolment
// (lib/home.ts) makes the changes that pass these checks for a home; a repository still set up the old
// way, with its files in the repository, is checked the old way until it is enrolled.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, NOT_ENROLLED } from "./config.ts";
import { GIT_DENY, githooksDir, HARNESS_HOOKS, harnessBranches, homeDeny, hooksState, orphans, ownHooks } from "./home.ts";
import { pluginRecordPath } from "./spool.ts";
import { messageOf } from "./types.ts";

/** One doctor check. */
export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

/** The parts of a Claude Code settings file the doctor reads. */
export interface Settings {
  permissions?: { deny?: string[]; [key: string]: unknown };
  attribution?: { commit?: string; [key: string]: unknown };
  worktree?: { baseRef?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export const MIN_CLAUDE_CODE = [2, 1, 284];
export const MIN_NODE = 22;

/**
 * The deny rules a repository set up the old way has in its .claude/settings.json. Edit rules only:
 * Write(path) rules are never matched, and Edit covers every file tool (S9).
 */
export const DENY: readonly string[] = [
  // Agents can't edit their own guardrails: the pass marker, the settings, the git hooks, CI.
  "Edit(.claude/state/**)", "Edit(.claude/settings.json)", "Edit(.githooks/**)", "Edit(.github/workflows/**)",
  ...GIT_DENY,
];

/** What a repository set up the old way ignores, and the hooks it commits. */
export const GITIGNORE = [".harness/", ".claude/state/", "/PLAN.md"];
export const HOOKS = ["harness", ...HARNESS_HOOKS];

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

const version = (text: unknown): number[] => (String(text).match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
const atLeast = (have: readonly number[], want: readonly number[]): boolean => {
  for (let i = 0; i < want.length; i++) if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  return true;
};

type Add = (name: string, status: CheckResult["status"], detail: string) => void;

/** Every check, in the order doctor prints them: { name, status: pass|warn|fail, detail }. */
export function checks(
  dir: string, { pluginRoot, claudeVersion = readClaudeVersion() }: { pluginRoot?: string | null; claudeVersion?: string | null } = {},
): CheckResult[] {
  const config = loadConfig(dir);
  const results: CheckResult[] = [];
  const add: Add = (name, status, detail) => {
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
    add("routing-yaml", "fail", config.reason === NOT_ENROLLED ? `not enrolled: there is no ${join(config.home, "routing.yaml")} (/harness:init enrols the repository)` : "mode is off or not recognised");
  } else {
    const tiers = ["T1", "T2", "T3", "T4"].filter((t) => Number.isInteger(config.tiers?.[t]?.max_score) && typeof config.tiers?.[t]?.model === "string");
    if (tiers.length < 4) add("routing-yaml", "fail", `tiers ${["T1", "T2", "T3", "T4"].filter((t) => !tiers.includes(t)).join(", ")} are missing or malformed`);
    else if (!config.stages.length) add("routing-yaml", "fail", `eval.stages is empty in ${config.layout.routingYaml}, so no eval can pass and no commit can be made`);
    else add("routing-yaml", "pass", `mode ${config.mode}, ${config.stages.length} eval stage(s)`);
  }

  if (config.layout?.kind === "home") add("layout", "pass", `nothing in the repository; its files are in ${config.layout.root}`);
  else if (config.layout) add("layout", "warn", `routing.yaml is in the repository, the layout from before homes; it still works, and /harness:init moves it to ${config.home}`);

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

  if (config.layout?.kind === "home") homeChecks(dir, config.layout.root, add);
  else if (config.layout) repositoryChecks(dir, add);

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

  const lost = orphans();
  add("orphans", lost.length ? "warn" : "pass",
    lost.length ? `${lost.length} home(s) whose clone is gone: ${lost.join(", ")} (harness-forget --all, or per clone, removes them)` : "every home has its clone");

  return results;
}

/** A home's hooks and settings, as enrolment leaves them. */
function homeChecks(dir: string, home: string, add: Add): void {
  const hooks = hooksState(dir, home);
  const folder = githooksDir(home);
  const own = ownHooks(dir, hooks.previous);
  const missing = ["harness", ...HARNESS_HOOKS, ...own].filter((h) => !existsSync(join(folder, h)));
  if (!hooks.ours) {
    add("git-hooks", "fail", `core.hooksPath is ${hooks.current ? `"${hooks.current}"` : "not set"}, not ${folder}: commits made outside Claude Code are not gated (something, such as husky's install, may have changed it; /harness:init puts it back)`);
  } else if (missing.length) {
    add("git-hooks", "fail", `${folder} is missing ${missing.join(", ")} (/harness:init writes them)`);
  } else {
    const branches = harnessBranches(home);
    add("git-hooks", "pass", `${HARNESS_HOOKS.join(", ")}${own.length ? `, then the repository's own ${own.join(", ")}` : ""}; commits are gated on ${branches.length ? branches.join(", ") : "no branch yet (pu harness marks the one it starts on)"}`);
  }

  const settings = readJson<Settings>(join(home, "settings.json")) ?? {};
  const denied = new Set(settings.permissions?.deny ?? []);
  const missingDeny = homeDeny(home).filter((rule) => !denied.has(rule));
  add("permissions", missingDeny.length ? "warn" : "pass",
    missingDeny.length ? `${missingDeny.length} deny rule(s) missing from ${join(home, "settings.json")} (/harness:init writes them)` : `${denied.size} deny rules for Harness sessions, in ${join(home, "settings.json")}`);
  add("worktree-base", settings.worktree?.baseRef === "head" ? "pass" : "warn",
    settings.worktree?.baseRef === "head" ? "worktrees start from HEAD" : "worktree.baseRef is not \"head\" in the home's settings (needed only for parallel groups, M6)");
}

/** A repository set up the old way: committed hooks, a .gitignore block and .claude/settings.json. */
function repositoryChecks(dir: string, add: Add): void {
  const hooksPath = git(dir, "config", "core.hooksPath");
  const missingHooks = HOOKS.filter((h) => !existsSync(join(dir, ".githooks", h)));
  if (hooksPath !== ".githooks") add("git-hooks", "fail", `core.hooksPath is ${hooksPath ? `"${hooksPath}"` : "not set"}: commits made outside Claude Code are not gated`);
  else if (missingHooks.length) add("git-hooks", "fail", `.githooks is missing ${missingHooks.join(", ")}`);
  else add("git-hooks", "pass", "pre-commit, commit-msg and post-commit are on");

  const notIgnored = GITIGNORE.filter((p) => git(dir, "check-ignore", "-q", "--no-index", p.replace(/^\//, "").replace(/\/$/, "/x")) === null);
  add("gitignore", notIgnored.length ? "warn" : "pass", notIgnored.length ? `not ignored: ${notIgnored.join(", ")}` : GITIGNORE.join(", "));

  const settings = readJson<Settings>(join(dir, ".claude", "settings.json")) ?? {};
  add("attribution-off", settings.attribution?.commit === "" ? "pass" : "warn",
    settings.attribution?.commit === "" ? "Claude Code adds no attribution to commits" : "attribution.commit is not \"\" in .claude/settings.json; the commit-msg hook strips it anyway");

  const denied = new Set(settings.permissions?.deny ?? []);
  const missingDeny = DENY.filter((rule) => !denied.has(rule));
  add("permissions", missingDeny.length ? "warn" : "pass",
    missingDeny.length ? `${missingDeny.length} deny rule(s) missing, e.g. ${missingDeny.slice(0, 2).join(", ")}` : `all ${DENY.length} deny rules are in place`);

  add("worktree-base", settings.worktree?.baseRef === "head" ? "pass" : "warn",
    settings.worktree?.baseRef === "head" ? "worktrees start from HEAD" : "worktree.baseRef is not \"head\" (needed only for parallel groups, M6)");
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
