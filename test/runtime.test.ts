// Runs the bundled bin/ scripts exactly as Claude Code would, against a throwaway git repo, and
// checks that every line they write satisfies the v1 schemas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReport } from "../src/lib/ids.ts";
import { buildRecord, fitted } from "../src/lib/tasklog.ts";
import type { Config } from "../src/lib/types.ts";
import { describe, root, validatorFor, type Line } from "./validators.ts";
import { cleanEnv, git } from "./git.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";

function makeRepo({ routing = true }: { routing?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
  git(["init", "-q", dir]);
  git(["-C", dir, "remote", "add", "origin", "https://github.com/example/Sample-Repo.git"]);
  if (routing) writeFileSync(join(dir, "routing.yaml"), readFileSync(join(root, "templates", "routing.yaml")));
  writeFileSync(join(dir, "PLAN.md"), [
    "# Plan",
    "",
    "### PLAN-1.1 — Show the routing page",
    "- Depends on: none",
    "- Scope: web/app/routing/page.tsx, web/app/api/routing/route.ts",
    "- Parallel group: G1",
    "- Scores: ambiguity 0 · blast 1 · coupling 1 · novelty 0 · reversibility 0 · verification 1 = 3 → band T2",
    "- Overrides: none",
    "- Tier: T2",
    "- Justifications:",
    "  - blast: Touches a page and its API route",
    "  - coupling: Reads the shared query helper",
    "- Acceptance criteria:",
    "  - AC-1 The page lists tasks",
    "  - AC-2 The page shows the quarantine count",
    "",
  ].join("\n"));
  return dir;
}

// HARNESS_HOME keeps the spool registry inside the test repo: a test must never touch the real ~/.harness.
const env = (dir: string): NodeJS.ProcessEnv => ({ ...cleanEnv(), CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: root, HARNESS_HOME: join(dir, ".harness-home") });

const emit = (dir: string, ...args: string[]) =>
  spawnSync("node", [join(root, "bin", "harness-emit.mjs"), ...args], { cwd: dir, env: env(dir), encoding: "utf8" });

const hook = (dir: string, name: string, input: unknown) =>
  spawnSync("node", [join(root, "bin", `hook-${name}.mjs`)], { cwd: dir, env: env(dir), input: JSON.stringify(input), encoding: "utf8" });

const lines = (dir: string, folder: string): Line[] => {
  const path = join(dir, ".harness", folder);
  if (!existsSync(path)) return [];
  return readdirSync(path).flatMap((f) => readFileSync(join(path, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line));
};

function assertValid(value: Line | undefined): asserts value is Line {
  assert.ok(value, "the line is missing");
  const validate = validatorFor(value);
  assert.ok(validate(value), `${value.type ?? value.schema} does not match its schema:\n  ${describe(validate)}`);
}

test("parseReport reads the header and its task ids", () => {
  assert.deepEqual(parseReport("DONE: PLAN-7.2\nchanged things"), { report: "DONE", task_ids: ["PLAN-7.2"] });
  assert.deepEqual(parseReport("\n PASS: PLAN-7.1, PLAN-7.2"), { report: "PASS", task_ids: ["PLAN-7.1", "PLAN-7.2"] });
  assert.deepEqual(parseReport("ESCALATE: PLAN-3.1 — scope is wrong"), { report: "ESCALATE", task_ids: ["PLAN-3.1"] });
  assert.deepEqual(parseReport("I finished. DONE: PLAN-1.1"), { report: "none", task_ids: [] });
  assert.deepEqual(parseReport(undefined), { report: "none", task_ids: [] });
});

test("one task end to end: every event and the routing-log record match the schemas", () => {
  const dir = makeRepo();
  const agent = { session_id: SESSION, prompt_id: "p-1", agent_id: "a0123456789abcdef", agent_type: "harness:impl-t2" };

  // A transcript and meta.json shaped like the ones spike S2 recorded.
  const transcript = join(dir, "agent-a0123456789abcdef.jsonl");
  writeFileSync(transcript, [
    JSON.stringify({ type: "user", agentId: agent.agent_id, message: { role: "user", content: "go" } }),
    JSON.stringify({ type: "assistant", agentId: agent.agent_id, effort: "medium", message: { model: "claude-sonnet-5-5", content: [] } }),
  ].join("\n") + "\n");
  writeFileSync(join(dir, "agent-a0123456789abcdef.meta.json"), JSON.stringify({ agentType: "harness:impl-t2", model: "sonnet" }));

  assert.equal(emit(dir, "plan.created", "--plan", "PLAN-1", "--data", '{"task_count":1,"revision":1,"groups":[{"group":"G1","task_ids":["PLAN-1.1"]}]}').status, 0);
  emit(dir, "task.scored", "--task", "PLAN-1.1", "--data", '{"scores":{"ambiguity":0,"blast":1,"coupling":1,"novelty":0,"reversibility":0,"verification":1},"total":3,"score_band":"T2","overrides":[],"tier_planned":"T2"}');
  emit(dir, "task.dispatched", "--task", "PLAN-1.1", "--data", '{"tier":"T2","agent_type":"harness:impl-t2","model_requested":"sonnet","effort":"medium","group":"G1","isolation":"none"}');
  assert.equal(hook(dir, "subagent-start", agent).status, 0);

  // require-report: no header, first stop -> sent back, nothing recorded.
  const blocked = hook(dir, "subagent-stop", { ...agent, last_assistant_message: "All done!", stop_hook_active: false, agent_transcript_path: transcript });
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  assert.equal(lines(dir, "events").filter((e) => e.type === "subagent.stopped").length, 0);

  hook(dir, "subagent-stop", { ...agent, last_assistant_message: "DONE: PLAN-1.1\nAdded the page.", stop_hook_active: true, agent_transcript_path: transcript });
  const completed = emit(dir, "task.completed", "--task", "PLAN-1.1", "--data", '{"outcome":"pass_first_try","final_tier":"T2","eval_rounds":0,"escalations":0}');
  assert.match(completed.stdout, /routing log PLAN-1\.1 revision 1 written/);

  const events = lines(dir, "events");
  assert.deepEqual(events.map((e) => e.type), ["plan.created", "task.scored", "task.dispatched", "subagent.started", "subagent.stopped", "task.completed"]);
  events.forEach(assertValid);
  assert.equal(events[0].repo.name, "sample-repo");
  assert.equal(events[0].session_id, SESSION);

  const stopped = events.find((e) => e.type === "subagent.stopped")!;
  assert.deepEqual(stopped.data.task_ids, ["PLAN-1.1"]);
  assert.equal(stopped.data.model, "claude-sonnet-5-5");
  assert.equal(stopped.data.model_requested, "sonnet");

  const [record] = lines(dir, "routing-log");
  assertValid(record);
  assert.equal(record.complete, true, `missing: ${record.missing_events}`);
  assert.equal(record.runs[0].model, "claude-sonnet-5-5");
  assert.equal(record.scope.declared_files, 2);
  assert.equal(record.acceptance.criteria, 2);
  assert.deepEqual(Object.keys(record.rubric.justifications), ["blast", "coupling"]);
  assert.equal(record.outcome, "pass_first_try");

  // The repo is in the machine's spool registry, once, however many lines were written.
  const registry = JSON.parse(readFileSync(join(dir, ".harness-home", "spools.json"), "utf8"));
  assert.equal(registry.spools.length, 1);
  assert.equal(registry.spools[0].metadata_dir.toLowerCase(), join(dir, ".harness").toLowerCase());
});

test("a task completed without its dispatch is recorded, but marked incomplete", () => {
  const dir = makeRepo();
  emit(dir, "task.scored", "--task", "PLAN-1.1", "--data", '{"scores":{"ambiguity":0,"blast":0,"coupling":0,"novelty":0,"reversibility":0,"verification":0},"total":0,"score_band":"T1","overrides":[],"tier_planned":"T1"}');
  emit(dir, "task.completed", "--task", "PLAN-1.1", "--data", '{"outcome":"human","final_tier":"T1","eval_rounds":0,"escalations":0}');
  const [record] = lines(dir, "routing-log");
  assertValid(record);
  assert.equal(record.complete, false);
  assert.deepEqual(record.missing_events, ["task.dispatched", "subagent.stopped"]);
});

test("without routing.yaml the Harness is off: hooks and emit write nothing", () => {
  const dir = makeRepo({ routing: false });
  const result = emit(dir, "task.scored", "--task", "PLAN-1.1", "--data", "{}");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /off/);
  assert.equal(hook(dir, "subagent-stop", { session_id: SESSION, agent_id: "a1", agent_type: "harness:impl-t1", last_assistant_message: "no header" }).stdout, "");
  assert.equal(existsSync(join(dir, ".harness")), false);
});

test("a bad call never fails the caller, and is counted rather than lost (C12)", () => {
  const dir = makeRepo();
  const result = emit(dir, "task.scored", "--task", "PLAN-1.1", "--data", "{not json");
  assert.equal(result.status, 0);
  assert.match(result.stderr, /not written/);
  assert.equal(readFileSync(join(dir, ".harness", "emit-failures"), "utf8").trim(), "1");
});

test("subagents from other plugins are ignored", () => {
  const dir = makeRepo();
  const result = hook(dir, "subagent-stop", { session_id: SESSION, agent_id: "a2", agent_type: "general-purpose", last_assistant_message: "no header" });
  assert.equal(result.stdout, "");
  assert.equal(lines(dir, "events").length, 0);
});

test("the first event under a config snapshots it, once, as harness.config/v1", () => {
  const dir = makeRepo();
  emit(dir, "task.scored", "--task", "PLAN-1.1", "--data", '{"scores":{"ambiguity":0,"blast":0,"coupling":0,"novelty":0,"reversibility":0,"verification":0},"total":0,"score_band":"T1","overrides":[],"tier_planned":"T1"}');
  const [event] = lines(dir, "events");
  const path = join(dir, ".harness", "configs", `${event.config_sha256}.json`);

  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  assertValid(snapshot);
  assert.equal(snapshot.mode, "observe");
  assert.deepEqual(snapshot.tiers.T1, { max_score: 2, agent: "impl-t1", model: "sonnet", effort: "low" });
  assert.deepEqual(snapshot.tiers.T4, { max_score: 12, agent: "impl-t4", model: "opus", effort: "medium" });
  assert.deepEqual(snapshot.repo, event.repo);

  const written = readFileSync(path, "utf8");
  emit(dir, "task.completed", "--task", "PLAN-1.1", "--data", '{"outcome":"human","final_tier":"T1","eval_rounds":0,"escalations":0}');
  assert.equal(readFileSync(path, "utf8"), written, "a snapshot is written once and never rewritten");
});

test("a report handed back through SubagentHandback counts, and the agent is not sent back for it", () => {
  // As in the first full run (2026-10-07): the agent's last turn is the handback call, so its last
  // message is not the report.
  const dir = makeRepo();
  const transcript = join(dir, "agent-a1.jsonl");
  writeFileSync(transcript, [
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }),
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", name: "SubagentHandback", input: { message: "PASS: PLAN-1.1\n\nEvery criterion met." } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "Report delivered to your caller." }] } }),
  ].join("\n") + "\n");

  const result = hook(dir, "subagent-stop", {
    session_id: SESSION, agent_id: "a1", agent_type: "harness:evaluator", last_assistant_message: "", stop_hook_active: false, agent_transcript_path: transcript,
  });

  assert.equal(result.stdout, "", "a correct handback must not be blocked");
  const stopped = lines(dir, "events").find((e) => e.type === "subagent.stopped");
  assertValid(stopped);
  assert.equal(stopped.data.report, "PASS");
  assert.deepEqual(stopped.data.task_ids, ["PLAN-1.1"]);
  assert.equal(stopped.data.model, "claude-opus-5-5");
});

