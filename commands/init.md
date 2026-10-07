---
description: Set the Harness up in this repository, showing every change before making it
---
Set the Harness up in this repository. Nothing is changed until the person agrees.

1. Read `root` from `~/.harness/plugin.json`, and from the repository root run `node "<root>/bin/harness-init.mjs"`. That is a dry run: it changes nothing.
2. Show the person every step it lists and the `.claude/settings.json` diff exactly as printed. Say plainly that the deny rules apply to **every** Claude Code session in this repository, not only the Harness's, and that a committed `routing.yaml` and `.githooks/` affect everyone who clones it.
3. Ask whether to apply. Only on a yes, run it again with `--apply`, then report the doctor summary it prints.

Never edit the files it lists by hand instead: the script is the one place these changes are defined.
