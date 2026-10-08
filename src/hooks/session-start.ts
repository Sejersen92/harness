// SessionStart: when the repo has a routing.yaml, tells the session the Harness is active and
// how to call harness-emit (Bash commands can't see CLAUDE_PLUGIN_ROOT, so this hands over the
// absolute path). Silent when the Harness is off.
//
// It also records where the plugin lives (~/.harness/plugin.json), whatever the mode, so a
// repository's git hooks can find it when a commit is made outside Claude Code.
import { join } from "node:path";
import { loadConfig, pluginRoot, producer } from "../lib/config.ts";
import { recordPluginRoot } from "../lib/spool.ts";
import { readHookInput } from "./input.ts";

await readHookInput();
recordPluginRoot(pluginRoot(), producer().version);
const config = loadConfig();
if (config.mode !== "off") {
  const bin = (name: string): string => join(pluginRoot() ?? "", "bin", `${name}.mjs`).replace(/\\/g, "/");
  const context = [
    `The Harness is active in this repository (mode: ${config.mode}).`,
    `Record Harness events with: node "${bin("harness-emit")}" <type> --task PLAN-n.m --data '<json>'`,
    `Run the eval on what is staged with: node "${bin("harness-eval")}" --task PLAN-n.m (a pass is what allows a commit)`,
    "Only the harness:orchestrator agent records plan and task events.",
  ].join("\n");
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
}
process.exit(0);