test("a series plan's tasks carry its series, still after a re-plan without it, and a plan on its own's don't (U3, H7)", () => {
  const dir = makeRepo();
  const at = (ts: string, type: string, plan: string, task: string | null, data: Record<string, unknown> = {}): Line => ({
    ts, type, session_id: SESSION, event_id: ts, plan_id: plan, ...(task ? { task_id: task } : {}), data,
    repo: { name: "r", remote_sha256: "0".repeat(64) }, producer: { name: "harness", version: "0.14.0" }, mode: "observe", config_sha256: "0".repeat(64),
  });
  const scores = { scores: { ambiguity: 0, blast: 0, coupling: 0, novelty: 0, reversibility: 0, verification: 0 }, total: 0, score_band: "T1", overrides: [], tier_planned: "T1" };
  const done = { outcome: "pass_first_try", final_tier: "T1", eval_rounds: 1, escalations: 0 };
  const groups = (task: string) => [{ group: "G1", task_ids: [task] }];
  const events = [
    // SERIES mode plans PLAN-2 as the series' second plan; a hand-back's re-plan later says nothing of it.
    at("2026-10-29T09:00:00Z", "plan.created", "PLAN-2", null, { task_count: 1, revision: 1, groups: groups("PLAN-2.1"), series: "SERIES-3", series_position: 2 }),
    at("2026-10-29T09:00:01Z", "plan.created", "PLAN-3", null, { task_count: 1, revision: 1, groups: groups("PLAN-3.1") }),
    at("2026-10-29T09:01:00Z", "task.scored", "PLAN-2", "PLAN-2.1", scores),
    at("2026-10-29T09:01:01Z", "task.scored", "PLAN-3", "PLAN-3.1", scores),
    at("2026-10-29T10:00:00Z", "plan.created", "PLAN-2", null, { task_count: 1, revision: 2, groups: groups("PLAN-2.1") }),
    at("2026-10-29T10:01:00Z", "task.dispatched", "PLAN-2", "PLAN-2.1", { tier: "T1", isolation: "none" }),
    at("2026-10-29T10:05:00Z", "task.completed", "PLAN-2", "PLAN-2.1", done),
    at("2026-10-29T10:06:00Z", "task.dispatched", "PLAN-3", "PLAN-3.1", { tier: "T1", isolation: "none" }),
    at("2026-10-29T10:09:00Z", "task.completed", "PLAN-3", "PLAN-3.1", done),
  ];
  const config = { dir, includeJustifications: true, layout: { planPath: join(dir, "PLAN.md") } } as Config;

  const inSeries = buildRecord(config, "PLAN-2.1", events as never, []).record;
  const alone = buildRecord(config, "PLAN-3.1", events as never, []).record;
  assert.ok(inSeries && alone, "both records were built");
  assert.equal(inSeries.series, "SERIES-3");
  assert.equal("series" in alone, false, "a plan on its own has no series field, as before 0.14.0");
});

