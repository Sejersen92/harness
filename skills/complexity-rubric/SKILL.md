---
name: complexity-rubric
description: The Harness complexity rubric. Score every planned task on six dimensions (0-2 each), map the total to a tier, apply the override rules. Used by the harness orchestrator when planning.
---

# Complexity rubric

Every task is scored on six dimensions, each 0, 1 or 2, giving a total of 0 to 12 that maps to one of four tiers. Six coarse judgments are more reliable than one fine-grained number, and each score carries a one-line justification so a wrong call can be traced.

*From the Harness design (docs/sources/01-harness.pdf, pages 3–5), verbatim except where noted. Changing anything here changes routing: bump the plugin version, and never change it during a baseline (C16).*

## Dimensions

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Ambiguity | Spec is complete; one obvious solution | Some decisions left open | Requirements unclear or conflicting |
| Blast radius | One file or module | Several modules in one service | Crosses a service boundary, public API or shared contract |
| Coupling | Isolated code | Touches shared utilities or config | Touches auth, payments, data model or messaging |
| Novelty | Pattern exists in the repo | Pattern exists elsewhere, adapt it | New pattern, library or integration |
| Reversibility | Pure code change, revert is trivial | Needs coordinated revert (config, flags) | Data migration, schema change or external side effect |
| Verification difficulty | Unit tests cover it | Needs integration or e2e tests | Needs judgment: UX, performance, concurrency, security |

In metadata the dimensions are always written with these names: `ambiguity`, `blast`, `coupling`, `novelty`, `reversibility`, `verification`.

Any change under a contracts folder scores 2 on Blast radius automatically.

## Tiers

| Tier | Total | Agent | Typical work |
|---|---|---|---|
| T1 | 0–2 | `harness:impl-t1` | Renames, boilerplate, docs, config edits, test fixtures |
| T2 | 3–6 | `harness:impl-t2` | Most features and fixes inside one service |
| T3 | 7–9 | `harness:impl-t3` | Multi-module changes, new integrations with known patterns |
| T4 | 10–12 | `harness:impl-t4` | Cross-service work, novel design under uncertainty |

*Not verbatim:* the model for each tier is not part of the rubric. It comes from `routing.yaml` (D1).

The tier the total implies is the **score band**. The tier you choose after the override rules is the **planned tier**. Record both.

## Override rules

These apply after scoring and only ever raise the tier:

- Any **2 on Reversibility** → at least T3, and the plan must include a rollback step.
- Any **2 on Coupling** where security is involved (auth, secrets, permissions) → T4 and a human review flag on the PR.
- **Two or more 2s** anywhere → at least T3.
- A task you cannot score confidently is **split**, not rounded up.

Record each override that fired by name: `reversibility_2`, `security_coupling`, `two_or_more_2s`.

## Examples

| Task | Scores (A·B·C·N·R·V) | Total | Tier |
|---|---|---|---|
| Rename a DTO field used in one service | 0·1·0·0·0·0 | 1 | T1 |
| Add an endpoint following an existing controller pattern | 0·1·1·0·0·1 | 3 | T2 |
| Add retry and dead-letter handling to a message consumer | 1·1·2·1·1·2 | 8 | T3 |
| Introduce a new event contract consumed by three services | 2·2·2·2·1·2 | 11 | T4 |

Prefer the cheapest tier the rubric allows. Never raise a tier "to be safe"; split the task instead.
