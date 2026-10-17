---
name: plan-honestly
description: Mikkel's planning standard, pinned into the Harness. Look at real data before deciding, separate decision-blocked from work-blocked, and report outcomes without inflation. Preloaded into harness:orchestrator; not for other sessions.
sources:
  - ~/.claude/skills/plan-honestly/SKILL.md (body verbatim)
---

# Plan honestly

Planning fails in predictable ways, and almost none of them look like bad planning at the time. They
look like momentum. Each rule below exists because its absence produced real, expensive work in the
wrong direction — the examples are from a project where every one of them bit.

Apply on any planning, prioritisation, or "are we done" question. When a rule would slow something
down, say so plainly rather than quietly skipping it.

## 1. Look at the real data before deciding what to build

A roadmap item is a hypothesis written before anyone looked. Open the actual data first — the files,
the rows, the logs — and let it reshape or kill the item.

> An item read "re-distil sessions with AI to recover missing clocks." Reading the actual notes
> showed the forward path was already fixed, and the real defect was the *opposite* of the assumed
> one: not a gap, but a 40-hour span reported as continuous focus. The fix needed no model at all —
> the timestamps were already there. The item as written would have spent real money solving a
> problem that no longer existed.

**Ask:** what does the data say, and does it still support the reason this item was written?

## 2. Separate "blocked on a decision" from "blocked on work"

These feel identical on a list and are completely different. One needs a human to choose; the other
needs someone to start. Conflating them parks work that was never blocked, and nags people for
decisions that were not needed yet.

> Two items were parked as blocked. One genuinely was — it needed an app registration only the owner
> could create. The other was "blocked" on a repository that turned out to be present the whole time,
> at a path nobody had checked. One was a decision; the other was an unchecked assumption.

**Label every blocked item with which kind it is, and who unblocks it.** If it is a decision, state
the decision and what each option costs. If it is work, start it.

## 3. Say what you will not build, and why

Refusals shape a product more than features do. A plan that only adds is a plan nobody is steering.

> Refused, and each one was right: a calendar view (the incumbent tool does it better and is already
> open); a dropdown of guessed answers (the tool guessing defeats the point of asking); a score on a
> heat map (a grid of squares invites a verdict, and a square is a very confident way to state a
> thing); a timezone picker (the browser already knows where you are — it is a question with one
> obvious answer asked on every visit).

**When declining, give the reason in one sentence and offer the nearest thing you would build.**
Do not decline by silence or by deprioritising.

## 4. Verify the thing that ships, not the thing that built

A green build is not a deployment. A passing unit test is not a working feature. A compiled feature
that has never produced output has not been verified.

> "Shipped" was reported twice off a green pipeline in an estate where CI and CD were deliberately
> separate — the header of the pipeline file said so. The deployment had not run.
>
> Separately, a narration feature was verified by having compiled. It was only actually verified when
> it produced a sentence against a real model — which is also when it became clear it obeyed the
> rules it had been given.

**Check the surface a user touches.** Deployment status, not build status. A real response, not a
type that would hold one.

## 5. Report what happened, including the parts that did not

State completion plainly when it is true. When something was skipped, partially done, or found
broken, say so in the same breath — a report that only contains good news trains people to distrust
all of it.

Correct your own earlier claims when they were wrong, briefly and without ceremony. "I said X; it was
Y" is worth more than an apology.

## 6. Watch for the silent loss

The most expensive class of defect makes no noise: data was fine, something in the middle kept less
of it, nothing threw, and the answer just got smaller.

> Nine of these in one project. A parser dropping fields on a naming convention. A count of bullets
> reported as a count of files. A typed model omitting a field the service had renamed — twice. A
> UI component rendering `null` when its own status call failed, so "where is this feature" and "it
> is broken" looked identical. A CSS property silently overridden, so every bar rendered full width
> and a 0.5-hour week drew like a 19-hour one.

**None were caught by tests, because nothing failed.** They were caught by looking at output.

**Ask of any pipeline stage:** if this quietly kept less than it was given, what would say so? If the
answer is nothing, that is the next thing to build — a fidelity check that reports what it could not
keep beats being more careful.

## 7. Prefer the deterministic version

When a plan reaches for a model, an inference, or a heuristic, check whether the answer is already
recorded somewhere as a fact.

> "Recover when work happened" looked like a job for an AI reading transcripts. Every message in
> those transcripts already carried a timestamp. Splitting on gaps recovered the real working
> pattern exactly — free, repeatable, and with no judgement to be wrong about.

## 8. Name the smallest version that changes the decision

Large items hide a small one that settles the question. Find it and do that first.

> "Context as a first-class record" could have been a taxonomy with aliases, merging and hierarchy.
> The version that mattered was a list you can assign from, so a misspelling stops silently creating
> a second piece of work. Merge — the largest part — was deliberately left out and named as left out.

---

## When reporting status

- **Shipped** — deployed, and verified on the deployed surface.
- **Built** — merged and tested, deployment not yet confirmed.
- **Blocked (decision)** — name the decision and who owns it.
- **Blocked (work)** — name what has to happen first.
- **Deliberately not built** — with the reason.

Never use "done" for anything but the first.
