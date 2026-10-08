# The Harness in any repository

**Status:** design, reviewed by Mikkel on 2026-10-08. His four decisions are recorded below; one question is still open. Nothing here is built yet.

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
      repo.json                    the clone's path, remote, enrolment date, the hooksPath it had before, its Harness branches
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

`harness-enrol` (it replaces `harness-init`; `/harness:init` stays as the slash command name). Run by hand, it **shows the plan, then asks**, as init does today. Run by `pu harness`, it doesn't ask (see below):

1. Create the home: write `repo.json`, and a `routing.yaml` with the stages detected from the repository (`detectStages`, unchanged: .NET solutions and test projects, npm lint/test/build).
2. Write `settings.json`, the deny rules rewritten for the home (see below).
3. Copy the hook scripts to `~/.harness/githooks/` when they're missing or out of date.
4. Record the clone's current `core.hooksPath` in `repo.json` (empty means `.git/hooks`), then set `core.hooksPath` to `~/.harness/githooks`.
5. Register the spool in `spools.json`.

**Enrolment is automatic** (Mikkel, 2026-10-08). `pu harness` in a repository with no home enrols it without asking, because enrolling changes nothing a person has to review: no files appear in the tree, and the repository's own hooks keep running. It prints what it did, the home's path, the detected stages, and "`pu harness forget` undoes this". When no stages are detected, it still enrols, but says the gate can't pass until stages are added, and names the routing.yaml to edit. `/harness:init` stays for running enrolment by hand.

### Its own git hooks keep working

Setting `core.hooksPath` turns off whatever hooks the repository had: husky (`.husky`), a committed `.githooks`, or `.git/hooks`. A work repository may depend on them. So the hook dispatcher, after its own step, runs **the repository's own hook of the same name** from the `hooksPath` recorded in `repo.json`, with the same arguments, and fails when it fails. Enrolment never silently removes a check the repository's owners put there.

### What the gate gates: Harness branches

**Decided (Mikkel, 2026-10-08): the tool enables, it doesn't block.** The Harness is an add-on to ordinary development, so the git hook gates only **Harness branches**: branches that `pu harness` created or was started on, listed in `repo.json`. Every other branch is left alone, whether that's a colleague's workflow, a quick hand fix or a hotfix. Commits there go straight to the repository's own hooks.

This holds everywhere, PU included. Today PU gates every commit; under this design, Mikkel's hand commits on his own branches stop paying the 1–3 minutes. In repositories he owns, CI (below) still checks every pull request. There's no setting for it: one rule, so there's nothing to configure differently per repository.

How this holds up:
- **Inside a Harness session, every commit is gated, whatever the branch.** That's the Claude Code commit gate (the PreToolUse hook), which is unchanged. So an agent can't escape the gate with `git switch -c` onto an ungated branch.
- **A person's commit on a Harness branch is gated**, because the branch's promise is that every commit on it passed the eval. `git commit --no-verify` is still the person's escape. The deny rules only bind Claude Code sessions, never the person.
- **Merging a Harness branch** goes through the repository's normal review. In repositories Mikkel owns, CI runs the eval on the pull request.

## Deny rules without `.claude/settings.json`

`pu harness` launches Claude Code with:

```text
claude --plugin-dir <plugin> --agent harness:orchestrator
       --settings <home>/settings.json
       --add-dir <home>
```

- `--settings` adds the deny rules to this session only. Ordinary Claude Code sessions in the same repository (VS Code, say) don't get them. They don't load the plugin either, so the Harness isn't active there anyway.
- `--add-dir` lets the orchestrator write `PLAN.md` in the home without a permission prompt.

The rules are today's list (`DENY` in `lib/setup.mjs`), with the guardrail paths moved to the home:

```text
Edit(~/.harness/repos/*/state/**)
Edit(~/.harness/repos/*/routing.yaml)  Edit(~/.harness/repos/*/settings.json)
Edit(~/.harness/githooks/**)
Edit(.github/workflows/**)
...plus the git and gh rules, unchanged
```

