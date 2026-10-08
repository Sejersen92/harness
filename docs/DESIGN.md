# The Harness: design v1

**What it is:** a Claude Code plugin that scores every task for complexity, runs it on the cheapest model tier likely to succeed, verifies it with an independent eval, refuses any commit without a passing eval for that exact diff, and writes metadata that PU turns into cost, outcomes and calibration. It is part of PreviouslyUpcoming.

**Sources and precedence:** the full design is in the three source documents in [sources/](sources/):
- [01-harness.pdf](sources/01-harness.pdf): the rubric, agents, eval, gate and escalation
- [02-appendix-a.pdf](sources/02-appendix-a.pdf): decisions D1–D10, packaging and the metadata outputs
- [03-pu-integration.pdf](sources/03-pu-integration.pdf): the PU side

This document records the design as it stands after the review fixes (C1–C16 in [PLAN.md](PLAN.md)) and the day-1 spikes ([spikes.md](spikes.md)). **Where they disagree, this document wins, then Appendix A, then the Harness document.** The metadata contract is in [EVENTS.md](EVENTS.md) and [`schema/`](../schema/).

**Where a repository's files live (0.4.0):** in its home, `~/.harness/repos/<name>-<hash>/`: routing.yaml, `PLAN.md`, the spool and the pass marker (`state/eval-pass.json`), with nothing in the repository ([ANY-REPO.md](ANY-REPO.md)). A repository with `routing.yaml` at its root and no home is still read the old way, with `.harness/`, `.claude/state/` and `PLAN.md` in the repository. The paths below describe that layout until enrolment (H2) replaces it.

## The flow

```text
request ─▶ orchestrator (main thread, Opus)
             1. writes PLAN.md: tasks, acceptance criteria (AC-n), dependencies, file scope
             2. scores each task on the rubric ─▶ score_band ─▶ overrides ─▶ tier_planned
             3. evaluator (Opus) writes failing tests, one or more per AC
             4. dispatches the task to harness:impl-tN
             5. evaluator runs harness-eval on the result ─▶ PASS / FAIL
             6. on repeated failure or ESCALATE: architect (Opus) re-plans, back to 2
             7. commit, allowed only if the staged diff matches a fresh eval pass
```

The orchestrator never writes production code. Hooks and permission rules enforce the rules that matter, not prose instructions. **The LLM decides; scripts record** (D2): every byte of metadata comes from hooks and scripts, at zero token cost.

## Rubric and tiers

The rubric is canonical and unchanged from the Harness document (pages 3–5): six dimensions scored 0–2 (ambiguity, blast radius, coupling, novelty, reversibility, verification difficulty), a total of 0–12, four tiers, override rules that only ever raise the tier, and worked examples. The `complexity-rubric` skill carries it word for word.

| Tier | Total | Agent | Default model | Effort |
|---|---|---|---|---|
| T1 | 0–2 | `harness:impl-t1` | Sonnet 5.5 | low |
| T2 | 3–6 | `harness:impl-t2` | Sonnet 5.5 | medium |
| T3 | 7–9 | `harness:impl-t3` | Sonnet 5.5 | high |
| T4 | 10–12 | `harness:impl-t4` | Opus 5.5 | medium |

- **The model per tier is a `routing.yaml` setting** (D1), written as an alias (`sonnet`, `opus`), never a version number (C3). T1 on Haiku 4.5 is a one-line change.
- **How the model is applied (C1, settled by spike S2):** the four tier agents ship in the plugin, declared `model: inherit`. In `route` mode the orchestrator passes the tier's model per call (`model: sonnet`), and the spike confirmed this overrides `inherit`. Nothing is rendered into the repository.
- **Effort is fixed per tier file** in frontmatter, and spike S5 confirmed it is honoured. That is why each tier is its own file: the file pins effort, and its name is the `agent_type` in every hook and metadata line.
- **Two numbers are kept:** `score_band` (what the raw total implies) and `tier_planned` (after overrides). Rubric problems and override problems can then be told apart (C7).

### Modes

| `mode` | Scoring and eval | Model per task | Metadata | Gate |
|---|---|---|---|---|
| `off` | none | session default | none | every hook is a no-op |
| `observe` | full | session default (no `model` passed, so `inherit`) | full | on |
| `route` | full | the tier's model from `routing.yaml` | full | on |

