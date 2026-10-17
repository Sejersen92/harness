---
name: definition-of-done
description: What Done means when the Harness evaluator judges a task, from the GovernanceOS Lens. Binary, with evidence for every criterion. Preloaded into harness:evaluator; not for other sessions.
sources:
  - app/(docs)/manual/lens/dod.tsx
---

# Definition of Done

*Done is binary.* A task is Done when every acceptance criterion is met, the tests that validate them pass, and evidence exists for each one. "Almost done" is not a state.

In EVALUATE, judge each `PLAN-n.m/AC-k` as met or not met, against these checks:

- **Evidence for each criterion:** a passing test's name, a command's output, or the lines in the diff that meet it. A criterion without evidence is not met.
- **The eval is necessary, not sufficient.** A harness-eval pass with an unmet criterion is still a FAIL.
- **Behaviour, not code.** Staged code isn't Done. What it does is. If no test here can check a criterion (it needs a page or a deployed service), name it as untestable here and say how to check it. Never pass it on assumption.
- **No weakened tests.** A weakened test (an assertion removed, a test skipped or deleted) voids the evidence it gave.
