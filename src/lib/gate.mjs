// The commit gate's decisions, shared by the PreToolUse hook (inside Claude Code) and the git
// pre-commit hook (outside it): is this command a commit, may this staged diff be committed, and is
// this path the pass marker.
import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { head, readMarker, stagedDiffSha256 } from "./eval.mjs";

// Where a command can start: the beginning, a new line, after ; & | ( or a backtick (which covers
// &&, || and $( ), or just inside an opening quote (bash -c "git commit"). Then any VAR=value
// assignments and a few wrappers that run the command after them, then git itself. A path separator
// right before git also starts it, so /usr/bin/git and "C:/Program Files/Git/bin/git.exe" count
// however the path is quoted or escaped.
const COMMAND_GIT = /(?:^|[\n;&|(`"'\\/])\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:sudo|env|command|exec|nohup|time|xargs)\s+(?:-\S+\s+)*)*git(?:\.exe)?["']?(?=\s)/g;

// git's global options that take their value as the next word. Every other option before the
// subcommand is a single word (--no-pager, -p, --git-dir=x).
const TAKES_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);

/** The words after a match, honouring quotes so `-C "a path"` is one word. */
const words = (text) => (text.match(/"[^"]*"|'[^']*'|[^\s"']+["']?/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ""));

/**
 * Whether a shell command runs `git commit` (C2). It errs towards yes: `echo "git commit"` counts,
 * which is harmless, because the gate only denies when there is no eval pass. `git commit-tree` does
 * not count; permission rules deny it instead.
 */
export function isCommit(command) {
  if (typeof command !== "string" || !command.includes("commit")) return false;
  for (const match of command.matchAll(COMMAND_GIT)) {
    const rest = words(command.slice(match.index + match[0].length));
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i];
      if (TAKES_VALUE.has(word)) {
        i++;
        continue;
      }
      if (word.startsWith("-")) continue;
      // The subcommand, minus anything a separator glued onto it: `commit;` or `commit)`.
      if (word.replace(/[;&|)`]+$/, "") === "commit") return true;
      break;
    }
  }
  return false;
}

/** A glob as a regular expression: ** spans folders, * and ? stay inside one. Case-insensitive, as Windows paths are. */
const globToRegExp = (glob) => new RegExp(`^${glob
  .replace(/[.+^${}()|[\]\\]/g, "\\$&")
  .replace(/\*\*\//g, "\u0000")
  .replace(/\*\*/g, "\u0001")
  .replace(/\*/g, "[^/]*")
  .replace(/\?/g, "[^/]")
  .replace(/\u0000/g, "(?:.*/)?")
  .replace(/\u0001/g, ".*")}$`, "i");

/**
 * Whether a file is a test, by the repository's eval.tests globs. The path is made relative to the
 * repository first; a file outside it is never a test of this repository.
 */
export function isTestPath(file, dir, globs) {
  if (!file) return false;
  const rel = relative(dir, resolve(dir, String(file))).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || isAbsolute(rel)) return false;
  return globs.some((glob) => globToRegExp(glob).test(rel));
}

/** Lines that credit an AI tool with a commit. Anyone else's Co-Authored-By stays. */
const AI_TRAILER = /^\s*co-authored-by:.*\b(claude|anthropic|copilot|chatgpt|openai|codex|gemini|cursor)\b.*$/i;
const AI_FOOTER = /^.*generated (with|by) \[?claude( code)?\]?.*$/i;

/** A commit message without AI attribution trailers, or null when it had none (the commit-msg hook). */
export function stripAttribution(message) {
  const lines = message.split(/\r?\n/);
  const kept = lines.filter((line) => !AI_TRAILER.test(line) && !AI_FOOTER.test(line));
  if (kept.length === lines.length) return null;
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  return kept.join("\n") + "\n";
}

/** Whether a file path is the pass marker (or its temp file), however it is spelled. */
export const isMarkerPath = (path) => /\.claude[\\/]+state[\\/]+eval-pass\.json/i.test(String(path ?? ""));

const unstagedTracked = (dir) =>
  execFileSync("git", ["-C", dir, "diff", "--name-only"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;

/**
 * May the staged diff be committed? Allowed only with a marker from harness-eval for this exact
 * staged diff, on this HEAD, younger than the TTL, and with nothing unstaged in tracked files (which
 * `git commit -a` would sweep in without an eval). Returns { decision, reason, detail }, where reason
 * is one of gate.decision's values.
 */
export function checkMarker(dir, ttlMinutes, now = new Date()) {
  const marker = readMarker(dir);
  if (!marker?.diff_sha256) return { decision: "deny", reason: "no_marker", detail: "there is no eval pass" };

  const ageMinutes = (now.getTime() - Date.parse(marker.passed_at)) / 60_000;
  if (!(ageMinutes <= ttlMinutes)) {
    return { decision: "deny", reason: "stale_marker", detail: `the eval pass is ${Math.round(ageMinutes)} minutes old, over the ${ttlMinutes}-minute limit` };
  }
  if (marker.head !== head(dir)) {
    return { decision: "deny", reason: "diff_mismatch", detail: "HEAD has moved since the eval passed" };
  }
  if (marker.diff_sha256 !== stagedDiffSha256(dir)) {
    return { decision: "deny", reason: "diff_mismatch", detail: "the staged diff is not the one the eval passed" };
  }
  if (unstagedTracked(dir)) {
    return { decision: "deny", reason: "diff_mismatch", detail: "tracked files have unstaged changes the eval did not see" };
  }
  return { decision: "allow", reason: "pass", detail: "an eval passed for this staged diff" };
}
