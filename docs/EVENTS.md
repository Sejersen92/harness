# Harness metadata v1: the event stream and the routing log

The Harness writes two metadata outputs. Scripts and hooks write them; a model never does. They are the only contract between the Harness and anything that reads it, PU included.

| Output | File (under `metadata.dir`, default `.harness/`) | One line per | De-duplicate on | Schema |
|---|---|---|---|---|
| **Harness Events v1** | `events/YYYY-MM-DD.jsonl` (UTC date) | event | `event_id` | [`schema/harness.events.v1.json`](../schema/harness.events.v1.json) |
| **Routing log v1** | `routing-log/YYYY-MM.jsonl` | completed task (per revision) | `task_id` + highest `revision` | [`schema/routing-log.v1.json`](../schema/routing-log.v1.json) |

The JSON Schemas are authoritative; this page summarises them. `npm test` validates every example on this page against them.

Both outputs are designed to be **safe to ship off the machine**. They carry identifiers, scores, counts, hashes and outcomes. They never carry source code, diffs, prompts, model output, file contents or commit messages. File paths appear only as counts, and repository remotes only as SHA-256 hashes. The one exception is the optional `rubric.justifications` (short reasons that may name a module), which `metadata.include_justifications: false` turns off.

## Writing

- **Only `harness-emit` writes events.** Hooks and scripts call it, and the orchestrator calls it through Bash: `harness-emit task.scored --task PLAN-7.2 --data '{…}'`.
- **Atomic lines.** Each event is one line under 4 KB, appended with `O_APPEND`, so parallel subagents never interleave partial lines.
- **Order.** Lines are in write order, which can differ slightly from `ts` order across parallel agents. Readers sort by `ts`, then `event_id`.
- **Retention.** Files older than `metadata.retention_days` (one key, C10; default 30) are deleted by `harness-emit` on its first write each day.
- **Failure never blocks work, but is never silent (C12).** If a write fails, `harness-emit` logs to stderr, adds one to `.harness/emit-failures` and exits 0. `/harness:doctor` reports the count, and a routing-log record built without an event it expected is marked `complete: false` with `missing_events`.
- **`mode: off` writes nothing.** So `mode` in a line is always `observe` or `route`.
- **`harness-tasklog` writes the routing log** when `task.completed` is emitted. It assembles the record from that task's events, its `PLAN.md` section and git. A reopened task that completes again gets a new line with `revision` + 1.

## The envelope

Every event has the same envelope; type-specific fields live under `data`.

| Field | Required | Notes |
|---|---|---|
| `schema` | yes | Always `harness.events/v1` |
| `event_id` | yes | A 26-character ULID: unique and time-sortable |
| `ts` | yes | RFC 3339, UTC (`…Z`) |
| `type` | yes | One of the catalogue below; unknown types are allowed (see versioning) |
| `producer` | yes | `{ "name": "harness", "version": "<plugin semver>" }` |
| `repo` | yes | `{ "name", "remote_sha256" }`: the remote URL hashed, never stored |
| `mode` | yes | `observe` or `route` |
| `session_id` | yes | Claude Code session id, from hook input |
| `config_sha256` | yes | SHA-256 of the `routing.yaml` in effect (C9). Covers `routing.yaml` only. Prompts and skills are versioned by `producer.version` (C16), so compare like with like on both. |
| `prompt_id` | no | Claude Code prompt id, for joining with transcripts or OpenTelemetry |
| `agent_id`, `agent_type` | no | Set when a subagent is the source; required on `subagent.*` |
| `plan_id`, `task_id` | no | `PLAN-7`, `PLAN-7.2`; required where the event is about a plan or task |
| `data` | yes | Type-specific payload; may be `{}` |

## Event catalogue

