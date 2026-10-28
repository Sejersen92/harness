# 06 — The Harness, built by doing

**Status:** Plan, written 2026-10-05. Kickoff decisions K1–K6 settled and spikes run on 2026-10-06 (see [spikes.md](spikes.md)); nothing else is built.
**Sources:** *Adaptive Model Routing & Eval-Gated Delivery* (the Harness), *Appendix A*, *Integrating Harness Events into PU* (all 2026-10-04).
**Relationship to the sources:** their designs stand, except where [Changes to the design](#changes-to-the-design) says otherwise. This plan replaces their implementation-plan sections.

## The goal in one sentence

Every task gets a complexity score, runs on the model that score calls for, and PU shows how it went (tier, cost, pass or fail), so that `routing.yaml` gets tuned from evidence instead of intuition.

## How we work

1. **Spikes before structure.** Day 1 checks the Claude Code behaviours the design depends on. Each spike already has a fallback, so a failure changes the shape of the work but doesn't stop it.
2. **Vertical slices.** Every milestone ends with something visible on the deployed PU web app, built from real work. No milestone ends at "the schema exists".
3. **Pilot on PU itself.** PU and DocumentService are personal repos, so there's no question about who owns the work. They have both .NET and Next.js stages, and they produced 72 merged PRs between them in the last month, roughly 17 a week. That's enough tasks for a baseline in 1–2 weeks. Plans that span more than one repo will come up naturally.
4. **Get v1 right first.** Nothing exists yet, so every schema fix goes into v1, with no v1/v2 dual-writing.
5. **No silent loss.** Every stage that can drop data says how much it dropped.

## Decisions for kickoff

All six accepted as recommended on 2026-10-06. K4 matches the owner's goal of one central hub: decentralised tools push to DocumentService, and PU reads from there. On K6: the Harness lives under PreviouslyUpcoming as a piece of it, and PU ingests any valid Harness JSONL in the right folder.

| # | Decision | Recommendation | Why, and what the alternative costs |
|---|---|---|---|
| K1 | Pilot repo | **PU, plus DocumentService** | Enough volume, no IP question. A work repo would mean settling ownership first. |
| K2 | Script language for hooks and `bin/` | **Node, single-file ESM, dependencies bundled** | The docs assume bash + jq. jq isn't installed here. `harness-eval` needs to parse YAML, which bash can't do sanely. ULIDs, SHA-256 and atomic appends are easy in Node. Node 22 is already here (PU web) and on almost every Claude Code machine. Cost: roughly 50 ms of startup on every Bash call for the commit gate. .NET would need the SDK on users' machines. |
| K3 | Where the Harness lives | **New private repo `c:\src\harness`**, installed as a local plugin marketplace | Plugin packaging from the first commit (D9) without publishing anything. |
| K4 | How PU receives Harness data | **Through the existing `pu sync` → DocumentService push**, not a new local SQLite or DuckDB store | PU already has the store, the Runs page and lineage. A second store would be new architecture with no new capability. Raw events are kept unchanged, so the free/local-tier question (brief 05.6.3) stays open. |
| K5 | Baseline length | **By count: at least 30 completed tasks in `observe`, counted only once the gate is in (after M2)** | Comparing like with like needs the gate and eval running in both periods. Expect 1–2 weeks. |
| K6 | Product name | **"harness" as the working name; rename before anything goes public** | Harness Inc. (harness.io) is an established developer-tools brand. |

## Day 1 — setup and spikes

**Setup (first hour)**
- Update Claude Code to v2.1.284 or later. The `claude` on PATH is **2.1.236**. Check the terminal and VS Code separately.
- Create `c:\src\harness` with a minimal plugin: `plugin.json`, one agent, one hook. Install it through a local marketplace and confirm it appears in `/plugin` and `/hooks`.
- Move this plan into the repo as `docs/PLAN.md`. Use a throwaway repo in the scratchpad for the spikes.

**Spikes.** Each one is a few minutes in the throwaway repo. The results go into `docs/spikes.md`, with evidence (the raw hook input, a transcript line).

| # | Assumption | Test | If it fails |
|---|---|---|---|
| S1 | The `agent_id` in hook input equals the transcript's `agentId` and the `subagents/agent-<id>.jsonl` file name | A SubagentStart/Stop hook dumps its stdin; run one subagent; compare | Link by `transcript_path` and time. Cost per task becomes approximate, and PU says so on the page. **The most important spike: every cost figure joins on this.** |
| S2 | A per-call `model` overrides a plugin agent declared with `model: inherit` | Dispatch `harness:impl-t1` with `model: sonnet`; check the model in its transcript | `/harness:init` renders the tier agents into `.claude/agents/` from `routing.yaml`. Frontmatter hooks work there too. |
| S3 | Hook input carries `agent_type` for plugin subagents (every guard branches on it) | The same dump as S1 | Remember `agent_id → agent_type` from SubagentStart in a state file. |
| S4 | The SubagentStop hook can read the final message, so `task_ids` can be parsed from the report header | The same dump; look for the last message or `transcript_path` | Read the last assistant line from the agent's transcript file. |
| S5 | `effort` in plugin agent frontmatter is honoured | Check effort in the transcript for each tier | A tier becomes model only. Record `effort: not_applied` rather than claiming it. |
| S6 | An `isolation: worktree` subagent starts from the current branch, not the default branch | Make a commit on a feature branch, spawn a worktree agent, check its HEAD | Parallel groups (M6) create their own worktrees through `git worktree add`, or M6 is dropped. |
| S7 | A plugin can ship permission rules | Docs, then a test | `/harness:init` merges them and shows the diff (already the fallback in the plan). |
| S8 | On Windows, plugin hooks run Node through `${CLAUDE_PLUGIN_ROOT}`, a JSON `deny` blocks, and exit codes behave as documented | A deny-everything PreToolUse hook | Wrap the scripts in a `.cmd` shim and record the difference in `doctor`. |

**Afternoon: write the contract before the code.** Write `docs/DESIGN.md` with every change below applied. Then write `schema/harness.events.v1.json` and `schema/routing-log.v1.json`, and a test that validates every example in the docs against them.

## Milestones

Sizes are rough, for the two of us. Each milestone ends at **Shipped**: verified on the deployed PU surface, not just a green build.

### M1 — Scored and seen (1 day setup + 2–3 days)

The core idea working end to end: one real task is scored, dispatched and shown in PU. This is a shakedown in `observe` mode and doesn't count toward the baseline.

- **Harness:**
  - `harness-emit`: ULID, the full envelope including `config_sha256`, `O_APPEND`, lines under 4 KB, failure counter.
  - The orchestrator agent and the `complexity-rubric` skill, word for word from the source document.
  - Events `plan.created`, `task.scored`, `task.dispatched` and `task.completed`.
  - Agents `impl-t1` to `impl-t4`, running on the session model in observe mode.
  - SubagentStart/Stop → `subagent.started` / `subagent.stopped` with `task_ids`.
  - `require-report`, and `harness-tasklog` → routing log.
  - `mode: off | observe | route`, where `off` turns every hook into a no-op.
- **PU:**
  - CLI: `pu sync` finds the `.harness/` spools of known repos, validates each line against the schemas, quarantines bad lines with a visible count, and pushes.
  - DocumentService: collections for events and the routing log, de-duplicated on `event_id` and on `task_id` + `revision`.
  - Web: a **Look back → Routing** page listing tasks with score, `score_band`, planned tier and outcome.
- **Done when:** one real PU task goes plan → score → dispatch → `DONE` → routing-log line → visible on the deployed Routing page, with the quarantine count shown.

### M2 — Gated (2–3 days). The baseline clock starts here

- **Harness:**
  - `harness-eval` as a stage runner driven by `routing.yaml`. PU's stages: CLI `dotnet build`, CLI tests, web `npm run lint` and `npm run build`. *Decided 2026-10-07: `npm run gate` is left out because it needs a dev server and a sign-in. ESLint was installed first (PU #48), since `npm run lint` had nothing to run.*
  - A pass marker holding the staged-diff hash.
  - `commit-gate` with the fixed regex (C2), and `marker-guard`.
  - git `pre-commit`, `commit-msg` and `post-commit`. *Decided 2026-10-07: plain git hooks via `core.hooksPath`, not lefthook. Pre-commit runs the eval itself when there is no pass.*
  - Permission denies merged by `/harness:init`, including the `commit-tree` denies.
  - The evaluator in both modes, plus `protect-tests` and `tests-only`.
  - Events `eval.*`, `gate.decision` and `commit.created`.
  - `/harness:doctor`.
  - A PR eval workflow. PU currently has only `release.yml`.
- **PU:** eval rounds, failing stages and gate denials by reason on the Routing page.
- **Done when:** the original Phase 1 exit criteria hold, every commit-detection case passes in a CI test, and a commit made outside Claude Code is blocked by `pre-commit`.

### M3 — Priced (2 days, during the baseline)

- **PU:**
  - `SessionUsage` split per `agentId`, not just main thread versus subagents.
  - A versioned price table (Opus 5.5 $4 / $20 / $0.20 cache read; Sonnet 5.5 $2 / $10; cache-write rates looked up, not guessed).
  - Cost per task.
  - Orchestration overhead as its own line.
  - The unattributed share, flagged above 5%.
- **Done when:** five tasks, checked by hand against their transcripts, agree within 1%. The check is written down in the PR.
- **Check first (rule 1):** that the subagent transcripts from baseline tasks are kept, so they can be priced later.

### M4 — Routed (1 day plus a config change, after 30 or more baseline tasks)

- **Harness:** `mode: route`. Tier models come from `routing.yaml` (aliases `sonnet` and `opus`), applied the way S2 decided.
- **PU:** the baseline report. Stratified by `score_band`, medians, a warning for any band with fewer than 8 tasks, orchestration overhead shown above the table.
- **Done when:** the Routing page shows observe versus route per band, with cost, on real tasks.
- **Shipped 2026-10-14.** The deployed `/routing` page, last 7 days, all versions, shows route beside the observe baseline per band, with cost. The real tasks came from two new repositories, IntakeService (A1) and intake-webapp (W1), which put 13 routed tasks on that day's page.

  | Band | Observe, the baseline | Route |
  |---|---|---|
  | T1 | 34 tasks · 82% first pass · median $0.64 · 5m 26s | haiku 5.5: 17 tasks · 88% · ≥ $0.24 · 3m 28s |
  | T2 | 27 tasks · 81% · $1.37 · 10m 23s | sonnet 5.5: 13 tasks · 100% · $0.75 · 4m 36s |
  | T3 | none | sonnet 5.5: 1 task · 100% · $1.02 |
  | T4 | none | none |

  - **Orchestration overhead:** 48% of session cost in observe ($60.41 over 14 sessions), and ≥ 42% routed (≥ $14.83 over 7 sessions: orchestrator $11.52, dispatcher $3.32).
  - **Routing is cheaper and no worse.** T1 and T2 both cost less and pass first time at least as often, so they are inside ROUTING-POLICY.md's 5-point margin.
  - **What this doesn't prove:**
    - **T3 and T4 have no comparison.** The observe baseline has no task in either band, and route has one T3. That waits for M7's calibration, not for this milestone.
    - **T1's routed cost is a lower bound** (≥). Some of it went unattributed.
    - **Overrides are left out of the T1 haiku figure.** Two T1 tasks ran on sonnet by the owner's choice (1 of 2 first pass), and three on the old unpinned alias haiku 4.5.
    - **Each first task is missing from the routing log.** PLAN-1.1 of both runs has no routing-log line, because the orchestrators recorded into a stray `<home>/.harness/`. That bug is fixed in 0.10.4.

### M5 — Escalation (2 days)

- **Harness:** the dispatcher's stop rules S1–S5 (0.10.0), the stop report as the escalation brief, the orchestrator's re-plan after a stop (0.10.3), events `escalation.*`, `task.redispatched` and `human.intervention`. The `failure-counter` and the separate architect are replaced (C18).
- **PU:** an exceptions list where every escalated task links to its session summary. Only PU can offer that join.
- **Done when:** the original Phase 3 exit criteria hold, as amended by C18 on 2026-10-24:

  | # | Phase 3 criterion | As amended | Proven by |
  |---|---|---|---|
  | 1 | Three forced test failures trigger the threshold message and an ESCALATE report | A second failed evaluation stops the task (S1), and so does the same tool call failing twice (S5); the dispatcher returns `ESCALATE` and the orchestrator records `escalation.triggered` | a real run (BRIEF-5) |
  | 2 | An implementer that stops without DONE or ESCALATE is sent back to finish | unchanged | `test/runtime.test.ts` (require-report), since M2 |
  | 3 | The architect returns a re-scored plan from a brief alone, with no other context | The dispatcher's stop report holds everything a re-plan needs (the reports whole, the working tree, the tasks not started); the orchestrator re-plans from it, re-scores when the tier changes, and records `escalation.resolved` with the new tiers | a real run (BRIEF-5) |
  | 4 | Re-dispatched tasks run at their new tier; a second escalation stops and asks the human | The dispatcher records `task.redispatched` with `reason: replan` and the tier it runs at; a task that stops again after an escalation is always the person's (`human.intervention`) | 0.11.1 instructions, then a real run (BRIEF-5) |
  | 5 | (PU) every escalated task is on an exceptions list linked to its session | — | the deployed `/routing` page |

- **Shipped 2026-10-24.** One real run on 0.11.1: BRIEF-5 in harness-scratch (PLAN-5, session 24e29bb5, commits de4d487 and ce0bdc9), checked against the spool's events and the deployed `/routing` page.
  - **Intake** caught the brief's built-in contradiction (ambiguity 2) before any dispatch; Mikkel overruled it so the run would reach the stops.
  - **Criterion 1:** PLAN-5.1 stopped twice, both by rule S2 (the implementer reported `ESCALATE`), and each stop has its `escalation.triggered`.
  - **Criterion 3:** each stop was re-planned from the dispatcher's report: `plan.created` revisions 2 and 3, each with `escalation.resolved` `new_tiers: ["T2"]`.
  - **Criterion 4:** both re-runs recorded `task.redispatched` `{reason: replan, tier: T2}`. The second stop was a fact about the tools (implementers can't edit test files), which before 0.11.1 the orchestrator would have fixed alone; it asked instead, and both stops have a `human.intervention`. PLAN-5.1 completed `escalated_then_pass`, escalations 2, final tier T2.
  - **Criterion 5:** `/routing` → Exceptions lists PLAN-5.1, "escalated, then passed · a person stepped in 2 times", and its link opens the session summary.
  - **What this doesn't prove:**
    - **Rule S1 itself didn't fire.** Both stops came from the implementer (S2), not from two failed evaluations. What follows a stop is the same whatever the rule, but S1's counting is proven only by reading the dispatcher's instructions.
    - **No tier change.** PLAN-5.1 scored T2 from the start, so the re-runs stayed at T2. That a raised tier is the one dispatched is recorded by the same `replan` event, but no run has shown a raise yet.
  - **Found by the run, not fixed here:** the orchestrator's revision 2 handed the test edits to the implementer, which the Harness forbids; test changes belong in the evaluator's WRITE-TESTS. And it twice recorded `plan.created` a moment before its `PLAN.md` edit had succeeded.

### M6 — Parallel groups (2 days), only if justified

**First, look at the data:** how many M1–M5 plans had two or more tasks that don't depend on each other and don't share files? If almost none, don't build this; record why in the plan. If there are enough, build it with S6's result:
- worktrees;
- merging in plan order;
- re-dispatch on `merge_conflict`;
- **one commit per group carrying all of its `task_ids`** (C5).

### M7 — Calibration (2–3 days, about 4 weeks after M4)

- R1–R6 run as a **`harness` rule pack on the `pu audit` engine** (brief 05.6), not a second rules engine.
- Each suggestion is a record with its evidence; accept or reject in PU; an accepted suggestion opens a PR against `routing.yaml` through `gh`.
- It needs at least 20 tasks per rule over 4 weeks, so it can't usefully start earlier.

### U1 — Unattended runs (0.12.0, with pu 1.29.0)

From PU's M9: the brief is PreviouslyUpcoming's `U1-UNATTENDED-RUN.md`, and the evidence is spikes S17–S21 in its `SERIES-RUNS.md`. A planned plan runs headless with no one at the keyboard, and either finishes with commits or hands back. Planning stays interactive. Planned with Mikkel on 2026-10-28.

| # | Task | Acceptance criteria |
|---|---|---|
| H1 | The orchestrator's `RUN: PLAN-n, unattended` mode (`agents/orchestrator.md`) | It never asks and dispatches the plan as planned. It fixes facts about the repository alone, as today. For anything that is the person's, it records `human.intervention`, writes `HANDBACK.md` in the repository root (what stopped, the evidence, the one question to decide) and exits. `HANDBACK.md` is the second file it may write, in this mode only. Folded in from BRIEF-5: a re-plan gives test edits to the evaluator's WRITE-TESTS, never to an implementer, and `plan.created` / `plan.intake` are recorded only after the `PLAN.md` edit has saved. |
| H2 | The allow-list ships with the home (`homeSettings` in `src/lib/home.ts`) | `harness-init` writes allow rules for the plugin's own scripts (`Bash(node "<plugin>/bin/*)`, not `node *`), each eval stage's exact command, git `status`/`log`/`diff`/`show`/`branch`/`rev-parse`/`add`/`commit`, and `git -C`. It writes denies for `git push --force*` and `-f`, any push to `main`, `checkout main`, `az`, `gh` and `vercel`. `/harness:doctor` warns about each missing rule. **Proven by a headless run in `acceptEdits` with no permission denial in its stream**, which also settles how the `node` rule's quoting matches on Windows (S21 didn't test this; it ran in auto mode). |
| H3 | A push guard in `src/hooks/pre-tool-use.ts` | It parses `git push` and `git -C <dir> push`. It refuses `-f`, `--force*`, a `+<ref>` refspec, `--mirror`, a destination of `main` or the default branch (`main`, `HEAD:main`, `refs/heads/main`, `:main`), and a bare `git push` while on the default branch. It allows a push of a feature branch. A test table covers the five S21 (c) probes and each of these forms. The deny patterns stay as a second layer. |
| H4 | `git -C <repo>`, never `cd … && git …`, in every agent definition | Each definition says so, and a test checks that none contains `cd … && git`. No allow rule unlocks the second form (S17, PLAN-15). |
| H5 | Two fixes from S21 | (a) The eval-pass guard lets a plain read of `eval-pass.json` through (`cat`, `head`, `tail`, `grep`, `Get-Content`, with no redirect) and denies everything else, as now. (b) A routing-log line stays under 4 KB. `runs` keeps only the task's latest attempt. If the line is still over, it records a summary per agent and model with `runs_truncated: true`, instead of dropping the line (PLAN-6.1 reached 6,627 bytes after five spike runs). |
| P1 | `pu harness run PLAN-n` (PU, `HarnessStart.cs`) | It checks that the plan is in the home's `PLAN.md`, has passed intake and is scored. It also checks that the tree is clean and the branch isn't the default one, and that `git ls-remote` works with prompts off (if not, it names `credential.username`). With no allow-list in the home, it refuses and names the fix, or runs in `--permission-mode auto` only when given `--auto`. It launches `claude -p --agent harness:orchestrator` with the fixed `RUN` prompt, `acceptEdits`, the home's settings and AskUserQuestion disallowed, and logs the stream to the home in UTF-8. It stops the run after 90 minutes by process id. It reads the outcome from the events (S19, with S20's `subagent.started` rule) and prints DONE, hand-back or cut off. On DONE it pushes the branch. |

