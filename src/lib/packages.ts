// Which package manager a JavaScript folder uses, so detected stages and the CI workflow run the one the
// repository is installed with. Running npm in a pnpm repository installs a node_modules that doesn't
// match its lock file, and the eval then fails on that, not on the change.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** The lock file each package manager writes, newest format first. */
const LOCK_FILES: [PackageManager, string][] = [
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
  ["npm", "package-lock.json"],
];

/** The package manager package.json's packageManager field names ("pnpm@11.8.0"), if it names one. */
export function declaredPackageManager(folder: string): PackageManager | null {
  try {
    const field = (JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { packageManager?: unknown }).packageManager;
    const name = typeof field === "string" ? field.split("@")[0] : "";
    return LOCK_FILES.some(([pm]) => pm === name) ? (name as PackageManager) : null;
  } catch {
    return null;
  }
}

/** The lock file in this folder, if there is one. */
export function lockFile(folder: string): { pm: PackageManager; file: string } | null {
  const found = LOCK_FILES.find(([, file]) => existsSync(join(folder, file)));
  return found ? { pm: found[0], file: found[1] } : null;
}

/**
 * The package manager for a folder: its packageManager field, else its lock file, else the same two at
 * the repository root (a workspace member has neither of its own), else npm.
 */
export function packageManager(folder: string, repoRoot: string = folder): PackageManager {
  for (const dir of folder === repoRoot ? [folder] : [folder, repoRoot]) {
    const pm = declaredPackageManager(dir) ?? lockFile(dir)?.pm;
    if (pm) return pm;
  }
  return "npm";
}

/** The command that runs a package.json script with this package manager. */
export const runScript = (pm: PackageManager, script: string): string => `${pm} run ${script}`;

/** A stage command that runs one of the package managers. */
export const PACKAGE_MANAGER_COMMAND = /^\s*(npm|pnpm|yarn|bun)\b/;