| Type | Written by | When | `data` |
|---|---|---|---|
| `plan.created` | orchestrator | A plan is written or rewritten | `task_count`, `revision`, `groups[{group, task_ids}]` |
| `task.scored` | orchestrator | A task gets rubric scores | `scores{ambiguity, blast, coupling, novelty, reversibility, verification}`, `total`, `score_band`, `overrides[]`, `tier_planned` |
| `task.dispatched` | orchestrator | A task is handed to an implementer | `tier`, `agent_type`, `model_requested`, `effort?`, `group?`, `isolation` |
| `task.redispatched` | orchestrator | A task is rerun | `reason` (`merge_conflict`, `replan`, `eval_fail`), `tier` |
| `subagent.started` | SubagentStart hook | Any Harness subagent starts | `model_requested?` |
| `subagent.stopped` | SubagentStop hook | Any Harness subagent stops | `report` (`DONE`, `ESCALATE`, `PASS`, `FAIL`, `PLAN`, `none`), `duration_ms`, `partial` (true when there was no usable report), `task_ids[]` parsed from the report header, plus `model` and `effort` from the agent's transcript and `model_requested` from its `meta.json` (C13) |
| `escalation.triggered` | hook or orchestrator | A trigger fires | `trigger`, `count`, `threshold` |
| `escalation.resolved` | orchestrator | The architect's re-plan is accepted | `new_task_ids[]`, `new_tiers[]` |
| `eval.started` | `harness-eval` | The eval runner starts | `task_ids[]`, `diff_sha256`, `ci` |
| `eval.completed` | `harness-eval` | The eval runner finishes | `result`, `stages[{name, status, duration_ms}]`, `failed_acs[]`, `task_ids[]`, `diff_sha256`, `attribution?` |
| `gate.decision` | `commit-gate` | A commit attempt is checked | `decision` (`allow`, `deny`), `reason` (`pass`, `no_marker`, `diff_mismatch`, `stale_marker`, `mode_off`) |
| `commit.created` | git `post-commit` | A commit lands | `commit_sha`, `task_ids[]`, `files_changed`, `lines_added`, `lines_removed` |
| `task.completed` | orchestrator | A task reaches a final state | `outcome` (`pass_first_try`, `pass`, `escalated_then_pass`, `human`, `abandoned`), `final_tier`, `eval_rounds`, `escalations` |
| `human.intervention` | orchestrator | The orchestrator stops and asks the human | `reason` (short, at most 200 characters) |
| `release.failed` | CI step (optional) | The release gate fails | `commit_sha`, `environment`, `failed_checks[]` |
| `harness.doctor` | `/harness:doctor` | A health check runs | `checks[{name, status}]`, `emit_failures` |

**Cost is deliberately absent.** Token usage lives in Claude Code's transcripts. A consumer prices each subagent run from `subagents/agent-<agent_id>.jsonl`; the day-1 spike S1 showed that `agent_id` matches it exactly. Duplicating cost here would create a second source of truth.

### Example: one task in observe mode

Task PLAN-7.2 is scored T2, runs on the session model (observe mode), fails its first eval on one acceptance criterion, passes the second, and is committed.

