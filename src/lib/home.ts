// A repository's home (ANY-REPO.md, H2): enrolling sets one up, forgetting removes it, and neither
// touches the repository's working tree. Outside the home, the only change is two keys in the clone's
// own .git/config: core.hooksPath, pointed at the home's hooks, and harness.previousHooksPath, which
// remembers where core.hooksPath pointed before. The dispatcher reads it to run the repository's own
// hooks after the Harness's, and forget puts it back.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { stringify } from "yaml";
import { harnessHome, normalisedPath, repoHome } from "./config.ts";
import { utcNow } from "./ids.ts";
import { registerSpool, registryPath, unregisterSpool } from "./spool.ts";

/** One change enrol or forget would make: what it is, in words, and the function that makes it. */
export interface Step {
  what: string;
  apply: () => void;
}

/** <home>/repo.json: which clone a home belongs to, so a home can be listed and forgotten by name. */
export interface RepoRecord {
  schema: "harness.repo/v1";
  repo_dir: string;
  enrolled: string;
}

/** The three hooks the Harness has a step of its own in. */
export const HARNESS_HOOKS = ["pre-commit", "commit-msg", "post-commit"] as const;

/**
 * Every client-side hook git runs. A repository's own hook is chained only when its name is here, so a
 * helper file in a hooks folder (husky's `h`, a README) is never mistaken for one.
 */
export const GIT_HOOKS: readonly string[] = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg",
  "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-auto-gc", "post-rewrite",
  "sendemail-validate", "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist",
  "p4-pre-submit", "post-index-change", "reference-transaction",
];

/** The git rules every Harness session runs under, wherever its files are (C2 and D-rules in DESIGN.md). */
export const GIT_DENY: readonly string[] = [
  // Nothing skips the gate, or builds a commit around it (C2).
  "Bash(git commit --no-verify*)", "Bash(git commit * --no-verify*)", "Bash(git commit -n*)",
  "Bash(git commit-tree*)", "Bash(git * commit-tree*)",
  // No history rewrites and no merges to main from an agent: those stay human actions.
  "Bash(git push --force*)", "Bash(git push * --force*)", "Bash(git push * main*)",
  "Bash(git reset --hard*)",
  "Bash(gh pr merge*)", "Bash(gh release*)", "Bash(gh repo delete*)", "Bash(gh secret*)",
];

export const githooksDir = (home: string): string => join(home, "githooks");

/** A path as git config and a shell want it on every platform: absolute, with forward slashes. */
const forward = (path: string): string => path.replace(/\\/g, "/");

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

const readSafely = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/**
 * A permission rule's path for a folder: ~/... under the person's home folder (the form spike S9 proved
 * in --settings rules), else //<absolute path>.
 */
export function rulePath(folder: string): string {
  const inHome = relative(homedir(), folder);
  return inHome && !inHome.startsWith("..") && !isAbsolute(inHome) ? `~/${forward(inHome)}` : `//${forward(folder).replace(/^\/+/, "")}`;
}

/**
 * The deny rules a home's Harness sessions run under, passed by `pu harness` as `claude --settings`.
 * Edit rules only: S9 showed Write(path) rules are never matched and Edit rules cover every file tool.
 * The plan stays writable, because the orchestrator writes it.
 */
export function homeDeny(home: string): string[] {
  const h = rulePath(home);
  return [
    `Edit(${h}/state/**)`, `Edit(${h}/routing.yaml)`, `Edit(${h}/settings.json)`, `Edit(${h}/repo.json)`, `Edit(${h}/githooks/**)`,
    "Edit(.github/workflows/**)",
    ...GIT_DENY,
  ];
}

/** <home>/settings.json as it should be. */
export const homeSettings = (home: string): { permissions: { deny: string[] }; worktree: { baseRef: string } } => ({
  permissions: { deny: homeDeny(home) },
  // Worktree subagents start from the current branch, not the default one (S6).
  worktree: { baseRef: "head" },
});

/**
 * The folder the repository's own hooks are in: where core.hooksPath pointed before enrolment, resolved
 * the way git resolves it (relative to the working tree, ~ for the home folder), or .git/hooks when it
 * was unset. The dispatcher in templates/githooks/harness resolves it the same way.
 */
