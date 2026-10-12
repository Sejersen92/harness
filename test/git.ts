// The one place tests spawn git, and cleanEnv(), the environment every test child starts from.
// A git hook exports GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE and GIT_PREFIX; a test child that
// inherited them would run its git commands against the hook's repository, not its throwaway one.
import {
  execFileSync,
  spawnSync,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithBufferEncoding,
  type ExecFileSyncOptionsWithStringEncoding,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { withoutGitEnv } from "../src/lib/eval.ts";

/** A copy of process.env without GIT_* (GIT_CONFIG_* is kept). process.env itself is left alone. */
export const cleanEnv = (): NodeJS.ProcessEnv => withoutGitEnv(process.env);

/** execFileSync("git", args), with env defaulting to cleanEnv(). Throws on a non-zero exit. */
export function git(args: readonly string[], opts: ExecFileSyncOptionsWithStringEncoding): string;
export function git(args: readonly string[], opts?: ExecFileSyncOptionsWithBufferEncoding): Buffer;
export function git(args: readonly string[], opts: ExecFileSyncOptions = {}): string | Buffer {
  return execFileSync("git", args, { ...opts, env: opts.env ?? cleanEnv() });
}

/** spawnSync("git", args), with env defaulting to cleanEnv(). Returns the result, whatever the exit. */
export function spawnGit(args: readonly string[], opts: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function spawnGit(args: readonly string[], opts?: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer>;
export function spawnGit(args: readonly string[], opts: SpawnSyncOptions = {}): SpawnSyncReturns<string | Buffer> {
  return spawnSync("git", args, { ...opts, env: opts.env ?? cleanEnv() });
}