```jsonl
{"schema":"harness.events/v1","event_id":"01M4QP0GJ0GE2KM115X5MYEE9D","ts":"2026-10-12T09:10:00Z","type":"harness.doctor","producer":{"name":"harness","version":"0.1.0"},"repo":{"name":"previouslyupcoming","remote_sha256":"8870c7e3b16d6d10f365ee183b8906cfe8c76d6a9fd8229e1990e0247877a6e3"},"mode":"observe","session_id":"8d2c4e1a-5b7f-4c3e-9a10-2f6b8e4d7c91","config_sha256":"9f811fd217cfa016d705daa56a07b63e731424ff9223514e5091e4d7802bdff5","data":{"checks":[{"name":"claude_code_version","status":"pass"},{"name":"hooks_resolve","status":"pass"},{"name":"routing_yaml_valid","status":"pass"},{"name":"spool_writable","status":"pass"},{"name":"worktree_base_ref_head","status":"pass"},{"name":"cwd_case_matches_disk","status":"warn"}],"emit_failures":0}}
{"schema":"harness.events/v1","event_id":"01M4QP5CT0GZXVSP4E4YJ96VSX","ts":"2026-10-12T09:12:40Z","type":"plan.created","producer":{"name":"harness","version":"0.1.0"},"repo":{"name":"previouslyupcoming","remote_sha256":"8870c7e3b16d6d10f365ee183b8906cfe8c76d6a9fd8229e1990e0247877a6e3"},"mode":"observe","session_id":"8d2c4e1a-5b7f-4c3e-9a10-2f6b8e4d7c91","config_sha256":"9f811fd217cfa016d705daa56a07b63e731424ff9223514e5091e4d7802bdff5","plan_id":"PLAN-7","data":{"task_count":2,"revision":1,"groups":[{"group":"G1","task_ids":["PLAN-7.1"]},{"group":"G2","task_ids":["PLAN-7.2"]}]}}
{"schema":"harness.events/v1","event_id":"01M4QP7XVRV57Q4AKK7WJ8J8N6","ts":"2026-10-12T09:14:03Z","type":"task.scored","producer":{"name":"harness","version":"0.1.0"},"repo":{"name":"previouslyupcoming","remote_sha256":"8870c7e3b16d6d10f365ee183b8906cfe8c76d6a9fd8229e1990e0247877a6e3"},"mode":"observe","session_id":"8d2c4e1a-5b7f-4c3e-9a10-2f6b8e4d7c91","config_sha256":"9f811fd217cfa016d705daa56a07b63e731424ff9223514e5091e4d7802bdff5","plan_id":"PLAN-7","task_id":"PLAN-7.2","data":{"scores":{"ambiguity":0,"blast":1,"coupling":1,"novelty":0,"reversibility":0,"verification":1},"total":3,"score_band":"T2","overrides":[],"tier_planned":"T2"}}
{"schema":"harness.events/v1","event_id":"01M4QP9Z9GZG5AWJA95RZ35J6B","ts":"2026-10-12T09:15:10Z","type":"task.dispatched","producer":{"name":"harness","version":"0.1.0"},"repo":{"name":"previouslyupcoming","remote_sha256":"8870c7e3b16d6d10f365ee183b8906cfe8c76d6a9fd8229e1990e0247877a6e3"},"mode":"observe","session_id":"8d2c4e1a-5b7f-4c3e-9a10-2f6b8e4d7c91","config_sha256":"9f811fd217cfa016d705daa56a07b63e731424ff9223514e5091e4d7802bdff5","plan_id":"PLAN-7","task_id":"PLAN-7.2","data":{"tier":"T2","agent_type":"harness:impl-t2","model_requested":"inherit","effort":"medium","group":"G2","isolation":"none"}}
{"schema":"harness.events/v1","event_id":"01M4QPA08RF57FGTNZKSQEQFBX","ts":"2026-10-12T09:15:11Z","type":"subagent.started","producer":{"name":"harness","version":"0.1.0"},"repo":{"name":"previouslyupcoming","remote_sha256":"8870c7e3b16d6d10f365ee183b8906cfe8c76d6a9fd8229e1990e0247877a6e3"},"mode":"observe","session_id":"8d2c4e1a-5b7f-4c3e-9a10-2f6b8e4d7c91","config_sha256":"9f811fd217cfa016d705daa56a07b63e731424ff9223514e5091e4d7802bdff5","agent_id":"a19c4f0e2b7d83c15","agent_type":"harness:impl-t2","data":{"model_requested":"inherit"}}
{"schema":"harness.events/v1","event_id":"01M4QQ17E0PWWQH2F9W8M42WWP","ts":"2026-10-12T09:27:52Z","type":"subagent.stopped","producer":{"name":"harness","version":"0.1.0"},"repo":{"name":"previouslyupcoming","remote_sha256":"8870c7e3b16d6d10f365ee183b8906cfe8c76d6a9fd8229e1990e0247877a6e3"},"mode":"observe","session_id":"8d2c4e1a-5b7f-4c3e-9a10-2f6b8e4d7c91","config_sha256":"9f811fd217cfa016d705daa56a07b63e731424ff9223514e5091e4d7802bdff5","agent_id":"a19c4f0e2b7d83c15","agent_type":"harness:impl-t2","data":{"report":"DONE","duration_ms":761000,"partial":false,"task_ids":["PLAN-7.2"]}}
{"schema":"harness.events/v1","event_id":"01M4QQ2CHGEKAECXN0NW4W9BJY","ts":"2026-10-12T09:28:30Z","type":"eval.started","producer":{"name":"harness","version":"0.1.0"},"repo":{"name":"previouslyupcoming","remote_sha256":"8870c7e3b16d6d10f365ee183b8906cfe8c76d6a9fd8229e1990e0247877a6e3"},"mode":"observe","session_id":"8d2c4e1a-5b7f-4c3e-9a10-2f6b8e4d7c91","config_sha256":"9f811fd217cfa016d705daa56a07b63e731424ff9223514e5091e4d7802bdff5","agent_id":"a7f3b2c19d0e4a856","agent_type":"harness:evaluator","data":{"task_ids":["PLAN-7.2"],"diff_sha256":"c13403c01effc06a9c4768641150aa7b0370c77025f7c204321420b1d1e4e6a4","ci":false}}
{"schema":"harness.events/v1","event_id":"01M4QQ8CXRKNEEQ7MQH932M7AE","ts":"2026-10-12T09:31:47Z","type":"eval.completed","producer":{"name":"harness","version":"0.1.0"},"repo":{"name":"previouslyupcoming","remote_sha256":"8870c7e3b16d6d10f365ee183b8906cfe8c76d6a9fd8229e1990e0247877a6e3"},"mode":"observe","session_id":"8d2c4e1a-5b7f-4c3e-9a10-2f6b8e4d7c91","config_sha256":"9f811fd217cfa016d705daa56a07b63e731424ff9223514e5091e4d7802bdff5","agent_id":"a7f3b2c19d0e4a856","agent_type":"harness:evaluator","data":{"result":"fail","stages":[{"name":"build","status":"pass","duration_ms":8120},{"name":"unit","status":"fail","duration_ms":14310}],"failed_acs":["PLAN-7.2/AC-2"],"task_ids":["PLAN-7.2"],"diff_sha256":"c13403c01effc06a9c4768641150aa7b0370c77025f7c204321420b1d1e4e6a4","attribution":"task"}}
{"schema":"harness.events/v1","event_id":"01M4QQAP5G75R9Z9MQ5R8817MC","ts":"2026-10-12T09:33:02Z","type":"gate.decision","producer":{"name":"harness","version":"0.1.0"},"repo":{"name":"previouslyupcoming","remote_sha256":"8870c7e3b16d6d10f365ee183b8906cfe8c76d6a9fd8229e1990e0247877a6e3"},"mode":"observe","session_id":"8d2c4e1a-5b7f-4c3e-9a10-2f6b8e4d7c91","config_sha256":"9f811fd217cfa016d705daa56a07b63e731424ff9223514e5091e4d7802bdff5","data":{"decision":"allow","reason":"pass"}}
{"schema":"harness.events/v1","event_id":"01M4QQAS38R4VTH1FVN7K1SNZV","ts":"2026-10-12T09:33:05Z","type":"commit.created","producer":{"name":"harness","version":"0.1.0"},"repo":{"name":"previouslyupcoming","remote_sha256":"8870c7e3b16d6d10f365ee183b8906cfe8c76d6a9fd8229e1990e0247877a6e3"},"mode":"observe","session_id":"8d2c4e1a-5b7f-4c3e-9a10-2f6b8e4d7c91","config_sha256":"9f811fd217cfa016d705daa56a07b63e731424ff9223514e5091e4d7802bdff5","data":{"commit_sha":"8d1f2e0","task_ids":["PLAN-7.2"],"files_changed":3,"lines_added":148,"lines_removed":64}}
{"schema":"harness.events/v1","event_id":"01M4QQBANR5HEHMCWWG0MDNMH9","ts":"2026-10-12T09:33:23Z","type":"task.completed","producer":{"name":"harness","version":"0.1.0"},"repo":{"name":"previouslyupcoming","remote_sha256":"8870c7e3b16d6d10f365ee183b8906cfe8c76d6a9fd8229e1990e0247877a6e3"},"mode":"observe","session_id":"8d2c4e1a-5b7f-4c3e-9a10-2f6b8e4d7c91","config_sha256":"9f811fd217cfa016d705daa56a07b63e731424ff9223514e5091e4d7802bdff5","plan_id":"PLAN-7","task_id":"PLAN-7.2","data":{"outcome":"pass","final_tier":"T2","eval_rounds":2,"escalations":0}}
```