`observe` is the baseline (D4). It runs everything except routing, so `observe` and `route` periods can be compared like for like within each `score_band`.

## Agents

| Agent | Model | Role | Writes |
|---|---|---|---|
| `orchestrator` | Opus 5.5, high | Plans, scores, dispatches, decides escalations; runs as the main thread (`claude --agent harness:orchestrator`) | `PLAN.md` only |
| `impl-t1` … `impl-t4` | per tier | Implements exactly the task given; ends with `DONE:` or `ESCALATE:` | code, never tests |
| `evaluator` | **Opus 5.5 at every tier** (C4, D11) | WRITE-TESTS: failing tests from the ACs. EVALUATE: runs `harness-eval`, returns `PASS:`/`FAIL:` with evidence | tests only |
| `architect` | Opus 5.5, high | Re-plans from an escalation brief alone | `PLAN.md` only |

C4 changes the Harness document's Sonnet evaluator for T1–T2: the evaluator is the product's core guarantee (D3), so it stays on Opus. The Phase 2 exit criterion "orchestrator passes `model: sonnet` to the evaluator" is removed.

**Every report starts with a header naming its tasks:** `DONE: PLAN-7.2`, `PASS: PLAN-7.1, PLAN-7.2`. The `require-report` hook blocks a stop without one. The SubagentStop hook reads the header from `last_assistant_message` (spike S4) and records `task_ids[]`, which is how each run's cost is tied to its task.

## Hooks

Plugin subagents ignore `hooks`, `mcpServers` and `permissionMode` in their frontmatter. So **every hook lives in the plugin's `hooks/hooks.json`**, session-wide, and each script branches on `agent_type` from the hook input (spike S3). For example, `protect-tests` acts only for `harness:impl-t*`.

| Script | Event | Purpose |
|---|---|---|
| `commit-gate` | PreToolUse, Bash, **every call** | Deny commits without a matching eval pass |
| `marker-guard` | PreToolUse, Bash | Refuse direct writes to the pass marker |
| `protect-tests` | PreToolUse, Edit/Write | Implementers can't edit test files |
| `tests-only` | PreToolUse, Edit/Write | The evaluator can only edit test files |
| `failure-counter` | PostToolUse, Bash/Edit/Write | Count failing test runs and edits per file; signal escalation |
| `require-report` | SubagentStop | Require a `DONE`/`ESCALATE`/`PASS`/`FAIL`/`PLAN` header; emit `subagent.stopped` |
| `log-subagent` | SubagentStart | Emit `subagent.started` |

**One process per event, not per policy.** The `PreToolUse` policies (`commit-gate`, `marker-guard`, `protect-tests` and `tests-only`) all run inside one script, `bin/hook-pre-tool-use.mjs`, registered for `Bash|Edit|Write|MultiEdit|NotebookEdit`. It runs on every Bash call, and Node's start-up is most of its cost. A call that is not a commit, not about the marker, and not an edit by a Harness agent leaves before `routing.yaml` is read. Measured on Windows (2026-10-07): 64 ms for a non-commit call against 63 ms for bare `node`, and about 100 ms for a commit check.

- **`commit-gate`** allows a commit only with a marker for exactly the staged diff, on the current `HEAD`, younger than `gate.marker_ttl_minutes`, and with no unstaged edits to tracked files. Without that last check, `git commit -a` would take changes the eval never saw. Every decision is recorded as `gate.decision`. If the hook itself fails, it allows the commit and the git `pre-commit` hook decides.
- **`marker-guard`** denies any Edit/Write to `.claude/state/eval-pass.json`, and any Bash command naming `eval-pass.json` unless it runs `harness-eval`.
- **`protect-tests`** denies an edit by `harness:impl-t*` to a test file, and **`tests-only`** denies an edit by `harness:evaluator` to anything else. Which files are tests comes from `routing.yaml`'s `eval.tests` globs, and when that is absent from the usual names (`*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`, `test/`, `tests/`, `__tests__/`, `*.Tests/`, `*Tests.cs`). Both cover the edit tools only. A file rewritten through Bash is beyond what a hook can see reliably, so the evaluator's review of the diff is the backstop there.