Only `Edit(...)` rules: S9 showed that `Write(path)` rules are never matched, and that `Edit` rules cover every file tool. `PLAN.md` stays writable, because the orchestrator writes it. `settings.json` also carries `worktree.baseRef: "head"` (S6). The session-start hook tells the session where the home and its `PLAN.md` are, the same way it hands over the `harness-emit` path today.

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

**Decided (Mikkel, 2026-10-08): every repository Mikkel owns gets the eval in CI.** Repositories he doesn't own never do, because nothing is committed there.

PU's `eval.yml` runs `harness-eval --ci`, which reads the stages from the checked-out `routing.yaml`. A CI runner has no home. So:

- `harness-eval --ci --config <path>` reads the stages from a file you name.
- An owned repository commits `.github/harness-eval.yml`, holding only `eval.stages`, plus the workflow, which passes `--config`.
- **Owned** means the remote's owner is in PU's personal owners (`RepoIdentity.PersonalOwners`, today github.com/sejersen92). Enrolling an owned repository without the two CI files offers to add them as a commit on a Harness branch. That is the one committed change the Harness ever proposes, and only in a repository Mikkel owns.

The costs:
- **The stages are written twice:** in the home's routing.yaml and in the CI file. The doctor warns when they differ.
- **Every owned repository needs the `HARNESS_READ_TOKEN` secret**, because the harness repository is private and the workflow checks it out. That's a step per repository today (see open questions).

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

## One hub: each context knows its clones

**Wanted (Mikkel, 2026-10-08):** a repository the Harness or `pu sync` meets should appear in PU's contexts list without anyone registering it. Each context should show, per device, where that device keeps its clone. A repo might be `c:\src\work\repo` on one machine and `c:\src\repo` on another. Full transparency, from a single hub.

**What exists today:**
- Contexts arrive in PU only through sessions: `pu sync` pushes a session, and its repository becomes a context, matched across machines by remote.
- A repository with no session yet has to be registered by hand ("Register a repository before its first push").
- The device record carries the vault layout, not where any repository lives.

**What changes:**
- **The CLI reports clones.** On each `pu sync`, and at enrolment, it sends one reading per clone it knows: from the repositories its staged sessions ran in, plus every `repo_dir` in `spools.json`. Each reading has the remote, the path on this device, whether the Harness is enrolled there, and when it was last seen. A remote PU hasn't seen before creates its context, with the same matching sessions use.
- **DocumentService stores them on the context:** `clones: [{ deviceId, deviceName, path, harness, lastSeen }]`. This is an additive change (new nullable fields, merged and never replaced), keyed on device plus path, so two clones on one device are two entries.
- **The contexts page** shows the clones under each context, one line per device: `HOME-PC  c:\src\previouslyupcoming  · harness · seen today`.
- **`forget`** reports the clone's `harness: false` on the next sync, so the hub never claims an enrolment that no longer exists.

**Governance:** a clone in a work-domain repository is reported only when the push forwards `--include-work`, the same rule sessions follow (`RepoIdentity.DomainOf`, HarnessSync step 4). The path and remote of a work repository are work data.

This doesn't block anything else in this design. It's its own track, R1 to R3 in the work items, so the H items and W don't wait for it.

## The baseline

**Decided (Mikkel, 2026-10-08): the baseline continues; nothing restarts.** The 10 tasks so far (PLAN-4.1 to 7.3) stay counted. Improving the components doesn't make earlier tasks stop being part of the baseline.

- The count continues in **any** repository. Work-repository tasks land in the Work bucket (2026-10-06), and they're better baseline data than more PU tasks.
- Every line already carries the plugin version (`producer.version`) and `config_sha256`. So before and after the intake gate can still be compared (eval rounds, escalations, first-pass rate) without being split into separate baselines.
- C16's freeze ("don't change the plugin or routing.yaml during a baseline") is relaxed accordingly: changes are allowed, and they're traceable through those two fields.

