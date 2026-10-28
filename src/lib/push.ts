// The push guard (U1): a Harness session may push its own feature branch and nothing else. No force
// in any spelling, nothing to main or the repository's default branch, no --mirror or --all. Deny
// patterns can't hold this: S21 (c) pushed `HEAD:main`, `-f` and `+HEAD` straight past
// `git push * main*` and `git push --force*`. So the command is parsed the way the commit gate parses
// one, and the patterns in the home's settings stay as a second layer.
//
// It errs towards refusing: a refspec it can't read (a variable, a command substitution) is refused,
// and so is a bare `git push` when the current branch can't be told. A `cd X && git push` is judged
// in the session's folder, which is why the agents use `git -C`.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { COMMAND_GIT, TAKES_VALUE, words } from "./gate.ts";

/** What the guard needs to know about a repository: its current branch, and the branches no push may reach. */
export interface PushContext {
  current: (dir: string) => string | null;
  protectedBranches: (dir: string, remote: string) => string[];
}

const git = (dir: string, ...args: string[]): string | null => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
};

/** The real repository: `symbolic-ref` for the branch (null when detached), and main plus whatever origin/HEAD names. */
export const gitContext: PushContext = {
  current: (dir) => git(dir, "symbolic-ref", "--short", "-q", "HEAD"),
  protectedBranches: (dir, remote) => {
    const named = git(dir, "symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`);
    return [...new Set(["main", ...(named ? [named.slice(remote.length + 1)] : [])])];
  },
};

// push's own options that take their value as the next word.
const PUSH_TAKES_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/** The command's text from a match up to the first separator outside quotes: one git invocation. */
function invocation(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "\n" || c === ";" || c === "&" || c === "|" || c === ")" || c === "`") return text.slice(0, i);
  }
  return text;
}

/**
 * Why this shell command's `git push` is refused, or null when it pushes nothing it shouldn't (or
 * isn't a push). `cwd` is the session's folder, and `-C` is resolved against it.
 */
export function pushRefusal(command: unknown, cwd: string, context: PushContext = gitContext): string | null {
  if (typeof command !== "string" || !command.includes("push")) return null;
  for (const match of command.matchAll(COMMAND_GIT)) {
    const rest = words(invocation(command.slice(match.index + match[0].length)));
    let dir = cwd;
    let i = 0;
    for (; i < rest.length; i++) {
      const word = rest[i] ?? "";
      if (TAKES_VALUE.has(word)) {
        if (word === "-C") dir = resolve(dir, rest[i + 1] ?? ".");
        i++;
        continue;
      }
      if (!word.startsWith("-")) break;
    }
    if (rest[i] !== "push") continue;
    const refusal = judge(rest.slice(i + 1), dir, context);
    if (refusal) return refusal;
  }
  return null;
}

function judge(args: string[], dir: string, context: PushContext): string | null {
  const positionals: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? "";
    if (optionsEnded || !word.startsWith("-") || word === "-") {
      positionals.push(word);
      continue;
    }
    if (word === "--") optionsEnded = true;
    else if (PUSH_TAKES_VALUE.has(word)) i++;
    else if (word.startsWith("--force")) return `${word} rewrites the remote's history`;
    else if (word === "--mirror" || word === "--all" || word === "--branches") return `${word} pushes every branch, the default one too`;
    else if (/^-[A-Za-z]+$/.test(word) && word.includes("f")) return `${word} forces the push`;
  }

  const remote = positionals[0] ?? "origin";
  const refspecs = positionals.slice(1);
  const guarded = context.protectedBranches(dir, remote);
  const current = context.current(dir);
  const named = (branch: string): string => `${branch} is ${branch === "main" ? "main" : "the default branch"}`;

  if (refspecs.length === 0) {
    if (current === null) return "a bare git push from a detached HEAD can't be told apart from a push to the default branch";
    return guarded.includes(current) ? `a bare git push from ${current} pushes it, and ${named(current)}` : null;
  }
  for (const refspec of refspecs) {
    if (/[$`(]/.test(refspec)) return `the refspec ${refspec} can't be read before it runs; name the branch`;
    if (refspec.startsWith("+")) return `${refspec} forces the push`;
    // src:dst pushes to dst; a lone src, or `src:`, to the same name; `:dst` deletes dst.
    const colon = refspec.lastIndexOf(":");
    let target = colon === -1 ? refspec : refspec.slice(colon + 1) || refspec.slice(0, colon);
    if (target === "HEAD") {
      if (current === null) return `${refspec} from a detached HEAD can't be told apart from a push to the default branch`;
      target = current;
    }
    target = target.replace(/^refs\/heads\//, "");
    if (guarded.includes(target)) return `${refspec} pushes to ${target}, and ${named(target)}`;
  }
  return null;
}
