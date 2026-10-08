---
description: Remove the Harness from this repository (or every one, with --all), showing every change first
---
Remove what enrolment set up. Nothing is changed until the person agrees.

1. Read `root` from `~/.harness/plugin.json`, and from the repository root run `node "<root>/bin/harness-forget.mjs"` (add `--all` if the person asked about every repository). That is a dry run.
2. Show what it lists, exactly as printed, including what it says it does not remove and how many spool lines would go.
3. If it names spool lines, recommend `pu harness forget` instead, which checks that PU has received them first.
4. Only on a yes, run it again with `--yes`.