## Work items, in order

| | Where | What | Depends on |
|---|---|---|---|
| **S9** | harness, by hand | **Done 2026-10-08, passed** ([spikes.md](spikes.md#s9-the-harness-with-nothing-in-the-repository-2026-10-08)). Spike. Do `--settings` deny rules with `~/` and `*` paths apply, and add to the user's own settings rather than replacing them? Can `--add-dir` let the orchestrator write in the home with no prompt? Does Git for Windows accept a `core.hooksPath` outside the repository? Can the dispatcher chain to `.husky/`? | none |
| **P1** | PU CLI | `pu update` installs the Harness when it's missing and runs `--update` when it's present. It sets `cleanupPeriodDays` to at least 180 (never lowering a higher value), replaces the `gh auth login` hint with a credential-neutral one, and doesn't let a failed doctor check make `start` report the install as unfinished. Refresh CONNECTING-A-WORK-PC.md. | none, so it can run alongside S9 |
| **H1** | harness | `repoHome()`, with every path in the table above moved to it, plus the one-release fallback. | S9 |
| **H2** | harness | `harness-enrol` and `harness-forget`; the doctor checks the home and reports orphans. | H1 |
| **H3** | harness | Hook chaining, and gating Harness branches only (`repo.json` lists them). | H2 |
| **H4** | harness | The intake gate: the orchestrator's prompt, `intake.max_ambiguity`, the `plan.intake` event and its schema. | H1 |
| **P2** | PU CLI | `pu harness` enrols automatically when there's no home, records the branch as a Harness branch, and passes `--settings` and `--add-dir`; `pu harness forget [--all]`. | H2 |
| **C1** | harness | `harness-eval --ci --config`; enrolling an owned repository offers the two CI files. | H2 |
| **M** | PU | Migrate PU: the home from its `routing.yaml`; delete `routing.yaml`, `.githooks/` and the `.gitignore` block; CI moves to `--config`; drop the fallback. | P2, H3, C1 |
| **W** | work PC | `pu update`, then `pu harness` in a work repository, on one real task. **Done when that task commits through the gate and shows on the Routing page in the Work bucket.** | M |

P1 and S9 go first and in parallel. The H items are harness work, and each can be an orchestrator run in the harness repository once H1 lands.

The hub track (see "One hub") runs alongside and blocks nothing:

| | Where | What | Depends on |
|---|---|---|---|
| **R1** | DocumentService | `clones[]` on the context (additive, keyed on device plus path); a push of clone readings that creates unknown contexts. | none |
| **R2** | PU CLI | Clone readings on `pu sync` and at enrolment, from staged sessions and `spools.json`, following the include-work rule. | R1 |
| **R3** | web | The clones per device on the contexts page. | R1 |

## Decided (2026-10-08)

1. **Gate Harness branches only**, everywhere, PU included. The tool enables, it doesn't block.
2. **Every repository Mikkel owns gets the eval in CI.**
3. **The 10 tasks stay in the baseline.** The baseline continues, and the plugin version tells the versions apart.
4. **Enrolment is automatic** on `pu harness`.

## Open questions

1. **`HARNESS_READ_TOKEN` in every owned repository.** CI checks out the private harness repository, so each owned repository needs the secret. The options:
   - (a) `pu harness` sets it with `gh secret set` from a token kept locally. That's one more credential on disk.
   - (b) Make the harness repository public. It holds no secrets, but it's your call.
   - (c) Publish `harness-eval` as a release asset that a workflow can download without a token, if the repository is public anyway.

   (b) is the simplest by far, and makes (c) unnecessary.

## Briefs

Each brief is written in the intake format, so it's also an example of what the gate asks for. To run one, start from a clean `main` in the repository the brief names, run `pu harness`, give the new branch a name, and paste the brief.

### Brief P1: `pu update` sets up the Harness (PreviouslyUpcoming)

Suggested branch: `feat/update-covers-harness`.

```text
GOAL
`pu update` sets up the Harness on this machine, so that on a fresh PC (the work PC first)
install.ps1 followed by `pu update` is everything needed before `pu harness`. It also stops Claude
Code from deleting the transcripts that cost per task is read from.

WHAT CHANGES
1. Three new checks in `pu update` (Setup_ in Program.cs). Put the logic in pure functions in
   Setup.cs or HarnessInstall.cs so it can be tested; follow the Check record's report-then-fix style.
   a. Node: ok when `node --version` is 22 or later. Reported, never installed (like the .NET SDK).
      Manual: winget install OpenJS.NodeJS.LTS
   b. Harness: ok when the plugin is at HarnessInstall.ResolveTarget(null, recorded root, the PU
      clone) and is current with its remote's default branch. Reuse Setup.ReadClone on the harness
      checkout for "current". Found text says the version and folder, "not installed", or how far
      behind. Fix: HarnessInstall.Run with update = already installed.
      Place it after "Claude Code" and "PATH". The "pu build" check stays last.
   c. Transcripts kept: ok when cleanupPeriodDays in ~/.claude/settings.json is 180 or more. Fix:
      set it to 180 when it's missing or lower. Never lower a higher value; keep every other key;
      back the file up first, as "hook wiring" does; leave invalid JSON alone and say so.
2. HarnessInstall.Run returns 0 when the checkout is in place and its location is recorded,
   whatever the doctor finds. The doctor's lines are still printed. pu harness start must no longer
   say "The install did not finish" after a doctor warning.
3. The hint when `git clone` of the harness fails is credential-neutral. Drop `gh auth login`. Say the
   repository is private and git needs credentials for github.com/Sejersen92/harness, give
   examples (Git Credential Manager, `gh auth setup-git`, or a folder-scoped includeIf in
   ~/.gitconfig), then "run pu update again".
4. install.ps1 installs Node LTS with winget when it's missing, as it already does for git and .NET.
5. CONNECTING-A-WORK-PC.md: replace the stale install sections (the 0.1.0 pin, the single exe, the
   four commands) with the current path: install.ps1 once, then pu update, then pu harness. Keep the
   include-work and "what it does and does not carry" sections as they are.
6. CLI version 1.17.0 and a CHANGELOG entry.

SUCCESS SIGNALS (each is a test, except the last)
- cleanupPeriodDays: missing gives 180; 30 gives 180; 365 stays 365; other keys are kept
  byte-for-byte in value; invalid JSON is not written.
- Node: "v22.16.0" passes; "v20.11.1" fails; no node fails.
- Harness check: not installed, current and behind each give the right ok and found text.
- HarnessInstall.Run returns 0, and still prints the doctor's lines, when the doctor exits 1 after a
  good install. It still returns 1 when the clone, the pull or the location record fails.
- The clone-failure output contains no "gh auth login" and does name credentials.
- harness-eval passes.
- By hand, for Mikkel: `pu update --dry-run` on the home PC lists Node, Harness and Transcripts kept.

BOUNDARIES
In scope: cli/PreviouslyUpcoming.Cli (Program.cs Setup_, Setup.cs, HarnessInstall.cs, and
HarnessStart.cs only where item 2 needs it), its tests, install.ps1, CONNECTING-A-WORK-PC.md,
CHANGELOG.md, and the csproj version.
Out of scope: everything else in ANY-REPO.md. No ~/.harness/repos, no enrolment, no forget, and no
change to how pu harness launches claude. No web, DocumentService or harness-repository changes.
Must not touch: other keys in the user's settings.json; the rule that the "pu build" check runs
last; any compiled-in machine path.

DECISIONS
- 180 days (Mikkel, 2026-10-07). Never lower a higher value.
- pu update reports Node and doesn't install it; install.ps1 installs it.
- The Harness's folder comes from ResolveTarget as it is today. No new location rules.
- Check names and wording: the orchestrator decides, matching the existing checks.
```
