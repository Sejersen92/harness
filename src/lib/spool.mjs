// The only code that writes metadata. Telemetry must never block development, so nothing here
// throws: a failed write is logged to stderr and counted in <metadata dir>/emit-failures (C12).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { producer, repoIdentity } from "./config.mjs";
import { ulid, utcNow } from "./ids.mjs";

const MAX_LINE_BYTES = 4096;

export function recordFailure(config, why) {
  process.stderr.write(`harness: metadata not written: ${why}\n`);
  try {
    mkdirSync(config.metadataDir, { recursive: true });
    const file = join(config.metadataDir, "emit-failures");
    const count = existsSync(file) ? Number.parseInt(readFileSync(file, "utf8"), 10) || 0 : 0;
    writeFileSync(file, `${count + 1}\n`);
  } catch {
    // Nowhere left to record it; stderr already has it.
  }
}

/** Appends one line in a single write (O_APPEND), so parallel writers never interleave. */
function appendLine(config, file, record) {
  const line = JSON.stringify(record);
  if (Buffer.byteLength(line) >= MAX_LINE_BYTES) {
    recordFailure(config, `${record.type ?? record.schema} line is ${Buffer.byteLength(line)} bytes, over the 4 KB limit`);
    return false;
  }
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    appendFileSync(file, line + "\n", { flag: "a" });
    return true;
  } catch (error) {
    recordFailure(config, error.message);
    return false;
  }
}

/** Deletes spool files older than metadata.retention_days, once per UTC day. */
function sweep(config, now) {
  const today = utcNow(now).slice(0, 10);
  const marker = join(config.metadataDir, "state", "swept");
  try {
    if (existsSync(marker) && readFileSync(marker, "utf8").trim() === today) return;
    const cutoff = new Date(now.getTime() - config.retentionDays * 86_400_000).toISOString().slice(0, 10);
    for (const [folder, toDate] of [["events", (n) => n.slice(0, 10)], ["routing-log", (n) => `${n.slice(0, 7)}-31`]]) {
      const dir = join(config.metadataDir, folder);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
        if (toDate(name) < cutoff) rmSync(join(dir, name));
      }
    }
    mkdirSync(join(config.metadataDir, "state"), { recursive: true });
    writeFileSync(marker, today);
  } catch (error) {
    recordFailure(config, `retention sweep: ${error.message}`);
  }
}

/**
 * Writes one Harness Events v1 line. `fields` holds the optional envelope fields
 * (plan_id, task_id, agent_id, agent_type, prompt_id). Returns the event, or null when nothing was written.
 */
export function emitEvent(config, type, fields = {}, data = {}, now = new Date()) {
  if (config.mode === "off") return null;
  sweep(config, now);
  const sessionId = fields.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    recordFailure(config, `${type}: no session id (not running inside Claude Code?)`);
    return null;
  }
  const event = {
    schema: "harness.events/v1",
    event_id: ulid(now.getTime()),
    ts: utcNow(now),
    type,
    producer: producer(),
    repo: repoIdentity(config.dir),
    mode: config.mode,
    session_id: sessionId,
    config_sha256: config.config_sha256,
  };
  for (const key of ["prompt_id", "agent_id", "agent_type", "plan_id", "task_id"]) {
    if (fields[key]) event[key] = fields[key];
  }
  event.data = data;
  const file = join(config.metadataDir, "events", `${event.ts.slice(0, 10)}.jsonl`);
  return appendLine(config, file, event) ? event : null;
}

export function writeRoutingLog(config, record) {
  const file = join(config.metadataDir, "routing-log", `${record.timestamps.completed.slice(0, 7)}.jsonl`);
  return appendLine(config, file, record);
}

/** Every event line in the spool, oldest first. Unparseable lines are skipped and counted. */
export function readEvents(config) {
  const dir = join(config.metadataDir, "events");
  if (!existsSync(dir)) return [];
  const events = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        recordFailure(config, `unreadable line in events/${name}`);
      }
    }
  }
  return events.sort((a, b) => (a.ts === b.ts ? a.event_id.localeCompare(b.event_id) : a.ts.localeCompare(b.ts)));
}

export function readRoutingLog(config) {
  const dir = join(config.metadataDir, "routing-log");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l.trim()))
    .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