## The routing log

One line per completed task, holding everything known about how it was scored, routed, built, evaluated and committed. Most readers start here and drop to events only when they need timing detail.

`runs[]` lists every model run with its `agent_id`, so a consumer can price each one from its transcript and sum per task. `model_requested` is what routing asked for. `model` is what the transcript says actually ran (C13), so a silent fallback or an override that didn't apply is visible. The spike showed both are readable: the agent's `meta.json` holds the request and each transcript line holds the model.

The record for the example above:

```json
{
  "schema": "harness.routing-log/v1",
  "task_id": "PLAN-7.2",
  "revision": 1,
  "plan_id": "PLAN-7",
  "repo": { "name": "previouslyupcoming", "remote_sha256": "8870c7e3b16d6d10f365ee183b8906cfe8c76d6a9fd8229e1990e0247877a6e3" },
  "producer": { "name": "harness", "version": "0.1.0" },
  "config_sha256": "9f811fd217cfa016d705daa56a07b63e731424ff9223514e5091e4d7802bdff5",
  "mode": "observe",
  "session_id": "8d2c4e1a-5b7f-4c3e-9a10-2f6b8e4d7c91",
  "timestamps": { "scored": "2026-10-12T09:14:03Z", "first_dispatch": "2026-10-12T09:15:10Z", "completed": "2026-10-12T09:33:23Z" },
  "rubric": {
    "scores": { "ambiguity": 0, "blast": 1, "coupling": 1, "novelty": 0, "reversibility": 0, "verification": 1 },
    "justifications": { "coupling": "Reads the shared ledger query helper" },
    "total": 3,
    "score_band": "T2",
    "overrides": [],
    "tier_planned": "T2"
  },
  "scope": { "declared_files": 2, "parallel_group": "G2", "isolation": "none", "depends_on": ["PLAN-7.1"] },
  "acceptance": { "criteria": 2, "tests_added": 3, "tests_failed_before": 3 },
  "runs": [
    { "agent_type": "harness:impl-t2", "agent_id": "a19c4f0e2b7d83c15", "model_requested": "inherit", "model": "claude-opus-5-5", "effort": "medium", "started": "2026-10-12T09:15:11Z", "ended": "2026-10-12T09:27:52Z", "report": "DONE", "partial": false },
    { "agent_type": "harness:evaluator", "agent_id": "a7f3b2c19d0e4a856", "model_requested": "opus", "model": "claude-opus-5-5", "effort": "medium", "started": "2026-10-12T09:28:30Z", "ended": "2026-10-12T09:31:47Z", "report": "FAIL" },
    { "agent_type": "harness:impl-t2", "agent_id": "a2b8e5d01c9f47a63", "model_requested": "inherit", "model": "claude-opus-5-5", "effort": "medium", "started": "2026-10-12T09:31:52Z", "ended": "2026-10-12T09:32:20Z", "report": "DONE", "partial": false },
    { "agent_type": "harness:evaluator", "agent_id": "a5c1d9e7f2b3a4068", "model_requested": "opus", "model": "claude-opus-5-5", "effort": "medium", "started": "2026-10-12T09:32:24Z", "ended": "2026-10-12T09:32:58Z", "report": "PASS" }
  ],
  "eval_rounds": [
    { "round": 1, "result": "fail", "failed_acs": ["PLAN-7.2/AC-2"], "stages": [{ "name": "build", "status": "pass", "duration_ms": 8120 }, { "name": "unit", "status": "fail", "duration_ms": 14310 }], "attribution": "task" },
    { "round": 2, "result": "pass", "failed_acs": [], "stages": [{ "name": "build", "status": "pass", "duration_ms": 7940 }, { "name": "unit", "status": "pass", "duration_ms": 13980 }] }
  ],
  "escalations": [],
  "redispatches": [],
  "gate": { "denials": 0, "denial_reasons": [], "allowed": 1 },
  "commit": { "sha": "8d1f2e0", "files_changed": 3, "lines_added": 148, "lines_removed": 64 },
  "human_interventions": 0,
  "outcome": "pass",
  "final_tier": "T2",
  "wall_clock_s": 1160,
  "complete": true
}
```