test("a task's gate decisions are the ones made while it was being worked, not since the plan was scored", () => {
  // As in PLAN-3: every task scored up front, then worked one after the other, each ending in a commit.
  const dir = makeRepo();
  const at = (ts: string, type: string, task: string | null, data: Record<string, unknown> = {}): Line => ({
    ts, type, session_id: SESSION, event_id: ts, ...(task ? { task_id: task, plan_id: "PLAN-1" } : {}), data,
    repo: { name: "r", remote_sha256: "0".repeat(64) }, producer: { name: "harness", version: "0.2.3" }, mode: "observe", config_sha256: "0".repeat(64),
  });
  const scores = { scores: { ambiguity: 0, blast: 0, coupling: 0, novelty: 0, reversibility: 0, verification: 0 }, total: 0, score_band: "T1", overrides: [], tier_planned: "T1" };
  const done = { outcome: "pass_first_try", final_tier: "T1", eval_rounds: 1, escalations: 0 };
  const events = [
    at("2026-10-07T10:00:00Z", "task.scored", "PLAN-1.1", scores),
    at("2026-10-07T10:00:01Z", "task.scored", "PLAN-1.2", scores),
    at("2026-10-07T10:01:00Z", "task.dispatched", "PLAN-1.1", { tier: "T1", isolation: "none" }),
    at("2026-10-07T10:05:00Z", "gate.decision", null, { decision: "allow", reason: "pass" }),
    at("2026-10-07T10:05:02Z", "task.completed", "PLAN-1.1", done),
    // PLAN-1.2's tests are written before it is dispatched, and that is when its work began.
    { ...at("2026-10-07T10:05:30Z", "subagent.started", null), agent_id: "a-tests", agent_type: "harness:evaluator" },
    { ...at("2026-10-07T10:05:50Z", "subagent.stopped", null, { report: "DONE", duration_ms: 20000, partial: false, task_ids: ["PLAN-1.2"] }), agent_id: "a-tests", agent_type: "harness:evaluator" },
    at("2026-10-07T10:06:00Z", "task.dispatched", "PLAN-1.2", { tier: "T1", isolation: "none" }),
    at("2026-10-07T10:09:00Z", "gate.decision", null, { decision: "deny", reason: "no_marker" }),
    at("2026-10-07T10:10:00Z", "gate.decision", null, { decision: "allow", reason: "pass" }),
    at("2026-10-07T10:10:02Z", "task.completed", "PLAN-1.2", done),
  ];
  // Only what buildRecord reads when the events and the previous records are handed to it.
  const config = { dir, includeJustifications: true, layout: { planPath: join(dir, "PLAN.md") } } as Config;

  const first = buildRecord(config, "PLAN-1.1", events as never, []).record;
  const second = buildRecord(config, "PLAN-1.2", events as never, []).record;
  assert.ok(first && second, "both records were built");
  assert.deepEqual(first.gate, { denials: 0, denial_reasons: [], allowed: 1 });
  assert.deepEqual(second.gate, { denials: 1, denial_reasons: ["no_marker"], allowed: 1 });

  // The clock runs from when work began, not from scoring: 10:01:00 -> 10:05:02, and 10:05:30 (its
  // tests, before its dispatch) -> 10:10:02. From scoring, PLAN-1.2 would have read 600 s.
  assert.equal(first.wall_clock_s, 242);
  assert.equal(second.wall_clock_s, 272);
});

