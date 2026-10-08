import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { sha256 } from "./ids.ts";
import type { LoadedConfig, Mode, Producer, RepoIdentity, Stage, TierEntry } from "./types.ts";

/** routing.yaml's shape before it is checked: every field may be missing or wrong. */
interface RoutingYaml {
  mode?: unknown;
  tiers?: Record<string, TierEntry>;
  metadata?: { dir?: string; retention_days?: unknown; include_justifications?: unknown };
  eval?: { stages?: unknown; tests?: unknown };
  gate?: { marker_ttl_minutes?: unknown };
}

const MODES: readonly Mode[] = ["off", "observe", "route"];

const git = (cwd: string, ...args: string[]): string | null => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

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
 * routing.yaml from the project root. No file means the Harness is off for this repo.
 * config_sha256 covers this file only (C16): prompts and skills are versioned by the plugin.
 */
export function loadConfig(dir: string = projectDir()): LoadedConfig {
  const path = join(dir, "routing.yaml");
  if (!existsSync(path)) return { dir, mode: "off", reason: "no routing.yaml" };
  const bytes = readFileSync(path);
  const yaml = (parse(bytes.toString("utf8")) ?? {}) as RoutingYaml;
  const metadata = yaml.metadata ?? {};
  return {
    dir,
    mode: MODES.includes(yaml.mode as Mode) ? (yaml.mode as Mode) : "off",
    tiers: yaml.tiers ?? {},
    config_sha256: sha256(bytes),
    metadataDir: join(dir, metadata.dir ?? ".harness"),
    retentionDays: Number.isInteger(metadata.retention_days) ? (metadata.retention_days as number) : 30,
    includeJustifications: metadata.include_justifications !== false,
    stages: Array.isArray(yaml.eval?.stages) ? (yaml.eval.stages as Stage[]) : [],
    testGlobs: Array.isArray(yaml.eval?.tests) && yaml.eval.tests.length ? yaml.eval.tests.map(String) : [...DEFAULT_TEST_GLOBS],
    markerTtlMinutes: Number.isInteger(yaml.gate?.marker_ttl_minutes) ? (yaml.gate?.marker_ttl_minutes as number) : 30,
  };
}