**Decisions (Mikkel, 2026-10-28):**
- pu pushes the branch after DONE, so the agent never has to push, and the push guard is a backstop. PRs stay with U2.
- A run uses the current branch and refuses on the default one. U2 adds stacked branches for series.
- A home with no allow-list is refused, and `--auto` is the fallback you choose explicitly. Auto mode is never used silently.
- The scope is H1–H5 and P1. SERIES mode, the criteria `harness-eval` reports failing that pass, the double `gate.decision`, the evaluator's own `routing.yaml` line, the enrolment CI commit's author and clearing stale agent records each stay a thread or go to U2.

**Done when:** `pu harness run PLAN-n` takes a planned plan in a freshly enrolled repository to commits or to a `HANDBACK.md`, with no hand-written prompt or settings file. Shown on harness-scratch (PLAN-6 to finish, PLAN-7 to stop) and on one real repository.

## Changes to the design

Every fix from the review, plus three found while planning (C12, C13, C16).

| # | Change | Lands in |
|---|---|---|
| C1 | Tier models come from `routing.yaml` through a per-call `model` on agents declared `model: inherit`, or through agents rendered into the project (S2). This also defines observe mode. | M1, M4 |
| C2 | Commit regex: allow `"` and `'` before `git`; handle `--git-dir`, `--work-tree` and `--namespace` with a space-separated value. Add the cases `echo "git commit"` (gated), `bash -c "git commit …"` (gated) and `git --git-dir .git commit` (gated). | M2 |
| C3 | `routing.yaml` uses aliases (`sonnet`, `opus`), not version numbers. *Corrected 2026-10-06: this row first said the model was "Sonnet 5, not Sonnet 5.5". That was wrong. The S2 spike ran `claude-sonnet-5-5`, so Appendix A's Sonnet 5.5 stands.* An Opus 5.5 low-effort arm is a later experiment, not part of the baseline. | DESIGN.md, M4 |
| C4 | **D11:** the evaluator runs on Opus 5.5 at every tier. This *changes* the original's Sonnet evaluator for T1–T2; remove the Phase 2 exit criterion that relied on it. | DESIGN.md |
| C5 | Parallel groups make one commit carrying `task_ids[]`. An eval failure with no AC ID (build or static) fails the whole group, recorded as `attribution: "group"`. | M6 |
| C6 | One vocabulary for scores, long names everywhere (`ambiguity`, `blast`, …), events included. | schema |
| C7 | `task.scored` carries `score_band` as well as the planned tier. | schema |
| C8 | `failed_acs` is always fully qualified: `PLAN-42.2/AC-2`. | schema |
| C9 | `config_sha256` appears in the envelope table and in every example; CI validates the examples. | schema |
| C10 | One retention key: `metadata.retention_days`. | schema, PU |
| C11 | R3 is PU-only, because it needs transcripts and the stream deliberately carries no model output. | M7 |
| C12 | **Silent-loss check:** `harness-emit` never blocks, but it counts its failures to `.harness/emit-failures`. `doctor` reports them, PU shows them, and a task missing an expected event is marked `complete: false`. | M1 |
| C13 | Each run's model is recorded from its transcript, not from config. Config says what was asked for; the transcript says what ran. | M3 |
| C14 | PU stores Harness data through DocumentService (K4). | M1 |
| C15 | Brief 04 (cost and observability) folds into this plan. Brief 01 is renamed *distillation evals* so it isn't confused with the Harness eval. | roadmap |
| C16 | `config_sha256` covers only `routing.yaml`; the rubric and agent prompts live in the plugin. **Bump the plugin version on any prompt or skill change, freeze both during the baseline,** and have PU compare within one `config_sha256` + `producer.version`. | M1 onward |
| C17 | **Skills by role** (0.11.0). Each agent preloads only its role's skills, generated from GovernanceOS and pinned in `skills/SOURCES.json`. The orchestrator gets its skills from a SessionStart hook, because `claude --agent` doesn't preload them. DESIGN.md has the table. The version bump splits M7's routed data at 0.11.0. Compare first-pass rate, rework rounds and cost per task within each version. | DESIGN.md, M7 |
| C18 | **M5 without a failure counter or a separate architect** (Mikkel, 2026-10-24). The dispatcher's stop rules already stop a task that keeps failing: S1 after a second failed evaluation, S5 when the same tool call fails twice. Implementers are about 4% of a run's cost, and no run so far has shown one thrashing inside a task, so a per-file counter would add a hook to save little. Re-planning after a stop is the orchestrator's, as RUN-ROLES.md decided: it re-plans from the dispatcher's stop report, which must be complete enough to stand alone. Phase 3's criteria 1 and 3 are amended accordingly (see M5). Revisit the counter if a run shows an implementer looping. | M5 |

