// harness-tasklog: assembles a task's Routing log v1 record from its events, its PLAN.md section
// and nothing else. A model never writes this. Where evidence is missing the record says so
// (complete: false, missing_events) instead of guessing (C12).
import { planSection } from "./plan.mjs";
import { readEvents, readRoutingLog, recordFailure, writeRoutingLog } from "./spool.mjs";

const seconds = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
const last = (items) => items[items.length - 1];

/** Builds the record for one task. Returns { record } or { error } when no valid record can be made. */
export function buildRecord(config, taskId, events = readEvents(config), previous = readRoutingLog(config)) {
  const about = (e) => e.task_id === taskId || (Array.isArray(e.data?.task_ids) && e.data.task_ids.includes(taskId));
  const mine = events.filter(about);
  const ofType = (type) => mine.filter((e) => e.type === type);

  const completed = last(ofType("task.completed"));
  if (!completed) return { error: `${taskId}: no task.completed event` };
  const scored = last(ofType("task.scored").filter((e) => e.ts <= completed.ts));
  if (!scored) return { error: `${taskId}: no task.scored event, so there is no rubric to record` };

  const missing = [];
  const dispatched = ofType("task.dispatched");
  if (dispatched.length === 0) missing.push("task.dispatched");

  const startedById = new Map(events.filter((e) => e.type === "subagent.started").map((e) => [e.agent_id, e.ts]));
  const runs = ofType("subagent.stopped").map((stop) => {
    const run = {
      agent_type: stop.agent_type,
      agent_id: stop.agent_id,
      started: startedById.get(stop.agent_id) ?? new Date(Date.parse(stop.ts) - (stop.data.duration_ms ?? 0)).toISOString().replace(/\.\d{3}Z$/, "Z"),
      ended: stop.ts,
      report: stop.data.report,
      partial: stop.data.partial,
    };
    for (const key of ["model_requested", "model", "effort"]) if (stop.data[key]) run[key] = stop.data[key];
    if (!startedById.has(stop.agent_id)) missing.push(`subagent.started:${stop.agent_id}`);
    return run;
  });
  if (runs.length === 0) missing.push("subagent.stopped");

  const plan = planSection(config.dir, taskId);
  if (!plan) missing.push("PLAN.md section");

  const evalRounds = ofType("eval.completed").map((e, i) => {
    const round = { round: i + 1, result: e.data.result, failed_acs: e.data.failed_acs.filter((ac) => ac.startsWith(`${taskId}/`)), stages: e.data.stages };
    if (e.data.attribution) round.attribution = e.data.attribution;
    return round;
  });

  // gate.decision carries no task id: count the decisions made in this session while the task was open.
  const window = (e) => e.session_id === completed.session_id && e.ts >= scored.ts && e.ts <= completed.ts;
  const gates = events.filter((e) => e.type === "gate.decision" && window(e));
  const commit = last(ofType("commit.created"));

  const rubric = {
    scores: scored.data.scores,
    total: scored.data.total,
    score_band: scored.data.score_band,
    overrides: scored.data.overrides,
    tier_planned: scored.data.tier_planned,
  };
  if (config.includeJustifications && plan && Object.keys(plan.justifications).length) rubric.justifications = plan.justifications;

  const record = {
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
      ...((plan?.parallelGroup ?? last(dispatched)?.data.group) ? { parallel_group: plan?.parallelGroup ?? last(dispatched).data.group } : {}),
      isolation: last(dispatched)?.data.isolation ?? "none",
      depends_on: plan?.dependsOn ?? [],
    },
    acceptance: { criteria: plan?.criteria ?? 0 },
    runs,
    eval_rounds: evalRounds,
    escalations: ofType("escalation.triggered").map((e) => ({ trigger: e.data.trigger, at: e.ts })),
    redispatches: ofType("task.redispatched").map((e) => ({ reason: e.data.reason, tier: e.data.tier, at: e.ts })),
    gate: {
      denials: gates.filter((g) => g.data.decision === "deny").length,
      denial_reasons: gates.filter((g) => g.data.decision === "deny").map((g) => g.data.reason),
      allowed: gates.filter((g) => g.data.decision === "allow").length,
    },
    commit: commit
      ? { sha: commit.data.commit_sha, files_changed: commit.data.files_changed, lines_added: commit.data.lines_added, lines_removed: commit.data.lines_removed }
      : null,
    human_interventions: ofType("human.intervention").length,
    outcome: completed.data.outcome,
    final_tier: completed.data.final_tier,
    wall_clock_s: seconds(scored.ts, completed.ts),
    complete: missing.length === 0,
  };
  if (missing.length) record.missing_events = missing;
  return { record };
}

/** Runs after task.completed is written: builds the record and appends it to the routing log. */
export function writeTaskRecord(config, taskId) {
  const { record, error } = buildRecord(config, taskId);
  if (error) {
    recordFailure(config, `routing log: ${error}`);
    return null;
  }
  return writeRoutingLog(config, record) ? record : null;
}
