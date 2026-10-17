---
name: gfa-precepts
description: The Governance-First Architecture precepts for code written or reviewed in a Harness run. Keyless, headless, layered, domain-named, simple, clean and readable. Preloaded into the Harness implementers and evaluator; not for other sessions.
sources:
  - ~/.claude/skills/governance-os/SKILL.md (The Six Core Precepts)
  - app/(docs)/manual/core/the-same-room.tsx (Headless-First)
---

# GFA precepts

1. **Keyless Zero Trust.** Never put connection strings, keys, passwords or tokens in code or config. Use identity-based access (Managed Identity, `DefaultAzureCredential`). A secret that must exist lives in Key Vault and is read by identity.
2. **Headless.** Rules and data live in the service. Entry points (Functions, route handlers, pages, CLI commands) only gather inputs and call it. No logic goes in an entry point.
3. **Separation of Concerns.** Entry points don't touch data, and repositories hold no business rules. Dependencies point inward: entry point → service → repository or client.
4. **Domain-Driven Design.** Use the domain's exact term, not a plausible synonym: `Cvr` for the Danish business register number, never `CompanyVat`.
5. **Ockham and DRY.** Write the simplest thing that meets the criteria. Reuse the helpers that already exist before you write a new one.
6. **Boy Scout.** Leave the code you touch cleaner than you found it, but only inside the task's scope.
7. **Bus Factor.** Code is read far more than it is written. Use clear names and an obvious structure, and avoid cleverness that needs its author in the room.

**When you implement:** if following the task means breaking a precept, follow `PLAN.md` and name the conflict in your report. Never settle it silently, either way.

**When you review:** name each violation in the diff with its file and line.
