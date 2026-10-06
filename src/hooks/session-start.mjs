// SessionStart: when the repo has a routing.yaml, tells the session the Harness is active and
// how to call harness-emit (Bash commands can't see CLAUDE_PLUGIN_ROOT, so this hands over the
// absolute path). Silent when the Harness is off.
import { join } from "node:path";
import { loadConfig, pluginRoot } from "../lib/config.mjs";
import { readHookInput } from "./input.mjs";

await readHookInput();
const config = loadConfig();
if (config.mode !== "off") {
  const emit = join(pluginRoot(), "bin", "harness-emit.mjs").replace(/\\/g, "/");
  const context = [
    `The Harness is active in this repository (mode: ${config.mode}).`,
    `Record Harness events with: node "${emit}" <type> --task PLAN-n.m --data '<json>'`,
    "Only the harness:orchestrator agent records plan and task events.",
  ].join("\n");
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
}
process.exit(0);