## Versioning

1. Within v1, changes are **additive only**: new event types, new optional fields.
2. Readers **must ignore unknown types and fields**. The schema enforces this: an unknown `type` is checked against the envelope only, and every object accepts extra properties.
3. Removing or renaming a field, changing its type or changing its meaning requires `harness.events/v2` (or `harness.routing-log/v2`), dual-written alongside v1 for at least one minor plugin release.

## How PU reads it

PU reads both outputs the same way (K4):

1. `pu sync` finds the `.harness/` folder of each known repository.
2. It validates each line against these schemas. Invalid lines are quarantined and counted, never dropped silently.
3. It pushes them through DocumentService into the central store.

It tracks a cursor per file and never reads a partial last line. It de-duplicates on the keys in the first table, and must ingest within half of `metadata.retention_days`.

## What changed from Appendix A

Nothing had shipped, so every fix went straight into v1 (plan rule 4):

| Change | Why |
|---|---|
| Long score names everywhere: `ambiguity`, `blast`, … (C6) | Appendix A used `a, b, c, n, r, v` in events and long names in the routing log |
| `task.scored` carries `score_band` and `tier_planned` (C7). Appendix A's `tier` is renamed `tier_planned`. | Stratifying by difficulty needs the raw band, and `tier` was ambiguous |
| `failed_acs` is always `PLAN-7.2/AC-2` (C8) | Appendix A used both `AC-2` and `PLAN-42.2/AC-2` |
| `config_sha256` is in the envelope table and in every example (C9) | It was "required" only in prose |
| One retention key, `metadata.retention_days` (C10) | The PU document used `events.retention_days` |
| `emit_failures` on `harness.doctor`; `complete` and `missing_events` on the routing log (C12) | No silent loss |
| `runs[].model` is from the transcript; `model_requested` is from config (C13) | Config says what was asked for; the transcript says what ran |
| `event_id` is a full 26-character ULID | Appendix A's examples used 14 characters |
| `task.dispatched` and `subagent.started` carry `model_requested`, not `model` | In observe mode the request is `inherit`, which is not a model |
| `gate.decision.reason`, `escalation.triggered.trigger` and the routing log's `escalations[]` and `redispatches[]` have defined values | Appendix A left them open |
| No "…" placeholders in examples | Every example must be real JSON so the test can check it |
