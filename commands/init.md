---
description: Enrol this repository in the Harness, showing every change before making it
---
Enrol this repository: give it a home under `~/.harness/repos/`. Nothing in the repository's working tree is written. Nothing is changed until the person agrees.

1. Read `root` from `~/.harness/plugin.json`, and from the repository root run `node "<root>/bin/harness-init.mjs"`. That is a dry run: it changes nothing.
2. Show the person every step it lists, exactly as printed. Say plainly that the one change in the clone itself is `core.hooksPath` in `.git/config`. That setting is local, never committed, and the repository's own hooks keep running after the Harness's.
3. Ask whether to apply. Only on a yes, run it again with `--apply`, then report the doctor summary it prints.

`pu harness` enrols a repository by itself the first time it starts the Harness there, so this is only needed by hand. Never make the listed changes by hand instead: the script is the one place they are defined. `/harness:forget` undoes them.