**Implementation rules from the spikes:**
- Scripts are single-file Node ESM (K2), registered in exec form (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/bin/<script>.mjs"]`), with no shell and no `.cmd` shim on Windows (S8).
- **A policy hook blocks with a JSON `permissionDecision: "deny"` or exit 2, never exit 1.** Exit 1 is a non-blocking error and the action proceeds (S8).
- **A subagent's report may arrive as a `SubagentHandback` tool call, not as its last message** (found in the first full run, 2026-10-07, Claude Code 2.1.285). `require-report` reads the last handback in the agent's transcript when the message has no header. Before this fix, every subagent was blocked once with a correct report in hand, and none of their stops was recorded.
- **`harness:orchestrator` is the main thread, not a subagent.** Claude Code labels the main thread's own contexts with its `--agent` type, so the subagent hooks skip it. The orchestrator passes `run_in_background: false` on every Agent call.

## Eval and the commit gate

- **`harness-eval`** is a stage runner. It reads `eval.stages` from `routing.yaml` (`{ name, run, cwd?, env?, timeout_minutes? }`) and runs each command through the shell in order, so it doesn't care which test framework a repo uses. For PU the stages are `dotnet build` and tests for the CLI, then `npm run lint` and `npm run build` for the web app. `npm run gate` is left out: it needs a running dev server and a sign-in, so it stays a manual check (decided 2026-10-07).
  - **It evaluates exactly what will be committed.** The stages run on the working tree, so it refuses (exit 2) while anything is unstaged or untracked, and when nothing is staged or there are no stages. A pass is void if the staged diff or working tree changed while it ran.
  - **The first failing stage stops the run.** Later stages are recorded as `skipped`. Each stage's full output is in `.harness/state/eval/<stage>.log`; the console shows the failing stage's last 60 lines and any AC ids (`PLAN-n.m/AC-k`) in its output, which become `failed_acs`.
  - **The marker.** A run that starts deletes the old marker, so a failure also revokes an earlier pass. A pass writes `.claude/state/eval-pass.json` with `sha256(git diff --cached --binary)`, `HEAD`, a timestamp, the task ids and `config_sha256`. `harness-eval` is the only thing allowed to write it.
  - `eval.*` events are written only inside Claude Code (there is a session id). A run by hand or with `--ci` still gates, records nothing, and is not counted as an emit failure. `--ci` evaluates the checkout as it is and writes no marker.
  - Exit codes: 0 pass, 1 fail, 2 refused.
- **The commit gate has two layers:**
  1. The `commit-gate` hook, inside Claude Code.
  2. The git `pre-commit` hook, which catches commits made outside Claude Code. **Plain git hooks, not lefthook** (decided 2026-10-07): there is one hook to run, so a committed `.githooks/` folder switched on with `git config core.hooksPath .githooks` does the job without a tool to install on every machine. The wrappers are in [`templates/githooks/`](../templates/githooks/) and call `bin/harness-git-hook.mjs`.
     - **It finds the plugin through `~/.harness/plugin.json`**, which SessionStart writes whenever a session starts with the plugin. Nothing machine-specific is written into the repository. Without that file, `pre-commit` stops the commit and prints the setup steps; `git commit --no-verify` remains the escape hatch, as for any git hook.
     - **With no pass for what is staged, `pre-commit` runs `harness-eval` itself** and lets the commit through if it passes (decided 2026-10-07), so a commit by hand needs no separate step. `git commit -a` works, because git hands the hook an index that already holds everything the commit will take.
     - `post-commit` records `commit.created` inside Claude Code (that is where the session id is), with the task ids from the marker.

  Both recompute the staged-diff hash, and deny when there is no marker, when the diff differs, or when the marker is more than 30 minutes old (`gate.marker_ttl_minutes`).
- **Commit detection (C2):** the hook runs on every Bash call and its script decides whether the command is a commit. It treats `git` as the start of a command at the beginning of the line; after `;`, `&&`, `||`, `|`, `$(` or a backtick; or after an opening `"` or `'`. It then skips any global options, including `-C <path>`, `-c <k=v>`, and `--git-dir`, `--work-tree` and `--namespace` whether they take their value with `=` or a space, before looking for `commit`. M2 implements these cases as tests:

  | Command | Expected |
  |---|---|
  | `git commit -m "x"` | gated |
  | `git -C ../svc-a commit -m "x"` | gated |
  | `git -c user.name=x commit -m "x"` | gated |
  | `GIT_AUTHOR_NAME=x git commit -m "x"` | gated |
  | `npm test && git commit -am "x"` | gated |
  | `git --git-dir .git commit -m "x"` | gated |
  | `bash -c "git commit -m x"` | gated |
  | `echo "git commit"` | gated (a harmless false positive: the gate only denies when no eval pass exists) |
  | `git log --grep commit` | not gated |
  | `git commit-tree …` | not gated by the pattern; denied by permission rules instead |

- **The permission rules** come from the Harness document's Permissions section, plus `Bash(git commit-tree*)` and `Bash(git * commit-tree*)`. A plugin cannot ship permission rules (spike S7 fails), so `/harness:init` merges them into `.claude/settings.json` and shows the diff first.
- **`commit-msg`** strips AI attribution trailers (`Co-Authored-By` naming Claude, Anthropic, Copilot and similar, and the "Generated with Claude Code" line); anyone else's `Co-Authored-By` stays. Claude Code's own `attribution.commit` setting is also turned off, so the hook is only a backstop. Confirmed for PU on 2026-10-07.

## Escalation

Unchanged from the Harness document:

- **Triggers:** 3 consecutive failing test runs, 6 edits to one file, 2 eval rounds failing on the same AC, `maxTurns` reached, or the implementer's own report (out of scope, a wrong assumption, a trade-off needed).
- **The handoff:** the implementer stops with an escalation brief, the architect re-plans from the brief alone, and the orchestrator re-dispatches at the new tiers.
- **The limit:** a second escalation of the same original task stops and asks the human.

All thresholds live in `routing.yaml` under `escalation`.

## Parallel groups (M6, only if the data justifies it)

Independent tasks with no overlapping file scope can run in parallel worktrees, at most `parallel.max` (3) at a time. They are merged in plan order, and a diff that doesn't apply is re-dispatched (`merge_conflict`). One eval runs on the merged result, and **one commit per group carries all its `task_ids`**. A failure that names no AC fails the whole group with `attribution: "group"` (C5).

- **Worktree base (spike S6):** by default a worktree starts from the remote's default branch, not the current feature branch. **`/harness:init` sets `worktree.baseRef: "head"`**, and the spike confirmed the worktree then holds the feature branch's unpushed commits.
- **Windows path casing (spike S6):** Claude Code refused a worktree when the session's working directory was spelled with different capital letters from the folder on disk. Test this on PU (which VS Code opens as `c:\src\…`) before building M6. `/harness:doctor` checks it either way.

## Setup and health

Both are scripts (`bin/harness-init.mjs`, `bin/harness-doctor.mjs`) with slash commands in front of them (`commands/init.md`, `commands/doctor.md`). They share one list in `src/lib/setup.ts`, so init never sets up something doctor doesn't check, and doctor never asks for something init can't do. `pu harness --install` will call the same scripts.

**`/harness:init`** is a dry run unless given `--apply`. It lists each change and describes the settings change in words before anything is written (S7). Each step leaves what is already right alone, so running it twice is safe. It:
- writes `routing.yaml` (mode `observe`) with the stages it detects: `lint`, `test` and `build` npm scripts, and a .NET solution or `*.Tests` project, at the root or one folder down;
- adds `.harness/`, `.claude/state/` and `/PLAN.md` to `.gitignore`, and keeps `.githooks/*` LF in `.gitattributes`;
- installs the `.githooks/` wrappers and sets `core.hooksPath` for this clone;
- merges into `.claude/settings.json`: the deny rules, `attribution.commit: ""` and `worktree.baseRef: "head"` (S6). It keeps every setting and rule already there.

**The deny rules** are the source design's list without its Vercel and Azure rules, which belong to repositories that use them. They cover the guardrail files (`.claude/state/`, `.claude/settings.json`, `.githooks/`, `.github/workflows/`), anything that skips or bypasses the gate (`--no-verify`, `-n`, `commit-tree`), history rewrites and pushes to main, and `gh pr merge`, `release`, `repo delete` and `secret`. They apply to **every** Claude Code session in the repository, not only the Harness's, which is why init shows them first and the person decides.

The CI eval workflow is not written by init yet (step 4c). The source's "dry-run commit to prove the gate denies" is covered by doctor's `git-hooks` check and the git-hook tests instead.

**`/harness:doctor`** prints one line per check (`pass`, `warn` or `fail`) and exits 1 when anything fails:

| Check | Fails or warns when |
|---|---|
| `node` | Node is older than 22 (fail) |
| `claude-code` | Claude Code is older than 2.1.284 (fail); `claude` is not on PATH (warn) |
| `plugin-recorded` | `~/.harness/plugin.json` is missing or points at no plugin (fail); git hooks use a different copy (warn) |
| `routing-yaml` | missing, mode off, a tier malformed, or no eval stages, which means no commit can pass (fail) |
| `spool-writable` | the metadata folder can't be written (fail) |
| `git-hooks` | `core.hooksPath` isn't `.githooks` or a wrapper is missing, so commits outside Claude Code aren't gated (fail) |
| `gitignore` | `.harness/`, `.claude/state/` or `/PLAN.md` isn't ignored (warn) |
| `attribution-off` | `attribution.commit` isn't `""` (warn: the commit-msg hook still strips it) |
| `permissions` | a deny rule is missing (warn) |
| `worktree-base` | `worktree.baseRef` isn't `head` (warn: needed only for parallel groups, M6) |
| `path-casing` | the working directory's letters differ in case from the disk's (warn, S6) |
| `emit-failures` | `.harness/emit-failures` counts failed writes (warn, C12) |

Inside Claude Code it also records `harness.doctor`. The trusted-folder check from the original list is left out: Claude Code keeps trust in its own state, and a check that reads it would break the next time that format changes.

## Metadata and PU

- **The two outputs and their contract:** [EVENTS.md](EVENTS.md). `config_sha256` hashes `routing.yaml` only. **Bump the plugin version on any prompt or skill change, and freeze both during the baseline** (C16), so PU compares within one `config_sha256` + `producer.version`.
- **Into PU (K4, C14):** `pu sync` validates and quarantines each line, then pushes it through DocumentService into the central store. There is no separate local database: one hub, reached from every machine.
- **Pricing (M3):** PU prices each run from its subagent transcript, joined on `agent_id` (exact, spike S1). It records the model the transcript shows (C13), shows orchestration overhead as its own line, and flags any unattributed share above 5%.
- **Calibration (M7):** rules R1–R6 run as a `harness` rule pack on PU's `pu audit` engine, not a second rules engine. R3 needs transcripts, so it is PU-only (C11). Every accepted suggestion becomes a reviewed PR against `routing.yaml`. PU never edits a repository on its own.

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | The rubric is unchanged; the model per tier is a `routing.yaml` alias | Appendix A |
| D2 | The LLM decides, scripts record | Appendix A |
| D3 | The full eval stays: Opus evaluator, every stage available | Appendix A |
| D4 | Measure a baseline in `observe` before routing (K5: at least 30 tasks, counted from M2) | Appendix A, plan |
| D5 | Async-first parallel groups (built only if the M6 data check justifies them) | Appendix A, plan |
| D6 | The commit gate runs on every Bash call and detects commits itself | Appendix A |
| D7 | Deterministic tests only; contracts as checked-in files | Appendix A |
| D8 | The Harness owns its whole eval. The deployed and exploratory stages are **not built** for the PU pilot (see PLAN.md's won't-build list). | Appendix A, plan |
| D9 | Ships as a Claude Code plugin plus a per-repo `routing.yaml` | Appendix A |
| D10 | Two metadata outputs; reviews and visualisation belong to consumers (PU) | Appendix A |
| D11 | The evaluator runs on Opus 5.5 at every tier (C4) | plan |
| K1–K6 | PU pilot; Node; own repo, part of PU; DocumentService; baseline by count; working name | plan, settled 2026-10-06 |

## Open questions

- Whether the drive-letter casing alone (`c:` vs `C:`) triggers the worktree refusal. Test on PU before M6.
- How much context a plugin-wide Playwright MCP server costs. It is deferred with the exploratory stage, so it is not needed for the pilot.
- Whether `plan_id` is enough to stitch a plan that spans PU and DocumentService into one view. Multi-repo plans will come up naturally on the pilot; check on the first one.
