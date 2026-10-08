// SubagentStart: records subagent.started for the plugin's own agents, and remembers the start
// time so SubagentStop can report a duration.
import { loadConfig } from "../lib/config.ts";
import { emitEvent } from "../lib/spool.ts";
import { agentState, isHarnessAgent, readHookInput } from "./input.ts";

const input = await readHookInput();
const config = loadConfig();
if (config.mode !== "off" && isHarnessAgent(input) && input.agent_id) {
  const event = emitEvent(config, "subagent.started", {
    session_id: input.session_id,
    prompt_id: input.prompt_id,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
  }, {});
  if (event) agentState<{ started: string; startedMs: number }>(config, input.agent_id).save({ started: event.ts, startedMs: Date.now() });
}
process.exit(0);