export function ownHooksDir(dir: string, previous: string | null): string {
  if (!previous) {
    const common = git(dir, "rev-parse", "--git-common-dir") ?? ".git";
    return join(isAbsolute(common) ? common : join(dir, common), "hooks");
  }
  if (previous.startsWith("~/")) return join(homedir(), previous.slice(2));
  return isAbsolute(previous) || /^[A-Za-z]:/.test(previous) ? previous : join(dir, previous);
}

/** The hooks the repository has of its own, by git's names, in the folder they are in. */
export function ownHooks(dir: string, previous: string | null): string[] {
  const folder = ownHooksDir(dir, previous);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => GIT_HOOKS.includes(name) && statSync(join(folder, name)).isFile()).sort();
}

/** One hook name's wrapper: every hook in a home's githooks runs through the dispatcher. */
const wrapper = (name: string): string => `#!/bin/sh\nexec "$(dirname "$0")/harness" ${name} "$@"\n`;

/** The files a home's githooks folder should hold: the dispatcher, and a wrapper per hook name. */
export function hookFiles(pluginRoot: string, own: readonly string[]): Map<string, string> {
  const files = new Map<string, string>([["harness", readFileSync(join(pluginRoot, "templates", "githooks", "harness"), "utf8")]]);
  for (const name of [...new Set([...HARNESS_HOOKS, ...own])].sort()) files.set(name, wrapper(name));
  return files;
}

/** The routing.yaml a new home starts with: the template, with the eval stages found in the repository. */
export function routingYamlFor(dir: string, pluginRoot: string): { text: string; stages: string[] } {
  const template = readFileSync(join(pluginRoot, "templates", "routing.yaml"), "utf8");
  const stages = detectStages(dir);
  const block = stages.length
    ? `  stages:\n${stringify(stages, { flow: false }).split("\n").filter(Boolean).map((l) => `    ${l}`).join("\n")}`
    : "  stages: []             # none detected: add the build and test commands this repository uses";
  return { text: template.replace(/^ {2}stages: \[\].*$/m, block), stages: stages.map((s) => s.name) };
}

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

/** Whether the registry already lists this metadata folder. */
const registered = (metadataDir: string): boolean =>
  (readJson<{ spools?: { metadata_dir: string }[] }>(registryPath())?.spools ?? [])
    .some((s) => normalisedPath(s.metadata_dir) === normalisedPath(metadataDir));

/** What core.hooksPath and harness.previousHooksPath say now, and whether the first is already the home's. */
export function hooksState(dir: string, home: string): { current: string | null; ours: boolean; previous: string | null } {
  const current = git(dir, "config", "--get", "core.hooksPath");
  const ours = current !== null && normalisedPath(current) === normalisedPath(githooksDir(home));
  return { current, ours, previous: ours ? git(dir, "config", "--get", "harness.previousHooksPath") : current };
}

/**
 * What enrolling the repository at `dir` would change, without changing it. Each step leaves what is
 * already right alone, so enrolling an enrolled repository changes nothing, and enrolling again after
 * something moved core.hooksPath (husky's install does) puts the Harness back in front of it.
 */
