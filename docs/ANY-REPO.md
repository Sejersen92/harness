# The Harness in any repository

**Status:** design, for review (2026-10-08). Nothing here is built yet.

**What this is for:** today the Harness only works in a repository that commits it: `routing.yaml`, `.githooks/`, a `.gitignore` block and deny rules in `.claude/settings.json`. That rules out every repository Mikkel doesn't own, which is all of his work. This design makes the Harness work in **any** git repository without adding one byte to it, so `pu update` on the work PC followed by `pu harness` in a work repository is enough to start.

It also adds the **intake gate**: the orchestrator doesn't start a task until its brief is unambiguous.

## Principles

1. **Nothing in the working tree.** An enrolled repository gets no new files, no `.gitignore` lines and no `.git/info/exclude` entries. The only change is one key in `.git/config`, which is local to the clone and never committed.
2. **One central place.** Everything the Harness keeps for a repository lives in one folder under `~/.harness/repos/`. Listing that folder lists every repository the Harness has touched.
3. **Easy to sanitise.** `pu harness forget` removes everything for one repository; `--all` removes it for every repository. After a forget, the clone is exactly as it was before enrolment.
4. **One way.** PU and the harness repository move to the same model. Nothing is special-cased for repositories Mikkel owns.

## The layout

```text
~/.harness/                        ($HARNESS_HOME overrides, as today)
  plugin.json                      where the plugin lives (unchanged)
  spools.json                      the spool registry PU reads (unchanged format; paths move)
  githooks/                        the four hook scripts, copied from templates/githooks/
    harness  pre-commit  commit-msg  post-commit
  repos/
    previouslyupcoming-3f9a1c2b/   one home per enrolled clone
      repo.json                    the clone's path, remote, enrolment date, the hooksPath it had before
      routing.yaml                 mode, tiers, eval stages, gate settings (was at the repo root)
      settings.json                the deny rules, passed to Claude Code at launch (was .claude/settings.json)
      PLAN.md                      the orchestrator's plans (was at the repo root)
      events/  routing-log/  configs/   the spool (was .harness/)
      state/eval-pass.json         the pass marker (was .claude/state/)
```

### The home's name

`<repo name>-<first 8 hex of sha256(the clone's top-level path)>`. The path is normalised first: lower case, forward slashes, no trailing slash. That fixes the `c:\` / `C:\` mismatch VS Code causes (spike S6).

- **Why the path and not the remote:** two clones of one remote (a second checkout, or a worktree at M6) need separate markers and separate plans. Keying on the remote would make them share both.
- **Why a readable prefix:** so `dir ~/.harness/repos` tells a person which folder is which repository before they delete anything.
- **The cost:** moving a clone to another folder makes it a new enrolment. The old home is then an orphan, which the doctor reports and `forget` removes.

### How everything finds the home

One function, `repoHome(dir)` in `lib/config.mjs`, computes the name from the git top level. It replaces every place that builds a path from the repository root today:

| Today | Moves to |
|---|---|
| `loadConfig`: `<repo>/routing.yaml` | `<home>/routing.yaml` |
| `metadataDir`: `<repo>/.harness` | `<home>` (`metadata.dir` is dropped from routing.yaml) |
| `markerPath`: `<repo>/.claude/state/eval-pass.json` | `<home>/state/eval-pass.json` |
| `plan.mjs`: `<repo>/PLAN.md` | `<home>/PLAN.md` |
| `setup.mjs`: settings, .gitignore, .gitattributes, .githooks | the home and `~/.harness/githooks` |

No home means the Harness is off for that repository, just as no `routing.yaml` means it today. For one release, a `routing.yaml` at the repository root is still read when there's no home, so PU keeps working until it migrates. That fallback is then deleted, keeping to principle 4.

## Enrolling a repository

`harness-enrol` (it replaces `harness-init`; `/harness:init` stays as the slash command name). It **shows the plan, then asks**, as init does today:

1. Create the home: write `repo.json`, and a `routing.yaml` with the stages detected from the repository (`detectStages`, unchanged: .NET solutions and test projects, npm lint/test/build).
2. Write `settings.json`, the deny rules rewritten for the home (see below).
3. Copy the hook scripts to `~/.harness/githooks/` when they're missing or out of date.
4. Record the clone's current `core.hooksPath` in `repo.json` (empty means `.git/hooks`), then set `core.hooksPath` to `~/.harness/githooks`.
5. Register the spool in `spools.json`.

`pu harness start` runs it when you start the Harness in a repository with no home, after asking.

### Its own git hooks keep working

Setting `core.hooksPath` turns off whatever hooks the repository had: husky (`.husky`), a committed `.githooks`, or `.git/hooks`. A work repository may depend on them. So the hook dispatcher, after its own step, runs **the repository's own hook of the same name** from the `hooksPath` recorded in `repo.json`, with the same arguments, and fails when it fails. Enrolment never silently removes a check the repository's owners put there.

### What the gate gates

Today the pre-commit hook gates every commit in PU, including Mikkel's own (1–3 minutes each; accepted for PU). In a work repository whose stages are `dotnet build` and `dotnet test`, gating every hand commit is friction the tool shouldn't add.

New setting, `gate.scope` in routing.yaml:
- `harness-branches` (the default for a new enrolment): the git hook gates only commits on branches `pu harness start` created or was started on. Those are listed in `repo.json`. Commits on any other branch go straight through, to the repository's own hooks.
- `all`: every commit, as PU does today. PU keeps `all`.

The Claude Code commit gate (the PreToolUse hook) is unchanged: inside a Harness session, every commit needs a pass.

## Deny rules without `.claude/settings.json`

`pu harness start` launches Claude Code with:

```text
claude --plugin-dir <plugin> --agent harness:orchestrator
       --settings <home>/settings.json
       --add-dir <home>
