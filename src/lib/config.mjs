import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { sha256 } from "./ids.mjs";

const git = (cwd, ...args) => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

/** The repository the session works in: Claude Code's project dir, else git's top level, else cwd. */
export function projectDir(cwd = process.cwd()) {
  return process.env.CLAUDE_PROJECT_DIR || git(cwd, "rev-parse", "--show-toplevel") || cwd;
}

/**
 * The repo identity every line carries. The remote URL is normalised (lower case, no trailing
 * ".git" or slash) and only its hash is kept, never the URL itself.
 */
export function repoIdentity(dir) {
  const remote = git(dir, "remote", "get-url", "origin");
  const normalised = remote?.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  const name = (normalised ? normalised.split(/[/:]/).pop() : basename(dir)).toLowerCase();
  return { name, remote_sha256: sha256(normalised ?? `local:${dir.toLowerCase()}`) };
}

/** The plugin root: CLAUDE_PLUGIN_ROOT in hooks, else the nearest folder above this script holding .claude-plugin/. */
export function pluginRoot() {
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
export function producer() {
  try {
    const { version } = JSON.parse(readFileSync(join(pluginRoot(), ".claude-plugin", "plugin.json"), "utf8"));
    return { name: "harness", version };
  } catch {
    return { name: "harness", version: "0.0.0-unknown" };
  }
}

/**
 * routing.yaml from the project root. No file means the Harness is off for this repo.
 * config_sha256 covers this file only (C16): prompts and skills are versioned by the plugin.
 */
export function loadConfig(dir = projectDir()) {
  const path = join(dir, "routing.yaml");
  if (!existsSync(path)) return { dir, mode: "off", reason: "no routing.yaml" };
  const bytes = readFileSync(path);
  const yaml = parse(bytes.toString("utf8")) ?? {};
  const metadata = yaml.metadata ?? {};
  return {
    dir,
    mode: ["off", "observe", "route"].includes(yaml.mode) ? yaml.mode : "off",
    tiers: yaml.tiers ?? {},
    config_sha256: sha256(bytes),
    metadataDir: join(dir, metadata.dir ?? ".harness"),
    retentionDays: Number.isInteger(metadata.retention_days) ? metadata.retention_days : 30,
    includeJustifications: metadata.include_justifications !== false,
  };
}
