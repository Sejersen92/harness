// The only code that writes metadata. Telemetry must never block development, so nothing here
// throws: a failed write is logged to stderr and counted in <metadata dir>/emit-failures (C12).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { harnessHome, producer, repoIdentity } from "./config.ts";
import { ulid, utcNow } from "./ids.ts";
import { isEffort, messageOf, type Config, type EventFields, type HarnessEvent, type RepoIdentity } from "./types.ts";

/** ~/.harness/spools.json: one entry per repository that has written a line. */
interface Registry {
  version: 1;
  spools: { repo_dir: string; metadata_dir: string; first_seen: string }[];
}

/** One routing-log line, as far as the spool needs to know it. */
export interface RoutingRecord {
  schema: "harness.routing-log/v1";
  task_id: string;
  revision: number;
  timestamps: { scored?: string; first_dispatch?: string; completed: string };
  [field: string]: unknown;
}

const MAX_LINE_BYTES = 4096;

/**
 * The machine's list of repositories with a spool, so a reader (PU's `pu sync`) finds every one
 * without guessing from session transcripts. ~/.harness/spools.json, or $HARNESS_HOME/spools.json.
 */
export const registryPath = (): string => join(harnessHome(), "spools.json");

/**
 * Where this machine's copy of the plugin lives: ~/.harness/plugin.json. A repository's git hooks run
 * outside Claude Code, where CLAUDE_PLUGIN_ROOT doesn't exist, and they read it from here rather than
 * from a path written into the repository, which would be one machine's truth on every machine.
 */
export const pluginRecordPath = (): string => join(harnessHome(), "plugin.json");

/** Records the plugin's root and version, if they changed. Called by SessionStart. Never throws. */
export function recordPluginRoot(root: string | null, version: string, now: Date = new Date()): void {
  if (!root) return;
  const path = pluginRecordPath();
  try {
    const known = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { root?: string; version?: string }) : null;
    if (known?.root === resolve(root) && known?.version === version) return;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify({ root: resolve(root), version, recorded: utcNow(now) }, null, 2) + "\n");
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    process.stderr.write(`harness: could not record the plugin's location in ${path}: ${messageOf(error)}\n`);
  }
}

const readRegistry = (path: string): Registry =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Registry) : { version: 1, spools: [] };

/** Write then rename, so a reader (pu sync) never sees half a file. */
function writeRegistry(path: string, registry: Registry): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(registry, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}

/** Adds this repository's metadata folder to the registry if it isn't there. Cheap after the first time. */
export function registerSpool(spool: { dir: string; metadataDir: string }, now: Date = new Date()): void {
  const path = registryPath();
  const metadataDir = resolve(spool.metadataDir);
  try {
    const registry = readRegistry(path);
    if (registry.spools.some((s) => s.metadata_dir.toLowerCase() === metadataDir.toLowerCase())) return;
    registry.spools.push({ repo_dir: resolve(spool.dir), metadata_dir: metadataDir, first_seen: utcNow(now) });
    writeRegistry(path, registry);
  } catch (error) {
    recordFailure(spool, `spool registry: ${messageOf(error)}`);
  }
}

/** Takes a metadata folder off the registry (forget). Returns whether it was there. */
export function unregisterSpool(metadataDir: string): boolean {
  const path = registryPath();
  const registry = readRegistry(path);
  const kept = registry.spools.filter((s) => s.metadata_dir.toLowerCase() !== resolve(metadataDir).toLowerCase());
  if (kept.length === registry.spools.length) return false;
  writeRegistry(path, { ...registry, spools: kept });
  return true;
}

export function recordFailure(config: { metadataDir: string }, why: string): void {
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
function appendLine(config: Config, file: string, record: { type?: string; schema?: string }): boolean {
  const line = JSON.stringify(record);
  if (Buffer.byteLength(line) >= MAX_LINE_BYTES) {
    recordFailure(config, `${record.type ?? record.schema} line is ${Buffer.byteLength(line)} bytes, over the 4 KB limit`);
    return false;
  }
  try {
    const firstLineInFile = !existsSync(file);
    mkdirSync(join(file, ".."), { recursive: true });
    appendFileSync(file, line + "\n", { flag: "a" });
    if (firstLineInFile) registerSpool(config);
    return true;
  } catch (error) {
    recordFailure(config, messageOf(error));
    return false;
  }
}

/** Deletes spool files older than metadata.retention_days, once per UTC day. */
function sweep(config: Config, now: Date): void {
  const today = utcNow(now).slice(0, 10);
  const marker = join(config.metadataDir, "state", "swept");
  try {
    if (existsSync(marker) && readFileSync(marker, "utf8").trim() === today) return;
    const cutoff = new Date(now.getTime() - config.retentionDays * 86_400_000).toISOString().slice(0, 10);
    const folders: [string, (name: string) => string][] = [["events", (n) => n.slice(0, 10)], ["routing-log", (n) => `${n.slice(0, 7)}-31`]];
    for (const [folder, toDate] of folders) {
      const dir = join(config.metadataDir, folder);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
        if (toDate(name) < cutoff) rmSync(join(dir, name));
      }
    }
    mkdirSync(join(config.metadataDir, "state"), { recursive: true });
    writeFileSync(marker, today);
  } catch (error) {
    recordFailure(config, `retention sweep: ${messageOf(error)}`);
  }
}

