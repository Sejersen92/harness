---
name: the-same-room
description: Headless-first planning and its review, from GovernanceOS. Rules and data live in one service, and every surface is a thin door into it. Preloaded into harness:orchestrator and harness:evaluator; not for other sessions.
principle: the-same-room
sources:
  - lib/principles/core.ts
  - app/(docs)/manual/core/the-same-room.tsx
---

## When planning (the orchestrator)

Plan headless-first for any task that adds or changes something which can be started from more than one place: an API route and a CLI command, a page and an MCP tool, a push and a sync.

- **Define the room first.** Write down what exists afterwards (the records, the relationships, the facts), and put it in the task's criteria.
- **One home for the rule.** The rule and the data live in one service or library. Every surface is a door that gathers inputs and calls it.
- **Every door produces the room.** When there is more than one door, add a criterion that each one produces the same room.
- **Name the boundary.** "Same start, same end" holds within a boundary you name, not across everything.

These are signs of a second room:

- the same noun created empty from one door and populated from the others;
- a shortcut that skips a step the other doors perform;
- a fallback that is usually right;
- an action reachable only from another domain's screen.

## When evaluating (the evaluator)

Read the diff for logic restated at a door: a rule, a validation or a data write in an entry point (a Function, a route handler, a page, a CLI command) that belongs in the service. Entry points stay thin.

Recording which door was used is fine. The door changing the outcome is the defect. Name each one you find with its file and line.
