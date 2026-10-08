# Day-1 spikes

Run 2026-10-06 on Windows 11, Claude Code 2.1.285, Node 22.16.

**Setup:** a throwaway git repo and a minimal plugin named `harness`, loaded with `--plugin-dir`. Each session ran headless (`claude -p`) with `--setting-sources project`, so the owner's own user hooks (PU transcript staging) stayed out of the probe sessions. The plugin's hooks wrote their raw stdin to a file. The evidence below is quoted from those dumps and from the session transcripts.

| # | Assumption | Result | Consequence for the design |
|---|---|---|---|
| S1 | Hook `agent_id` = transcript `agentId` = `subagents/agent-<id>.jsonl` | **Pass** | Cost per task can be exact. SubagentStop also hands over `agent_transcript_path`, so nothing has to be searched for. |
| S2 | A per-call `model` overrides a plugin agent declared `model: inherit` | **Pass** | Tier agents ship inside the plugin; `routing.yaml` picks each one's model per call (C1). No rendering of agent files into the repo. |
| S3 | Hook input carries `agent_type` for plugin subagents | **Pass** | Guards branch on `agent_type` directly; no state file needed. |
| S4 | SubagentStop can read the final message | **Pass** | `task_ids` are parsed from `last_assistant_message`; no transcript read. |
| S5 | `effort` in plugin agent frontmatter is honoured | **Pass** | Tiers are model *and* effort, as designed. |
| S6 | A worktree subagent starts from the current branch | **Only with `worktree.baseRef: "head"`** | `/harness:init` must set it. There is also a Windows path-casing hazard; see below. |
| S7 | A plugin can ship permission rules | **Fail** | As the plan's fallback says: `/harness:init` merges the rules into `.claude/settings.json` and shows the diff. |
| S8 | Plugin hooks run Node via `${CLAUDE_PLUGIN_ROOT}` on Windows; JSON deny and exit 2 block; exit 1 doesn't | **Pass** | No `.cmd` shim needed. Every policy hook must block with JSON deny or exit 2, never exit 1. |
| S9 | A repository can be run with nothing in its tree: deny rules by `--settings`, writes to the home by `--add-dir`, git hooks from a `core.hooksPath` outside it, chained to its own hooks | **Pass** (2026-10-08) | [ANY-REPO.md](ANY-REPO.md) holds as designed. One correction: `Write(path)` deny rules are never matched, only `Edit(path)` rules are, and those cover every file tool. The `Write(...)` entries in `DENY` do nothing and go. |

## Evidence

### S1, S3, S4: subagent identity

The same agent seen from the hook and from the transcript (main session `a5b33011-…`, run 1):

```text
SubagentStart  agent_id: ae90d23cf16cdb923   agent_type: harness:impl-t1
SubagentStop   agent_id: ae90d23cf16cdb923   agent_type: harness:impl-t1
               agent_transcript_path: …\a5b33011-…\subagents\agent-ae90d23cf16cdb923.jsonl
               last_assistant_message: "DONE: SPIKE-1.1\n…"
transcript     every line: "agentId": "ae90d23cf16cdb923"
```

Each transcript line also carries `attributionAgent: "harness:impl-t1"`, `attributionPlugin: "harness"`, `promptId` and `version`. That gives PU two more ways to join, independent of the hooks.

### S2, S5: per-call model and effort

The orchestrator dispatched `harness:impl-t1`, which is declared `model: inherit, effort: low`, twice in a main session running on Opus:

| Run | Agent call | `message.model` in transcript | `effort` in transcript | `meta.json` |
|---|---|---|---|---|
| 1 | no `model` | `claude-opus-5-5` | `low` | no `model` key |
| 2 | `model: "sonnet"` | `claude-sonnet-5-5` | `low` | `"model": "sonnet"` |

This also settles the model name: **Sonnet 5.5 exists** (`claude-sonnet-5-5`). The plan's original C3 was wrong and has been corrected.

The cost was $0.39 at list price, and almost all of it was the main Opus session. Each subagent run cost about $0.01. On small tasks the orchestrator dominates. That is the plan's biggest risk in miniature, and the reason M3 reports orchestration as its own line.

### S6: worktree base branch

The repo had `master` pushed to `origin` (013a28f), plus a feature branch `feat/spike` with one unpushed commit (04072df) that adds `FEATURE.txt`. An agent declared `isolation: worktree` reported its own checkout.

