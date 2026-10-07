// SubagentStop, two jobs:
//  1. require-report: a Harness agent must end with a report header ("DONE: PLAN-7.2"). Without
//     one it is sent back once to add it; a second stop without one is recorded as report "none".
//  2. Records subagent.stopped with the task ids from the header, and the model and effort that
//     actually ran, read from the agent's own transcript (C13).
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../lib/config.mjs";
import { parseReport } from "../lib/ids.mjs";
import { emitEvent } from "../lib/spool.mjs";
import { agentState, isHarnessAgent, readHookInput } from "./input.mjs";

const input = await readHookInput();
const config = loadConfig();
if (config.mode === "off" || !isHarnessAgent(input) || !input.agent_id) process.exit(0);

/**
 * The report a subagent ended with. Usually its last message. But a subagent can hand its report back
 * through the SubagentHandback tool instead, and then its last message is not the report: in the first
 * full run (2026-10-07) every subagent did, each was blocked for "no header" with a correct header in
 * hand, and none of their stops was recorded. So the last handback in the agent's transcript counts too.
 */
function findReport() {
  const fromMessage = parseReport(input.last_assistant_message);
  if (fromMessage.report !== "none") return fromMessage;
  try {
    const lines = readFileSync(input.agent_transcript_path, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const content = JSON.parse(lines[i]).message?.content;
      const handback = Array.isArray(content) ? content.findLast((c) => c.type === "tool_use" && c.name === "SubagentHandback") : null;
      if (handback) return parseReport(handback.input?.message);
    }
  } catch {
    // No transcript to read: the message was all there was.
  }
  return fromMessage;
}

const { report, task_ids } = findReport();

if (report === "none" && !input.stop_hook_active) {
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: "Every Harness agent ends with a report header on its first line, naming the task ids it worked on, e.g. \"DONE: PLAN-7.2\" or \"ESCALATE: PLAN-7.2 — reason\". Write your final report again starting with that header.",
  }));
  process.exit(0);
}

/** Model and effort from the last assistant line of the transcript; the request from meta.json. */
function observed(transcriptPath) {
  const found = {};
  try {
    const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0 && !found.model; i--) {
      const line = JSON.parse(lines[i]);
      if (line.message?.model) {
        found.model = line.message.model;
        if (line.effort) found.effort = line.effort;
      }
    }
  } catch {
    // Transcript unreadable: leave model out rather than guess.
  }
  const meta = transcriptPath?.replace(/\.jsonl$/, ".meta.json");
  if (meta && existsSync(meta)) {
    try {
      const { model } = JSON.parse(readFileSync(meta, "utf8"));
      if (model) found.model_requested = model;
    } catch {
      // No request recorded.
    }
  }
  return found;
}

const started = agentState(config, input.agent_id).take();
const data = {
  report,
  duration_ms: started ? Math.max(0, Date.now() - started.startedMs) : 0,
  partial: report === "none",
  task_ids,
  ...observed(input.agent_transcript_path),
};
if (!["low", "medium", "high", "xhigh", "max"].includes(data.effort)) delete data.effort;

emitEvent(config, "subagent.stopped", {
  session_id: input.session_id,
  prompt_id: input.prompt_id,
  agent_id: input.agent_id,
  agent_type: input.agent_type,
}, data);
process.exit(0);