/**
 * Writes one Harness Events v1 line. `fields` holds the optional envelope fields
 * (plan_id, task_id, agent_id, agent_type, prompt_id). Returns the event, or null when nothing was written.
 */
export function emitEvent(
  config: Config, type: string, fields: EventFields = {}, data: Record<string, unknown> = {}, now: Date = new Date(),
): HarnessEvent | null {
  if (config.mode === "off") return null;
  sweep(config, now);
  const sessionId = fields.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    recordFailure(config, `${type}: no session id (not running inside Claude Code?)`);
    return null;
  }
  // The envelope in the order the line is written; data is added last.
  const envelope: Omit<HarnessEvent, "data"> = {
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
  for (const key of ["prompt_id", "agent_id", "agent_type", "plan_id", "task_id"] as const) {
    const value = fields[key];
    if (value) envelope[key] = value;
  }
  const event: HarnessEvent = { ...envelope, data };
  const file = join(config.metadataDir, "events", `${event.ts.slice(0, 10)}.jsonl`);
  if (!appendLine(config, file, event)) return null;
  snapshotConfig(config, event.repo, now);
  return event;
}

const TIERS = ["T1", "T2", "T3", "T4"];

/**
 * Writes <metadata dir>/configs/<config_sha256>.json, the config this line was written under
 * (harness.config/v1), unless it is already there. Events carry only the hash; this is what it stood
 * for, so PU can show each tier's model and effort without ever reading routing.yaml. A tier entry
 * that isn't well formed is left out rather than guessed.
 */
export function snapshotConfig(config: Config, repo: RepoIdentity, now: Date = new Date()): void {
  const path = join(config.metadataDir, "configs", `${config.config_sha256}.json`);
  if (existsSync(path)) return;
  const tiers: Record<string, { max_score: number; agent: string; model: string; effort?: string }> = {};
  for (const tier of TIERS) {
    const t = config.tiers[tier];
    if (!t || !Number.isInteger(t.max_score) || typeof t.agent !== "string" || typeof t.model !== "string") continue;
    tiers[tier] = { max_score: t.max_score as number, agent: t.agent, model: t.model, ...(isEffort(t.effort) ? { effort: t.effort } : {}) };
  }
  const snapshot = {
    schema: "harness.config/v1",
    config_sha256: config.config_sha256,
    captured: utcNow(now),
    producer: producer(),
    repo,
    mode: config.mode,
    tiers,
    eval: { stages: config.stages.map((s) => s?.name).filter((n): n is string => typeof n === "string" && n.length > 0) },
    gate: { marker_ttl_minutes: config.markerTtlMinutes },
  };
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(snapshot, null, 2) + "\n");
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    recordFailure(config, `config snapshot: ${messageOf(error)}`);
  }
}

export function writeRoutingLog(config: Config, record: RoutingRecord): boolean {
  const file = join(config.metadataDir, "routing-log", `${record.timestamps.completed.slice(0, 7)}.jsonl`);
  return appendLine(config, file, record);
}

/** Every event line in the spool, oldest first. Unparseable lines are skipped and counted. */
export function readEvents(config: Config): HarnessEvent[] {
  const dir = join(config.metadataDir, "events");
  if (!existsSync(dir)) return [];
  const events: HarnessEvent[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as HarnessEvent);
      } catch {
        recordFailure(config, `unreadable line in events/${name}`);
      }
    }
  }
  return events.sort((a, b) => (a.ts === b.ts ? a.event_id.localeCompare(b.event_id) : a.ts.localeCompare(b.ts)));
}

export function readRoutingLog(config: Config): RoutingRecord[] {
  const dir = join(config.metadataDir, "routing-log");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l.trim()))
    .flatMap((line): RoutingRecord[] => { try { return [JSON.parse(line) as RoutingRecord]; } catch { return []; } });
}
