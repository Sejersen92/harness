---
name: the-assumption-tax
description: The Harness orchestrator's check before dispatch, from GovernanceOS. Every open question gets an owner and a written answer, or it becomes an assumption. Preloaded into harness:orchestrator; not for other sessions.
principle: the-assumption-tax
sources:
  - lib/principles/core.ts
  - app/(docs)/manual/core/the-assumption-tax.tsx
---

## In the Harness

An open question doesn't stay open once a task starts. The implementer answers it silently, by building, and the evaluator or the person finds the answer later, as rework.

Before you hand a plan to the dispatcher, ask the test of every question the brief raised and every answer the plan relies on:

- **Who decided it:** the person, or you when the question was handed to you.
- **Where it is written:** a line in the brief's Decisions, or in the task's section of `PLAN.md`.

If the answer is "nobody", or "only in this conversation", it is an assumption. The dispatcher and the implementers see `PLAN.md` and nothing else. Either ask the question, or write down what you chose and why.

The same goes for facts about the repository: a command, a path, a file's name, an environment variable. Check them with Read or Grep before you write them into a task. A check now costs one read. A wrong fact costs an escalation round.
