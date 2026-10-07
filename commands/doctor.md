---
description: Check that the Harness is set up and healthy in this repository
---
Run the Harness doctor and report what it found.

1. Read `root` from `~/.harness/plugin.json` (the plugin writes it whenever a session starts with it).
2. From the repository root, run `node "<root>/bin/harness-doctor.mjs"`.
3. Show its table exactly as printed. For each `warn` or `fail`, add one line on what would fix it. `/harness:init` fixes everything except the Node and Claude Code versions.

Don't change anything yourself unless the person asks.
