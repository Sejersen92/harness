// harness-tasklog: assembles a task's Routing log v1 record from its events, its PLAN.md section
// and nothing else. A model never writes this. Where evidence is missing the record says so
// (complete: false, missing_events) instead of guessing (C12).
import { planSection } from "./plan.ts";
import { readEvents, readRoutingLog, recordFailure, writeRoutingLog, type RoutingRecord } from "./spool.ts";
import type { Config, HarnessEvent } from "./types.ts";

// The data of each event type this reads, as harness-emit and the hooks write it (schema/ has the
// contract). An event read back from the spool is typed by its type, the way JSON is read into a model.
interface ScoredData { scores: Record<string, number>; total: number; score_band: string; overrides: string[]; tier_planned: string; review?: Record<string, unknown> }
interface StoppedData { report: string; partial: boolean; duration_ms?: number; model_requested?: string; model?: string; effort?: string }
interface EvalCompletedData { result: string; failed_acs: string[]; stages: unknown[]; attribution?: string }
interface DispatchedData { group?: string; isolation?: string }
interface CompletedData { outcome: string; final_tier: string }
interface CommitData { commit_sha: string; files_changed: number; lines_added: number; lines_removed: number }
const dataOf = <T>(event: HarnessEvent): T => event.data as T;

interface Run {
  agent_type: string | undefined;
  agent_id: string | undefined;
  started: string;
  ended: string;
  report: string;
  partial: boolean;
  model_requested?: string;
  model?: string;
  effort?: string;
}

interface EvalRound { round: number; result: string; failed_acs: string[]; stages: unknown[]; attribution?: string }

const seconds = (from: string, to: string): number => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

