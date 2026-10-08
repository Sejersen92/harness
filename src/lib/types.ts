// The shapes that cross files: routing.yaml as loaded, an eval stage, the pass marker, one event line and
// a hook's input. What comes from disk, YAML or Claude Code is typed here at the edge, the way JSON is
// read into a typed model, and checked where a wrong value would do harm (stageProblems, the schemas).

export type Mode = "off" | "observe" | "route";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const isEffort = (value: unknown): value is Effort => EFFORTS.includes(value as Effort);

/** One tier as routing.yaml has it. Unchecked: snapshotConfig and the doctor keep only well-formed ones. */
export interface TierEntry {
  max_score?: unknown;
  agent?: unknown;
  model?: unknown;
  effort?: unknown;
}

/** One eval stage. stageProblems checks a list of them before any is run. */
export interface Stage {
  name: string;
  run: string;
  cwd?: string;
  env?: Record<string, unknown>;
  timeout_minutes?: number;
}

/** No routing.yaml: the Harness is off here. The optional fields say so, so callers can read them safely. */
export interface OffConfig {
  dir: string;
  mode: "off";
  reason: string;
  tiers?: undefined;
  metadataDir?: undefined;
  stages?: undefined;
}

/** routing.yaml, loaded. Its mode can still be "off". */
export interface Config {
  dir: string;
  mode: Mode;
  reason?: undefined;
  tiers: Record<string, TierEntry | undefined>;
  config_sha256: string;
  metadataDir: string;
  retentionDays: number;
  includeJustifications: boolean;
  stages: Stage[];
  testGlobs: string[];
  markerTtlMinutes: number;
}

export type LoadedConfig = OffConfig | Config;

export interface Producer {
  name: "harness";
  version: string;
}

export interface RepoIdentity {
  name: string;
  remote_sha256: string;
}

/** The pass marker harness-eval writes and the commit gate reads. */
export interface Marker {
  diff_sha256: string;
  head: string | null;
  passed_at: string;
  task_ids: string[];
  config_sha256: string;
}

/** The optional envelope fields of an event. */
export interface EventFields {
  session_id?: string | undefined;
  prompt_id?: string | undefined;
  agent_id?: string | undefined;
  agent_type?: string | undefined;
  plan_id?: string | undefined;
  task_id?: string | undefined;
}

/** One Harness Events v1 line. `data` is per type; readers cast it to the type they asked for. */
export interface HarnessEvent {
  schema: "harness.events/v1";
  event_id: string;
  ts: string;
  type: string;
  producer: Producer;
  repo: RepoIdentity;
  mode: Mode;
  session_id: string;
  config_sha256: string;
  prompt_id?: string;
  agent_id?: string;
  agent_type?: string;
  plan_id?: string;
  task_id?: string;
  data: Record<string, unknown>;
}

/** What Claude Code sends a hook on stdin. Only the fields the Harness reads; any can be missing. */
export interface HookInput {
  session_id?: string;
  prompt_id?: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: { command?: unknown; file_path?: string; notebook_path?: string };
}

/** The message of a caught error, whatever was thrown. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