## What we won't build, and why

| Not building | Why | Nearest thing we will build |
|---|---|---|
| Deployed stage | No preview-deploy contract yet, and PU's release pipeline already deploys | Build, test, lint and gate stages; revisit if a release failure would have been caught by it |
| Exploratory browser stage and plugin-wide Playwright MCP | A session-wide MCP costs context in every session | Playwright specs as an e2e stage, once PU has some |
| Local SQLite or DuckDB store | K4 | Raw events kept unchanged in DocumentService |
| Hub team view and team aggregates | One user, no team | Nothing yet |
| `az` and `vercel` CLI rules | The PU pilot needs only `gh` | Templates kept, not wired up |
| `pu harness review` CLI | The Routing page comes first; nothing to review before there's a week of data | Added if the page isn't enough |
| Advisor tool versus architect comparison | Needs escalation data | After M5 has run for a while |

## Risks

| Risk | Mitigation |
|---|---|
| A Harness bug blocks PU work | `mode: off` turns every hook into a no-op; `doctor` says so; a human `--no-verify` still works |
| The orchestrator's cost dominates small PU tasks | Shown from M3 as its own line. That's a finding, not a failure. |
| S1 fails | Cost per task is approximate and PU labels it. Routing, scoring and outcomes are unaffected. |
| Changing prompts during the baseline invalidates the comparison | C16: freeze, bump the version, compare within versions |
| Few independent tasks, so M6 is wasted | Look at the data first; skipping M6 is a valid outcome |
| Spreading across three codebases (harness, PU CLI + web, DocumentService) slows every slice | Work through each slice end to end, one codebase at a time; don't start the next until the current one is shipped |

## Tomorrow, the first hour

1. Decide K1–K6 (about 10 minutes; the recommendations are above).
2. Update Claude Code; confirm `claude --version` in both terminal and VS Code.
3. Create `c:\src\harness` and move this plan in.
4. Run **S1 and S2** first. They decide the most: whether cost per task is exact, and how tier models are applied.