/** Builds the record for one task. Returns { record } or { error } when no valid record can be made. */
export function buildRecord(
  config: Config, taskId: string, events: HarnessEvent[] = readEvents(config), previous: RoutingRecord[] = readRoutingLog(config),
): { record: RoutingRecord; error?: undefined } | { error: string; record?: undefined } {
  const about = (e: HarnessEvent): boolean => e.task_id === taskId || (Array.isArray(e.data?.task_ids) && e.data.task_ids.includes(taskId));
  const mine = events.filter(about);
  const ofType = (type: string): HarnessEvent[] => mine.filter((e) => e.type === type);

  const completed = last(ofType("task.completed"));
  if (!completed) return { error: `${taskId}: no task.completed event` };
  const scored = last(ofType("task.scored").filter((e) => e.ts <= completed.ts));
  if (!scored) return { error: `${taskId}: no task.scored event, so there is no rubric to record` };

  const missing: string[] = [];
  const dispatched = ofType("task.dispatched");
  if (dispatched.length === 0) missing.push("task.dispatched");

  const startedById = new Map(events.filter((e) => e.type === "subagent.started").map((e) => [e.agent_id, e.ts] as const));
  const runs = ofType("subagent.stopped").map((stop): Run => {
    const data = dataOf<StoppedData>(stop);
    const run: Run = {
      agent_type: stop.agent_type,
      agent_id: stop.agent_id,
      started: startedById.get(stop.agent_id) ?? new Date(Date.parse(stop.ts) - (data.duration_ms ?? 0)).toISOString().replace(/\.\d{3}Z$/, "Z"),
      ended: stop.ts,
      report: data.report,
      partial: data.partial,
    };
    for (const key of ["model_requested", "model", "effort"] as const) {
      const value = data[key];
      if (value) run[key] = value;
    }
    if (!startedById.has(stop.agent_id)) missing.push(`subagent.started:${stop.agent_id}`);
    return run;
  });
  if (runs.length === 0) missing.push("subagent.stopped");

  const plan = planSection(config.layout.planPath, taskId);
  if (!plan) missing.push("PLAN.md section");

  const evalRounds = ofType("eval.completed").map((e, i): EvalRound => {
    const data = dataOf<EvalCompletedData>(e);
    const round: EvalRound = { round: i + 1, result: data.result, failed_acs: data.failed_acs.filter((ac) => ac.startsWith(`${taskId}/`)), stages: data.stages };
    if (data.attribution) round.attribution = data.attribution;
    return round;
  });

  // When work on the task began: its first subagent (the evaluator writing its tests runs before the
  // dispatch) or its first dispatch, whichever came first. Not when it was scored: the orchestrator scores
  // every task of a plan up front, so a clock from scoring counted the time a task spent waiting behind the
  // ones before it, and a gate window from scoring took in their commits (PLAN-3, 2026-10-07).
  const opened = [dispatched[0]?.ts, ...runs.map((r) => r.started)]
    .filter((ts): ts is string => ts !== undefined && ts >= scored.ts)
    .sort()[0] ?? scored.ts;

  // gate.decision carries no task id: count the decisions made in this session while the task was worked.
  const window = (e: HarnessEvent): boolean => e.session_id === completed.session_id && e.ts >= opened && e.ts <= completed.ts;
  const gates = events.filter((e) => e.type === "gate.decision" && window(e));
  const commit = last(ofType("commit.created"));

  const score = dataOf<ScoredData>(scored);
  const rubric: ScoredData & { justifications?: Record<string, string> } = {
    scores: score.scores,
    total: score.total,
    score_band: score.score_band,
    overrides: score.overrides,
    tier_planned: score.tier_planned,
    // The person's agreement or overrule, with the orchestrator's original estimate (H4).
    ...(score.review ? { review: score.review } : {}),
  };
  if (config.includeJustifications && plan && Object.keys(plan.justifications).length) rubric.justifications = plan.justifications;

  const lastDispatch = last(dispatched);
  const dispatch = lastDispatch ? dataOf<DispatchedData>(lastDispatch) : undefined;
  const done = dataOf<CompletedData>(completed);
  const commitData = commit ? dataOf<CommitData>(commit) : null;
  const record: RoutingRecord = {
    schema: "harness.routing-log/v1",
    task_id: taskId,
    revision: previous.filter((r) => r.task_id === taskId).reduce((max, r) => Math.max(max, r.revision), 0) + 1,
    plan_id: completed.plan_id ?? scored.plan_id ?? taskId.replace(/\..*$/, ""),
    repo: completed.repo,
    producer: completed.producer,
    config_sha256: completed.config_sha256,
    mode: completed.mode,
    session_id: completed.session_id,
    timestamps: { scored: scored.ts, ...(dispatched[0] ? { first_dispatch: dispatched[0].ts } : {}), completed: completed.ts },
    rubric,
    scope: {
      declared_files: plan?.declaredFiles ?? 0,
      ...((plan?.parallelGroup ?? dispatch?.group) ? { parallel_group: plan?.parallelGroup ?? dispatch?.group } : {}),
      isolation: dispatch?.isolation ?? "none",
      depends_on: plan?.dependsOn ?? [],
    },
    acceptance: { criteria: plan?.criteria ?? 0 },
    runs,
    eval_rounds: evalRounds,
    escalations: ofType("escalation.triggered").map((e) => ({ trigger: dataOf<{ trigger: string }>(e).trigger, at: e.ts })),
    redispatches: ofType("task.redispatched").map((e) => {
      const { reason, tier } = dataOf<{ reason: string; tier: string }>(e);
      return { reason, tier, at: e.ts };
    }),
    gate: {
      denials: gates.filter((g) => g.data.decision === "deny").length,
      denial_reasons: gates.filter((g) => g.data.decision === "deny").map((g) => g.data.reason as string),
      allowed: gates.filter((g) => g.data.decision === "allow").length,
    },
    commit: commitData
      ? { sha: commitData.commit_sha, files_changed: commitData.files_changed, lines_added: commitData.lines_added, lines_removed: commitData.lines_removed }
      : null,
    human_interventions: ofType("human.intervention").length,
    outcome: done.outcome,
    final_tier: done.final_tier,
    wall_clock_s: seconds(opened, completed.ts),
    complete: missing.length === 0,
  };
  if (missing.length) record.missing_events = missing;
  return { record };
}

/** Runs after task.completed is written: builds the record and appends it to the routing log. */
export function writeTaskRecord(config: Config, taskId: string): RoutingRecord | null {
  const { record, error } = buildRecord(config, taskId);
  if (error !== undefined || !record) {
    recordFailure(config, `routing log: ${error}`);
    return null;
  }
  return writeRoutingLog(config, record) ? record : null;
}
