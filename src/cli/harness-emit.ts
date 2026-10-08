// harness-emit <type> [--plan PLAN-7] [--task PLAN-7.2] [--data '<json object>']
//
// The only writer of Harness Events v1. The orchestrator calls it through Bash. The session id
// comes from CLAUDE_CODE_SESSION_ID, so the model never types it. After task.completed it also
// writes the task's routing-log record. Always exits 0: telemetry never blocks work.
import { loadConfig } from "../lib/config.ts";
import { emitEvent, recordFailure } from "../lib/spool.ts";
import { writeTaskRecord } from "../lib/tasklog.ts";
import { messageOf } from "../lib/types.ts";

const [type, ...rest] = process.argv.slice(2);
const flags: Record<string, string | undefined> = {};
for (let i = 0; i < rest.length; i += 2) flags[(rest[i] ?? "").replace(/^--/, "")] = rest[i + 1];

const config = loadConfig();
if (config.mode === "off") {
  process.stdout.write(`harness: off (${config.reason ?? "mode: off"}), nothing recorded\n`);
  process.exit(0);
}
if (!type || !/^[a-z]+(\.[a-z_]+)+$/.test(type)) {
  recordFailure(config, `harness-emit: "${type ?? ""}" is not an event type`);
  process.exit(0);
}

let data: Record<string, unknown> = {};
if (flags.data !== undefined) {
  try {
    const parsed: unknown = JSON.parse(flags.data);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--data must be a JSON object");
    data = parsed as Record<string, unknown>;
  } catch (error) {
    recordFailure(config, `harness-emit ${type}: ${messageOf(error)}`);
    process.exit(0);
  }
}

const taskId = flags.task;
const planId = flags.plan ?? (taskId ? taskId.replace(/\..*$/, "") : undefined);
const event = emitEvent(config, type, { plan_id: planId, task_id: taskId }, data);
if (event) {
  process.stdout.write(`harness: ${type} recorded (${event.event_id})\n`);
  if (type === "task.completed" && taskId) {
    const record = writeTaskRecord(config, taskId);
    if (record) {
      const note = record.complete ? "" : `, incomplete: missing ${(record.missing_events as string[]).join(", ")}`;
      process.stdout.write(`harness: routing log ${taskId} revision ${record.revision} written${note}\n`);
    }
  }
}
process.exit(0);
