# The Harness: design v1

**What it is:** a Claude Code plugin that scores every task for complexity, runs it on the cheapest model tier likely to succeed, verifies it with an independent eval, refuses any commit without a passing eval for that exact diff, and writes metadata that PU turns into cost, outcomes and calibration. It is part of PreviouslyUpcoming.

**Sources and precedence:** the full design is in the three source documents in [sources/](sources/):
- [01-harness.pdf](sources/01-harness.pdf): the rubric, agents, eval, gate and escalation
- [02-appendix-a.pdf](sources/02-appendix-a.pdf): decisions D1–D10, packaging and the metadata outputs
- [03-pu-integration.pdf](sources/03-pu-integration.pdf): the PU side

This document records the design as it stands after the review fixes (C1–C16 in [PLAN.md](PLAN.md)) and the day-1 spikes ([spikes.md](spikes.md)). **Where they disagree, this document wins, then Appendix A, then the Harness document.** The metadata contract is in [EVENTS.md](EVENTS.md) and [`schema/`](../schema/).

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

**Implementation rules from the spikes:**
- Scripts are single-file Node ESM (K2), registered in exec form (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/bin/<script>.mjs"]`), with no shell and no `.cmd` shim on Windows (S8).
- **A policy hook blocks with a JSON `permissionDecision: "deny"` or exit 2, never exit 1.** Exit 1 is a non-blocking error and the action proceeds (S8).

## Eval and the commit gate

- **`harness-eval`** is a stage runner. It reads the stage list from `routing.yaml` and runs each command in order, so it doesn't care which test framework a repo uses. For PU the stages are: `dotnet build` and tests for the CLI, then `npm run lint`, `npm run build` and `npm run gate` for the web app. A passing run writes `.claude/state/eval-pass.json` with `sha256(git diff --cached --binary)`, `HEAD` and a timestamp. It is the only thing allowed to write that marker.
- **The commit gate has two layers:**
  1. The `commit-gate` hook, inside Claude Code.
  2. lefthook `pre-commit`, which catches commits made outside Claude Code.

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
- **`commit-msg`** strips AI attribution trailers. Claude Code's own `attribution` setting is also turned off, so the hook is only a backstop.

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

`/harness:init`:
- writes `routing.yaml` with the stages it detects;
- merges the permission rules (S7) and `worktree.baseRef: "head"` (S6) into `.claude/settings.json`, showing the diff before writing;
- installs `lefthook.yml` and the CI eval workflow;
- adds `.harness/` and `.claude/state/` to `.gitignore`;
- runs a dry-run commit to prove the gate denies.

`/harness:doctor` checks:
- the Claude Code version (at least 2.1.284);
- that the hook scripts resolve;
- that the folder is trusted;
- that `routing.yaml` validates;
- that the spool is writable;
- that `worktree.baseRef` is set;
- that the working directory's casing matches the disk;
- that attribution is off.

It also reports `emit_failures` (C12) and emits `harness.doctor`.

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