export function enrolPlan(dir: string, pluginRoot: string, now: Date = new Date()): { home: string; steps: Step[] } {
  const home = repoHome(dir);
  const steps: Step[] = [];

  if (!existsSync(join(home, "routing.yaml"))) {
    // A repository set up the old way keeps its config: it moves into the home and the copy in the
    // repository is left for the person to delete in a commit of their own.
    const old = join(dir, "routing.yaml");
    if (existsSync(old)) {
      steps.push({ what: `copy routing.yaml into ${home} (the repository's copy is left as it is)`, apply: () => writeHome(home, "routing.yaml", readFileSync(old)) });
    } else {
      const { text, stages } = routingYamlFor(dir, pluginRoot);
      steps.push({ what: `write ${join(home, "routing.yaml")} (mode observe; stages: ${stages.join(", ") || "none detected"})`, apply: () => writeHome(home, "routing.yaml", text) });
    }
  }

  if (!existsSync(join(home, "repo.json"))) {
    const record: RepoRecord = { schema: "harness.repo/v1", repo_dir: dir, enrolled: utcNow(now) };
    steps.push({ what: `write ${join(home, "repo.json")}`, apply: () => writeHome(home, "repo.json", JSON.stringify(record, null, 2) + "\n") });
  }

  const settings = JSON.stringify(homeSettings(home), null, 2) + "\n";
  if (readSafely(join(home, "settings.json")) !== settings) {
    steps.push({ what: `write ${join(home, "settings.json")} (${homeDeny(home).length} deny rules for Harness sessions, worktrees from HEAD)`, apply: () => writeHome(home, "settings.json", settings) });
  }

  const hooks = hooksState(dir, home);
  const own = ownHooks(dir, hooks.previous);
  const files = hookFiles(pluginRoot, own);
  const folder = githooksDir(home);
  const present = existsSync(folder) ? readdirSync(folder) : [];
  const stale = [...files].some(([name, text]) => readSafely(join(folder, name)) !== text) || present.some((name) => !files.has(name));
  if (stale) {
    steps.push({
      what: `write the git hooks in ${folder}: the Harness's ${HARNESS_HOOKS.join(", ")}${own.length ? `, then the repository's own ${own.join(", ")}` : ""}`,
      apply: () => {
        mkdirSync(folder, { recursive: true });
        for (const name of present) if (!files.has(name)) rmSync(join(folder, name), { force: true });
        for (const [name, text] of files) {
          writeFileSync(join(folder, name), text);
          chmodSync(join(folder, name), 0o755);
        }
      },
    });
  }

  if (!hooks.ours) {
    steps.push({
      what: `git config core.hooksPath ${forward(folder)} in this clone (it was ${hooks.current ? `"${hooks.current}"` : "unset"}; kept as harness.previousHooksPath, and its hooks still run)`,
      apply: () => {
        execFileSync("git", ["-C", dir, "config", "harness.previousHooksPath", hooks.current ?? ""]);
        execFileSync("git", ["-C", dir, "config", "core.hooksPath", forward(folder)]);
      },
    });
  }

  if (!registered(home)) {
    steps.push({ what: `register the spool in ${registryPath()}, so pu sync finds it`, apply: () => registerSpool({ dir, metadataDir: home }, now) });
  }

  return { home, steps };
}

function writeHome(home: string, name: string, content: string | Buffer): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, name), content);
}

/** Every home on this machine, with the clone each belongs to (null when its repo.json is gone). */
export function homes(): { home: string; repoDir: string | null }[] {
  const root = join(harnessHome(), "repos");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name))
    .map((home) => ({ home, repoDir: readJson<RepoRecord>(join(home, "repo.json"))?.repo_dir ?? null }));
}

/** Homes whose clone is gone: moved, deleted, or never recorded. forget --all, or forget on each, removes them. */
export const orphans = (): string[] =>
  homes().filter(({ repoDir }) => !repoDir || !existsSync(join(repoDir, ".git"))).map(({ home }) => home);

/** Lines in a home's spool: what forgetting it throws away if PU has not sent them yet. */
function spoolLines(home: string): number {
  let lines = 0;
  for (const folder of ["events", "routing-log"]) {
    const dir = join(home, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
      lines += readSafely(join(dir, name)).split("\n").filter((l) => l.trim()).length;
    }
  }
  return lines;
}

/**
 * What forgetting a home would change: core.hooksPath put back (when the clone is still there and
 * still points at this home), the home deleted, and its spool taken off the registry. The repository's
 * working tree is not touched; a repository set up the old way keeps its committed files.
 */
export function forgetPlan(home: string, repoDir: string | null): { steps: Step[]; unsentRisk: number } {
  const steps: Step[] = [];

  if (repoDir && existsSync(join(repoDir, ".git"))) {
    const hooks = hooksState(repoDir, home);
    if (hooks.ours) {
      const previous = hooks.previous;
      steps.push({
        what: previous ? `git config core.hooksPath "${previous}" in ${repoDir} (as it was before enrolment)` : `unset core.hooksPath in ${repoDir} (it was unset before enrolment)`,
        apply: () => {
          if (previous) execFileSync("git", ["-C", repoDir, "config", "core.hooksPath", previous]);
          else execFileSync("git", ["-C", repoDir, "config", "--unset", "core.hooksPath"]);
          execFileSync("git", ["-C", repoDir, "config", "--unset", "harness.previousHooksPath"]);
        },
      });
    }
  }

  const unsentRisk = spoolLines(home);
  if (existsSync(home)) {
    steps.push({ what: `delete ${home}${unsentRisk ? ` (its spool holds ${unsentRisk} line(s))` : ""}`, apply: () => rmSync(home, { recursive: true, force: true }) });
  }
  if (registered(home)) steps.push({ what: `remove it from ${registryPath()}`, apply: () => unregisterSpool(home) });
  return { steps, unsentRisk };
}