```

- `--settings` adds the deny rules to this session only. Ordinary Claude Code sessions in the same repository (VS Code, say) don't get them. They don't load the plugin either, so the Harness isn't active there anyway.
- `--add-dir` lets the orchestrator write `PLAN.md` in the home without a permission prompt.

The rules are today's list (`DENY` in `lib/setup.mjs`), with the guardrail paths moved to the home:

```text
Edit(~/.harness/repos/*/state/**)      Write(~/.harness/repos/*/state/**)
Edit(~/.harness/repos/*/routing.yaml)  Edit(~/.harness/repos/*/settings.json)
Edit(~/.harness/githooks/**)           Write(~/.harness/githooks/**)
Edit(.github/workflows/**)
...plus the git and gh rules, unchanged
```

`PLAN.md` stays writable, because the orchestrator writes it. The session-start hook tells the session where the home and its `PLAN.md` are, the same way it hands over the `harness-emit` path today.

`attribution.commit: ""` is no longer set by the Harness. Whether a repository's commits carry an AI trailer is that repository's choice. PU's committed `.claude/settings.json` keeps it, and the commit-msg hook still strips trailers in PU.

## Forgetting a repository

`harness-forget [<dir>] [--all] [--yes]`, wrapped by `pu harness forget`:

1. Lists what it will remove: the home, the `core.hooksPath` change, the spool's `spools.json` entry.
2. **Refuses while the spool has lines PU hasn't sent**, naming how many. Either run `pu sync` first, or pass `--discard-unsent` to throw them away on purpose.
3. On confirmation: restores the recorded `core.hooksPath` (or unsets it), deletes the home, and removes the registry entry.

With `--all`, it does the same for every home, plus `~/.harness/githooks/`. `plugin.json` and the plugin checkout stay; uninstalling the plugin itself is a separate step.

**What forget doesn't touch:**
- What was already sent to PU. That's deleted the PU way, by deleting the context on the web.
- Claude Code's own transcripts in `~/.claude/projects/`, which belong to Claude Code, not the Harness.

Forget says both of these when it finishes, so "sanitised" never means more than it does.

## CI

PU's `eval.yml` runs `harness-eval --ci`, which reads the stages from the checked-out `routing.yaml`. A CI runner has no home. So:

- `harness-eval --ci --config <path>` reads the stages from a file you name.
- PU commits `.github/harness-eval.yml`, holding only `eval.stages`, and its workflow passes `--config`. This is opt-in, for a repository whose owner wants CI to run the same checks.
- Work repositories never get it, since nothing is committed there.

The cost: in PU, the stages are then written in two places (the home's routing.yaml and the CI file). The doctor warns when they differ.

## The intake gate

**The rule:** the orchestrator dispatches nothing until the plan's brief scores **ambiguity 0** on the rubric's own scale (0: the spec is complete, with one obvious solution; 1: some decisions are left open; 2: requirements are unclear or conflicting).

**The evidence it's needed:** of the 17 tasks run so far, all from written briefs, 7 scored ambiguity 1. PLAN-3.3, one of them, ended with the implementer escalating on a test written to the wrong reading of the brief.

**What a brief must hold**, as a new first section of each plan in `PLAN.md`:

- **Goal:** one or two sentences: what changes, and for whom.
- **Success signals:** every one checkable, as a test, a command's output or a page state, by someone other than the implementer. These become the tasks' acceptance criteria.
- **Boundaries:**
  - *in scope*: the files or areas the work may touch;
  - *out of scope*: what it won't do, even if it seems related;
  - *must not touch*: what stays unchanged, such as public contracts, data or other teams' code.
- **Decisions:** each open question, either settled or explicitly delegated ("the orchestrator chooses X"). A delegated decision counts as settled, and the plan records what was chosen.

**How it runs:**

1. The orchestrator drafts the brief from the request and scores its ambiguity.
2. At 1 or 2, it asks the person the specific open questions, a few at a time, never "anything else?". Then it re-scores.
3. At 0, it plans the tasks and continues as today.
4. Run headless (`-p`), it can't ask. It stops with the questions as its output and dispatches nothing.

The threshold is `intake.max_ambiguity` in routing.yaml, default 0. Each round is recorded as a `plan.intake` event (questions asked, ambiguity before and after), so PU can show how much asking a brief needed. That's an additive schema change (EVENTS.md, a v1 minor). The tasks' own rubric scoring is unchanged: a task can still score ambiguity 1 when splitting the plan exposes something the brief didn't. That's information, not a block.

**An example.** "I think I like colors red, blue and green" scores 2. The orchestrator would ask: Where do the colours go? Do they replace existing ones or add to them? What would show it worked: the contrast check passing, or Mikkel's eye? What must stay as it is?

## The baseline

The plugin changes how tasks are specified, which is part of what the baseline measures. So:

- The K5 count restarts at the plugin version that ships the intake gate, in **any** repository. Work-repository tasks are better baseline data than more PU tasks, and they land in the Work bucket (2026-10-06).
- The 10 tasks so far (PLAN-4.1 to 7.3) stay in PU as a **pre-intake cohort**. Comparing the two cohorts (eval rounds, escalations, first-pass rate) is the first measure of whether the gate helps.

## Work items, in order

| | Where | What | Depends on |
|---|---|---|---|
| **S9** | harness, by hand | Spike. Do `--settings` deny rules with `~/` and `*` paths apply, and add to the user's own settings rather than replacing them? Can `--add-dir` let the orchestrator write in the home with no prompt? Does Git for Windows accept a `core.hooksPath` outside the repository? Can the dispatcher chain to `.husky/`? | none |
| **P1** | PU CLI | `pu update` installs the Harness when it's missing and runs `--update` when it's present. It sets `cleanupPeriodDays` to at least 180 (never lowering a higher value), replaces the `gh auth login` hint with a credential-neutral one, and doesn't let a failed doctor check make `start` report the install as unfinished. Refresh CONNECTING-A-WORK-PC.md. | none, so it can run alongside S9 |
| **H1** | harness | `repoHome()`, with every path in the table above moved to it, plus the one-release fallback. | S9 |
| **H2** | harness | `harness-enrol` and `harness-forget`; the doctor checks the home and reports orphans. | H1 |
| **H3** | harness | Hook chaining and `gate.scope`. | H2 |
| **H4** | harness | The intake gate: the orchestrator's prompt, `intake.max_ambiguity`, the `plan.intake` event and its schema. | H1 |
| **P2** | PU CLI | `pu harness start` enrols when there's no home and passes `--settings` and `--add-dir`; `pu harness forget [--all]`. | H2 |
| **M** | PU | Migrate PU: the home from its `routing.yaml`; delete `routing.yaml`, `.githooks/` and the `.gitignore` block; CI moves to `--config`; drop the fallback. | P2, H3 |
| **W** | work PC | `pu update`, then `pu harness` in a work repository, on one real task. **Done when that task commits through the gate and shows on the Routing page in the Work bucket.** | M |

P1 and S9 go first and in parallel. The H items are harness work, and each can be an orchestrator run in the harness repository once H1 lands.

## Open questions for Mikkel

1. **`gate.scope` default for a new enrolment:** `harness-branches` (recommended), or `all` everywhere as in PU?
2. **CI in PU:** a second committed file just for CI's stages (recommended), or no CI eval, leaving the local gate as the only one?
3. **The pre-intake cohort:** keep the 10 tasks as a comparison (recommended), or drop them from the baseline altogether?
