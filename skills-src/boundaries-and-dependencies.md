---
name: boundaries-and-dependencies
description: How a Harness plan maps its edges and names its dependencies, from the GovernanceOS Lens. In scope, out of scope and must-not-touch, and no unnamed dependency. Preloaded into harness:orchestrator; not for other sessions.
sources:
  - app/(docs)/manual/lens/boundaries.tsx
---

# Boundaries and dependencies

*Boundaries are edges, not blockers.* Once you know the edges, you can work inside them instead of renegotiating them.

## The edges

Map four edges before you plan the tasks:

| Edge | What to name |
|---|---|
| Internal | Domain rules, and where data and objects live in this repository |
| External | Other repositories, services, APIs and third parties the work calls, or is called by |
| Process | Who decides or approves: the person, another team |
| Data | Which system is the source of truth for each piece of data the work reads or writes |

They go into the brief's Boundaries: in scope, out of scope, must not touch. A task's Scope lists only files inside "in scope". A task that needs a must-not-touch file is a stop for the person, not a scope you widen.

## Dependency contracts

Hope is not a dependency strategy. Name every dependency in Decisions or in the task's section, with:

- what is needed, and why;
- the owner;
- what happens if it isn't there, and the fallback.

No unnamed dependency is dispatched. A dependency between tasks goes on the task's "Depends on" line.
