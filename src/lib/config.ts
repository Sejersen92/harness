import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { sha256 } from "./ids.ts";
import type { Layout, LoadedConfig, Mode, Producer, RepoIdentity, Stage, TierEntry } from "./types.ts";

/** routing.yaml's shape before it is checked: every field may be missing or wrong. */
interface RoutingYaml {
  mode?: unknown;
  tiers?: Record<string, TierEntry>;
  metadata?: { dir?: string; retention_days?: unknown; include_justifications?: unknown };
  eval?: { stages?: unknown; tests?: unknown };
  gate?: { marker_ttl_minutes?: unknown };
  commits?: { strip_ai_attribution?: unknown };
}

const MODES: readonly Mode[] = ["off", "observe", "route"];

const git = (cwd: string, ...args: string[]): string | null => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

/** ~/.harness, or $HARNESS_HOME: everything the Harness keeps on this machine, outside any repository. */
export const harnessHome = (): string => process.env.HARNESS_HOME || join(homedir(), ".harness");

/**
 * A path in one spelling, however it was written: resolved, forward slashes, no trailing slash, lower
 * case. VS Code opens c:\src\x where git says C:/src/x (spike S6), and both must find the same home.
 */
export const normalisedPath = (dir: string): string => resolve(dir).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * This repository's home: ~/.harness/repos/<folder name>-<8 hex of sha256(its normalised path)>.
 * Keyed on the clone's path, not its remote, so two clones of one remote never share a plan or a
 * marker. The readable prefix lets a person listing ~/.harness/repos tell which folder is which.
 */
export function repoHome(dir: string): string {
  const key = normalisedPath(dir);
  const name = basename(key).replace(/[^a-z0-9._-]+/g, "-") || "repo";
  return join(harnessHome(), "repos", `${name}-${sha256(key).slice(0, 8)}`);
}

/** loadConfig's reason when a repository is set up in neither layout. */
export const NOT_ENROLLED = "not enrolled";

/** The repository the session works in: Claude Code's project dir, else git's top level, else cwd. */
export function projectDir(cwd: string = process.cwd()): string {
  return process.env.CLAUDE_PROJECT_DIR || git(cwd, "rev-parse", "--show-toplevel") || cwd;
}

/**
 * The repo identity every line carries. The remote URL is normalised (lower case, no trailing
 * ".git" or slash) and only its hash is kept, never the URL itself.
 */
export function repoIdentity(dir: string): RepoIdentity {
  const remote = git(dir, "remote", "get-url", "origin");
  const normalised = remote?.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  const name = ((normalised ? normalised.split(/[/:]/).pop() : undefined) ?? basename(dir)).toLowerCase();
  return { name, remote_sha256: sha256(normalised ?? `local:${dir.toLowerCase()}`) };
}

/** The plugin root: CLAUDE_PLUGIN_ROOT in hooks, else the nearest folder above this script holding .claude-plugin/. */
export function pluginRoot(): string | null {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, ".claude-plugin", "plugin.json"))) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return dir;
}

/** The plugin's own version (producer.version), from its plugin.json. */
export function producer(): Producer {
  try {
    const root = pluginRoot();
    if (!root) throw new Error("no plugin root");
    const { version } = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
    return { name: "harness", version };
  } catch {
    return { name: "harness", version: "0.0.0-unknown" };
  }
}

/**
 * Which files are tests, when routing.yaml's eval.tests doesn't say: the usual names across
 * JavaScript, .NET, Python and Go. protect-tests and tests-only both read this one list.
 */
export const DEFAULT_TEST_GLOBS: readonly string[] = [
  "**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/test_*.py",
  "**/test/**", "**/tests/**", "**/__tests__/**", "**/*.Tests/**", "**/*Tests.cs",
];

/**
 * The repository's routing.yaml: from its home when it has one, else, for one release, from the
 * repository root. Neither means the Harness is off for this repository. config_sha256 covers this
 * file only (C16): prompts and skills are versioned by the plugin.
 */
export function loadConfig(dir: string = projectDir()): LoadedConfig {
  const home = repoHome(dir);
  const homed = existsSync(join(home, "routing.yaml"));
  if (!homed && !existsSync(join(dir, "routing.yaml"))) return { dir, mode: "off", reason: NOT_ENROLLED, home };

  const routingYaml = join(homed ? home : dir, "routing.yaml");
  const bytes = readFileSync(routingYaml);
  const yaml = (parse(bytes.toString("utf8")) ?? {}) as RoutingYaml;
  const metadata = yaml.metadata ?? {};
  // In a home, everything is the home's: metadata.dir only ever placed the spool inside a repository.
  const layout: Layout = homed
    ? {
      kind: "home", root: home, routingYaml, metadataDir: home,
      markerPath: join(home, "state", "eval-pass.json"), planPath: join(home, "PLAN.md"),
    }
    : {
      kind: "repository", root: dir, routingYaml, metadataDir: join(dir, metadata.dir ?? ".harness"),
      markerPath: join(dir, ".claude", "state", "eval-pass.json"), planPath: join(dir, "PLAN.md"),
    };
  return {
    dir,
    home,
    layout,
    mode: MODES.includes(yaml.mode as Mode) ? (yaml.mode as Mode) : "off",
    tiers: yaml.tiers ?? {},
    config_sha256: sha256(bytes),
    metadataDir: layout.metadataDir,
    retentionDays: Number.isInteger(metadata.retention_days) ? (metadata.retention_days as number) : 30,
    includeJustifications: metadata.include_justifications !== false,
    stages: Array.isArray(yaml.eval?.stages) ? (yaml.eval.stages as Stage[]) : [],
    testGlobs: Array.isArray(yaml.eval?.tests) && yaml.eval.tests.length ? yaml.eval.tests.map(String) : [...DEFAULT_TEST_GLOBS],
    markerTtlMinutes: Number.isInteger(yaml.gate?.marker_ttl_minutes) ? (yaml.gate?.marker_ttl_minutes as number) : 30,
    // Whether a commit may say an AI helped is the repository's call, not the Harness's: a home leaves
    // messages alone unless routing.yaml asks. The old layout always stripped, and keeps doing so.
    stripAiAttribution: typeof yaml.commits?.strip_ai_attribution === "boolean" ? yaml.commits.strip_ai_attribution : !homed,
  };
}