test("a task run again is recorded as its latest attempt, and a record too long for a line is trimmed to fit", () => {
  // As in S17–S21: one task, scored once, run to completion five times on the same day.
  const dir = makeRepo();
  const at = (ts: string, type: string, task: string | null, data: Record<string, unknown> = {}): Line => ({
    ts, type, session_id: SESSION, event_id: ts, ...(task ? { task_id: task, plan_id: "PLAN-1" } : {}), data,
    repo: { name: "r", remote_sha256: "0".repeat(64) }, producer: { name: "harness", version: "0.2.3" }, mode: "observe", config_sha256: "0".repeat(64),
  });
  const scores = { scores: { ambiguity: 0, blast: 0, coupling: 0, novelty: 0, reversibility: 0, verification: 0 }, total: 0, score_band: "T1", overrides: [], tier_planned: "T1" };
  const done = { outcome: "pass_first_try", final_tier: "T1", eval_rounds: 1, escalations: 0 };
  const stage = { name: "test", command: "npm test", result: "pass", exit_code: 0, duration_ms: 1000, log: "x".repeat(60) };
  const attempt = (n: number): Line[] => {
    const t = (m: number): string => `2026-10-27T1${n}:${String(m).padStart(2, "0")}:00Z`;
    const run = (id: string, agent: string, from: number, to: number): Line[] => [
      { ...at(t(from), "subagent.started", null), agent_id: id, agent_type: agent },
      { ...at(t(to), "subagent.stopped", null, { report: "DONE", partial: false, task_ids: ["PLAN-1.1"], model_requested: "inherit", model: "claude-opus-5-5", effort: "medium" }), agent_id: id, agent_type: agent },
    ];
    return [
      at(t(1), "task.dispatched", "PLAN-1.1", { tier: "T1", isolation: "none" }),
      ...run(`a${n}-tests`, "harness:evaluator", 2, 3), ...run(`a${n}-impl`, "harness:impl-t1", 4, 5), ...run(`a${n}-eval`, "harness:evaluator", 6, 7),
      at(t(8), "eval.completed", "PLAN-1.1", { result: "pass", failed_acs: [], stages: [stage, stage, stage] }),
      at(t(9), "task.completed", "PLAN-1.1", done),
    ];
  };
  const events = [at("2026-10-27T09:00:00Z", "task.scored", "PLAN-1.1", scores), ...[1, 2, 3, 4, 5].flatMap(attempt)];
  const config = { dir, includeJustifications: true, layout: { planPath: join(dir, "PLAN.md") } } as Config;

  const record = buildRecord(config, "PLAN-1.1", events as never, []).record;
  assert.ok(record, "the record was built");
  const runs = record.runs as { agent_id: string }[];
  assert.deepEqual(runs.map((r) => r.agent_id), ["a5-tests", "a5-impl", "a5-eval"], "only the fifth attempt's runs");
  assert.equal((record.eval_rounds as unknown[]).length, 1);
  assert.equal(record.wall_clock_s, 8 * 60, "from the fifth attempt's dispatch, not from scoring");
  assert.ok(Buffer.byteLength(JSON.stringify(record)) < 4096, "one attempt fits a line");

  // A long attempt (many runs, long stage logs) is trimmed, keeping every run's id for pricing.
  const long = { ...record, runs: Array.from({ length: 14 }, (_, i) => ({ ...runs[0], agent_id: `a-long-${i}` })), eval_rounds: Array.from({ length: 4 }, (_, i) => ({ round: i + 1, result: "fail", failed_acs: [], stages: [stage, stage, stage] })) };
  assert.ok(Buffer.byteLength(JSON.stringify(long)) >= 4096, "the test's long record really is too long");
  const trimmed = fitted(long as never);
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed)) < 4096, `trimmed to ${Buffer.byteLength(JSON.stringify(trimmed))} bytes`);
  assert.equal((trimmed.runs as unknown[]).length, 14);
  assert.deepEqual(Object.keys((trimmed.runs as Record<string, unknown>[])[0] ?? {}).sort(), ["agent_id", "agent_type", "ended", "model", "partial", "report", "started"]);
  assert.deepEqual(trimmed.trimmed, ["runs.model_requested", "runs.effort", "eval_rounds.stages"]);
  assert.equal(fitted(record), record, "a record that fits is left alone");
});

