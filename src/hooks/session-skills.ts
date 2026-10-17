// SessionStart, once per slot (hooks.json passes the slot number): injects part <slot> of the skills a Harness
// agent's definition preloads, when that agent is the main thread (`claude --agent harness:orchestrator`).
// Claude Code preloads skills into subagents but not into the main thread; see src/lib/skills.ts. It fires
// again after a compaction, so the skills come back with the rest of the session context.
import { pluginRoot } from "../lib/config.ts";
import { slotContext } from "../lib/skills.ts";
import { readHookInput } from "./input.ts";

const input = await readHookInput();
const root = pluginRoot();
const slot = Number(process.argv[2]);
if (root && typeof input.agent_type === "string" && Number.isInteger(slot)) {
  const context = slotContext(root, input.agent_type, slot);
  if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
}
process.exit(0);
