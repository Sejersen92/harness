# H10: A security review step for T4 tasks

**Status:** brief, 2026-11-10. Shape agreed by Mikkel the same day. Builds on 0.16.0.

## Why

The complexity rubric says a task with security coupling (auth, secrets, permissions) is T4 and gets "a human review flag on the PR" (`skills/complexity-rubric/SKILL.md:45`). Nothing implements that sentence. No agent reviews the work for security, nothing records that a review happened, and nothing creates the flag. In pu, PLAN-20 to PLAN-32 (the gov-os device link) were all T4. They were merged and deployed, and the "needs a human security review" threads stayed open with nothing to close them against.

On 2026-11-10 a one-off, read-only review of that code found nothing high severity, one medium and four low findings (PreviouslyUpcoming PR #161). The medium one would never have shown up in a cloud test. `pu harness programme new --govos` skipped the https base check every `pu govos` command runs, so a hand-edited `govos.json` would have sent the refresh token in clear text. It sat on the client, behind a misconfiguration. The review took about 2.5 minutes. H10 makes that review a step of every T4 task and leaves a record a person can sign.

What H10 is not: a pen test, a load test or anything run against a deployed system. Those happen after release, in Gov-Gate (authorization, authentication, impersonation and headers against dev and UAT, and only read-only probes against production). H10 covers the code before it merges. Gov-Gate covers the running system after release.

## What it does

1. **A new agent, `harness:security-reviewer`** (`agents/security-reviewer.md`). It runs on Opus and is read-only: Read, Grep, Glob, plus Bash only for `git -C <dir> diff`, `git -C <dir> log` and `git -C <dir> show`. It never edits, stages or commits. Its input is the task's PLAN.md section and the staged diff. It reads the code the diff calls and is called by, not only the changed lines.
   It checks:
   - secrets and tokens at rest and in output (stdout, logs, exceptions, events, spool files);
   - where a credential can be sent (base URLs, schemes, redirects, hosts taken from input or config);
   - authN and authZ on every path the diff adds, including paths that bypass a check other paths make;
   - trust in input and server replies (parsing, size limits, crashes);
   - paths and ids that reach file names or URLs;
   - races on credentials (lock, read, write).
   Each finding names a severity, `file:line`, the concrete failure, and the smallest fix. A finding it cannot point to in the code is dropped. The report also lists what was checked and found sound, so "no findings" means something.
2. **The dispatcher runs it for every T4 task**, after the evaluator's `PASS` and before the commit (a new step 3b in `agents/dispatcher.md`):
   - **High:** stop and hand back (a new stop rule). The work stays staged and uncommitted.
   - **Medium:** one fix round. The implementer gets the findings like an evaluator `FAIL`, then EVALUATE and the security review run again. A medium still there after that round stops and hands back.
   - **Low or none:** commit. The low findings are recorded and don't block.
3. **The record.** Each review is written to the home at `reviews/PLAN-n.m.security.md`. The event is `security.reviewed`, with data `{ "high": n, "medium": n, "low": n, "round": k }` (added to `docs/EVENTS.md` and the schema).
4. **The PR block.** `harness-review-block SERIES-n` (or `PLAN-n`) prints one Markdown section for the PR description. It has a table of every finding across the series' T4 tasks with their status (fixed in round k / open), the "checked and sound" lists, and one unticked checkbox: `- [ ] Security review read and accepted by a person`. Ticking that box is the human record. GitHub keeps the edit history, and a person can't approve their own PR, so the box is how a solo author signs. pu can later close a `*-security-review` thread when it sees the box ticked on a merged PR. That is a pu task, not part of H10.

## Decisions

- **D1 Which tasks:** every T4 task (Mikkel, 2026-11-10). T4 comes either from the security-coupling override or from the score. Reviewing both costs little and avoids a second rule.
- **D2 Severities:** high stops, medium gets one fix round, low is listed (Mikkel, 2026-11-10).
- **D3 The reviewer is a separate agent, not the evaluator.** The evaluator judges the criteria the plan wrote, and a security finding is mostly something no criterion wrote down. Keeping them apart stops the evaluator's verdict from changing in meaning.
- **D4 The reviewer only reads the code.** It never runs the code or makes network calls. That keeps it safe in an unattended run and keeps it to one thing.
- **Open for Mikkel:** should `harness-review-block` also print an empty block for a series with no T4 tasks ("no task needed a security review")? Claude's view: yes, so every PR answers the question.

## Acceptance criteria (for the sitting to refine)

- AC-1 `agents/security-reviewer.md` exists with the tools above. A hook refuses any Edit, Write or `git add`/`commit` from it.
- AC-2 For a T4 task, the dispatcher dispatches `harness:security-reviewer` after `PASS` and before `git commit`. For a T1 to T3 task it doesn't (checked in the dispatcher's event trail on a fixture series).
- AC-3 A review with one high finding stops the run with the new stop rule and leaves the work staged. A medium finding gives exactly one fix round, and a second medium stops the run. Low or none commits.
- AC-4 `reviews/PLAN-n.m.security.md` is written and `security.reviewed` is emitted for every review, with the counts. The event validates against the schema.
- AC-5 `harness-review-block SERIES-n` prints the table, the "checked and sound" lists and the unticked checkbox, from the review files alone. It prints the same output twice in a row.
- AC-6 The rubric's line 45 points at H10 instead of the bare "human review flag on the PR".
- AC-7 Version 0.17.0 and CHANGELOG.

## How to run it

Mikkel runs it as a Harness series in this repository, or by hand like H9. It doesn't depend on a pu change. The first real use is the next T4 plan in any enrolled repository.