test("a run whose meta.json names no model is recorded as having inherited it", () => {
  const dir = makeRepo();
  const transcript = join(dir, "agent-a7.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [] } }) + "\n");
  writeFileSync(join(dir, "agent-a7.meta.json"), JSON.stringify({ agentType: "harness:impl-t1", description: "Implement PLAN-1.1" }));

  hook(dir, "subagent-stop", {
    session_id: SESSION, agent_id: "a7", agent_type: "harness:impl-t1", last_assistant_message: "DONE: PLAN-1.1", agent_transcript_path: transcript,
  });

  const stopped = lines(dir, "events").find((e) => e.type === "subagent.stopped");
  assertValid(stopped);
  assert.equal(stopped.data.model_requested, "inherit");
  assert.equal(stopped.data.model, "claude-opus-5-5");
});

test("the orchestrator's own contexts are not subagent runs", () => {
  const dir = makeRepo();
  for (const name of ["subagent-start", "subagent-stop"]) {
    const result = hook(dir, name, { session_id: SESSION, agent_id: "a9802488", agent_type: "harness:orchestrator", last_assistant_message: "no header", stop_hook_active: false });
    assert.equal(result.stdout, "", `${name} acted on the orchestrator`);
  }
  assert.equal(lines(dir, "events").length, 0);
});

test("the dispatcher's run is recorded, and belongs to no task", () => {
  const dir = makeRepo();
  const agent = { session_id: SESSION, agent_id: "ad15pa7c4e5", agent_type: "harness:dispatcher" };
  assert.equal(hook(dir, "subagent-start", agent).status, 0);

  // No header: sent back once, like any Harness agent.
  const blocked = hook(dir, "subagent-stop", { ...agent, last_assistant_message: "All six tasks are committed.", stop_hook_active: false });
  assert.equal(JSON.parse(blocked.stdout).decision, "block");

  // A header naming a task, against its instructions: the run still isn't one of that task's.
  hook(dir, "subagent-stop", { ...agent, last_assistant_message: "ESCALATE: PLAN-2 — stopped by rule S1 at PLAN-2.4\n...", stop_hook_active: true });
  const events = lines(dir, "events");
  assert.deepEqual(events.map((e) => e.type), ["subagent.started", "subagent.stopped"]);
  events.forEach(assertValid);
  assert.equal(events[1].data.report, "ESCALATE");
  assert.deepEqual(events[1].data.task_ids, []);
});

test("the intake gate reads the dispatcher's plan from DISPATCH: PLAN-n", () => {
  const dir = makeRepo();
  const call = (prompt: string) =>
    hook(dir, "pre-tool-use", { session_id: SESSION, tool_name: "Agent", tool_input: { subagent_type: "harness:dispatcher", prompt } });

  const refused = JSON.parse(call("DISPATCH: PLAN-3\nPLAN.md is at ...").stdout);
  assert.equal(refused.hookSpecificOutput.permissionDecision, "deny");
  assert.match(refused.hookSpecificOutput.permissionDecisionReason, /intake gate: PLAN-3 has had no intake/);

  assert.match(JSON.parse(call("Run the plan").stdout).hookSpecificOutput.permissionDecisionReason, /DISPATCH: PLAN-n/);

  assert.equal(emit(dir, "plan.intake", "--plan", "PLAN-3", "--data", '{"round":1,"ambiguity":0,"max_ambiguity":0,"questions":0,"settled":true}').status, 0);
  assert.equal(call("DISPATCH: PLAN-3\nPLAN.md is at ...").stdout, "", "a settled intake lets the dispatcher start");
});

test("SessionStart hands the session the path to harness-emit", () => {
  const dir = makeRepo();
  const out = JSON.parse(hook(dir, "session-start", { session_id: SESSION, source: "startup" }).stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /mode: observe/);
  assert.match(out.hookSpecificOutput.additionalContext, /bin\/harness-emit\.mjs/);
  assert.match(out.hookSpecificOutput.additionalContext, /bin\/harness-eval\.mjs/);
  // ...and records where the plugin lives, for the repository's git hooks.
  assert.equal(JSON.parse(readFileSync(join(dir, ".harness-home", "plugin.json"), "utf8")).root, root);
});

test("PLAN-1.3/AC-4 the routing-log record carries policy_fit, recommendation and model_source from its events", () => {
  const dir = makeRepo();
  const recommendation = { model: "opus", effort: "high", reason: "Touches the payment flow" };
  emit(dir, "task.scored", "--task", "PLAN-1.1", "--data", JSON.stringify({
    scores: { ambiguity: 0, blast: 1, coupling: 1, novelty: 0, reversibility: 0, verification: 1 }, total: 3, score_band: "T2", overrides: [], tier_planned: "T2",
    policy_fit: "recommended", recommendation,
  }));
  // Two dispatches: the record takes model_source from the latest one.
  emit(dir, "task.dispatched", "--task", "PLAN-1.1", "--data", '{"tier":"T2","agent_type":"harness:impl-t2","model_requested":"sonnet","effort":"medium","isolation":"none","model_source":"policy"}');
  emit(dir, "task.dispatched", "--task", "PLAN-1.1", "--data", '{"tier":"T2","agent_type":"harness:impl-t2","model_requested":"opus","effort":"high","isolation":"none","model_source":"override"}');
  emit(dir, "task.completed", "--task", "PLAN-1.1", "--data", '{"outcome":"pass","final_tier":"T2","eval_rounds":0,"escalations":0}');

  const events = lines(dir, "events");
  events.forEach(assertValid);
  const [record] = lines(dir, "routing-log");
  assertValid(record);
  assert.equal(record.rubric.policy_fit, "recommended");
  assert.deepEqual(record.rubric.recommendation, recommendation);
  assert.equal(record.rubric.model_source, "override", "model_source comes from the latest task.dispatched");
});

test("PLAN-1.3/AC-4 a task that fits carries policy_fit fits and no recommendation", () => {
  const dir = makeRepo();
  emit(dir, "task.scored", "--task", "PLAN-1.1", "--data", '{"scores":{"ambiguity":0,"blast":0,"coupling":0,"novelty":0,"reversibility":0,"verification":0},"total":0,"score_band":"T1","overrides":[],"tier_planned":"T1","policy_fit":"fits"}');
  emit(dir, "task.dispatched", "--task", "PLAN-1.1", "--data", '{"tier":"T1","agent_type":"harness:impl-t1","model_requested":"sonnet","isolation":"none","model_source":"policy"}');
  emit(dir, "task.completed", "--task", "PLAN-1.1", "--data", '{"outcome":"pass","final_tier":"T1","eval_rounds":0,"escalations":0}');

  const [record] = lines(dir, "routing-log");
  assertValid(record);
  assert.equal(record.rubric.policy_fit, "fits");
  assert.equal("recommendation" in record.rubric, false);
  assert.equal(record.rubric.model_source, "policy");
});

test("PLAN-1.3/AC-4 a task whose events lack the fields gets a record without those keys", () => {
  const dir = makeRepo();
  emit(dir, "task.scored", "--task", "PLAN-1.1", "--data", '{"scores":{"ambiguity":0,"blast":0,"coupling":0,"novelty":0,"reversibility":0,"verification":0},"total":0,"score_band":"T1","overrides":[],"tier_planned":"T1"}');
  emit(dir, "task.dispatched", "--task", "PLAN-1.1", "--data", '{"tier":"T1","agent_type":"harness:impl-t1","model_requested":"inherit","isolation":"none"}');
  emit(dir, "task.completed", "--task", "PLAN-1.1", "--data", '{"outcome":"pass","final_tier":"T1","eval_rounds":0,"escalations":0}');

  const [record] = lines(dir, "routing-log");
  assertValid(record);
  for (const key of ["policy_fit", "recommendation", "model_source"]) {
    assert.equal(key in record.rubric, false, `rubric.${key} should be omitted`);
    assert.equal(key in record, false, `${key} should be omitted`);
  }
});