- **Default settings:** Claude Code created the worktree at `013a28f [worktree-agent-…]`, which is the default branch without the feature commit. It then refused to use it (below).
- **With `.claude/settings.json` → `{"worktree": {"baseRef": "head"}}`:** the agent reported `04072df feature commit (not pushed)`, and `FEATURE.txt` was present. The worktree was removed automatically afterwards because it had no changes.

**Path-casing hazard (Windows):** in the default run the session's working directory was spelled `…\c--src-PreviouslyUpcoming\…`, but the folder on disk is `C--src-PreviouslyUpcoming`. Claude Code refused the worktree:

> Refusing to use …\spike-repo\.claude\worktrees\agent-ad63d68dd5c044162 as an isolation worktree: git resolves its working tree to C:/…/C--src-PreviouslyUpcoming/… (a core.worktree redirect, or a checkout discovered above it) …

The worktree was left behind locked and had to be removed by hand (`git worktree remove -f -f`). VS Code opens the pilot as `c:\src\PreviouslyUpcoming` while git reports `C:/src/PreviouslyUpcoming`. It is not yet known whether the drive letter alone triggers this. Test it on the pilot before M6. Whatever the result, `/harness:doctor` should compare the working directory's spelling with the on-disk spelling and warn when they differ.

### S7: plugin permission rules

The plugin shipped `settings.json` containing `{"permissions": {"deny": ["Bash(echo s7*)"]}}`. `echo s7-probe` ran and printed `s7-probe`. The rule was ignored.

### S8: blocking from a plugin hook

A `PreToolUse` hook on `Bash`, run as `node ${CLAUDE_PLUGIN_ROOT}/bin/gate.mjs` in exec form (`command` plus `args`, no shell):

| Command | Hook behaviour | Outcome |
|---|---|---|
| `echo s8-json` | prints `permissionDecision: "deny"`, exits 0 | Blocked: "S8: denied by JSON" |
| `echo s8-exit2` | writes to stderr, exits 2 | Blocked, with stderr shown to the model |
| `echo s8-exit1` | writes to stderr, exits 1 | **Ran**; the error is treated as non-blocking |

### S9: the Harness with nothing in the repository (2026-10-08)

Run on Windows 11, Claude Code 2.1.285, Git for Windows. There was a scratch repository, with a scratch home at `~/.harness-s9/repos/demo-1234/` standing in for `~/.harness/repos/<id>/`. Each probe was `claude -p` on Haiku with `--permission-mode acceptEdits --add-dir <home> --settings <home>/settings.json --setting-sources project,local --no-session-persistence --disallowedTools Bash`, so no user hooks ran and no transcript was kept. The home's `settings.json` denied `Edit(~/.harness-s9/repos/*/state/**)`, and the repository's own `.claude/settings.json` denied `Edit(blocked-by-project.txt)`. Each result below was judged by whether the file existed afterwards, not by the model's reply.

| Probe | Result |
|---|---|
| T1: write `<home>/PLAN.md` | **Written**, no prompt: `--add-dir` is enough |
| T2: write `<home>/state/eval-pass.json` | **Denied**: `~` and `*` both match in a `--settings` rule |
| T3: write the file the repository's settings deny | **Denied**: `--settings` adds to the other settings files, not replaces them |
| T4: write outside the repository and the home | **Not written**: the home is writable because of `--add-dir`, nothing else |
| G1: `core.hooksPath` set to an absolute path outside the repository | the hook ran |
| G2: `core.hooksPath` set to `~/.harness-s9/githooks` | the hook ran (git expands `~`) |
| G3: the dispatcher then runs the repository's own `.husky/pre-commit`, which fails | **commit refused**; both hooks ran |
| G4: the same, in a `git worktree` | both hooks ran (`core.hooksPath` is shared, and the recorded relative path resolves in the worktree) |

Claude Code printed this warning on every probe, about the `Write(...)` rule beside the `Edit(...)` one:

> Write(~/.harness-s9/repos/*/state/**) is not matched by file permission checks — only Edit(path) rules are. Use Edit(~/.harness-s9/repos/*/state/**) instead (Edit rules cover all file-editing tools).

So the protection in `DENY` comes from its `Edit(...)` rules alone. H1/H2 drop the `Write(...)` entries.
