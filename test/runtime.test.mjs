// Runs the bundled bin/ scripts exactly as Claude Code would, against a throwaway git repo, and
// checks that every line they write satisfies the v1 schemas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReport } from "../src/lib/ids.mjs";
import { describe, root, validators } from "./validators.mjs";

const SESSION = "11111111-2222-4333-8444-555555555555";

function makeRepo({ routing = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/example/Sample-Repo.git"]);
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
const env = (dir) => ({ ...process.env, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: root, HARNESS_HOME: join(dir, ".harness-home") });

const emit = (dir, ...args) =>
  spawnSync("node", [join(root, "bin", "harness-emit.mjs"), ...args], { cwd: dir, env: env(dir), encoding: "utf8" });

const hook = (dir, name, input) =>
  spawnSync("node", [join(root, "bin", `hook-${name}.mjs`)], { cwd: dir, env: env(dir), input: JSON.stringify(input), encoding: "utf8" });

const lines = (dir, folder) => {
  const path = join(dir, ".harness", folder);
  if (!existsSync(path)) return [];
  return readdirSync(path).flatMap((f) => readFileSync(join(path, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
};

const assertValid = (value) => {
  const validate = validators[value.schema];
  assert.ok(validate(value), `${value.type ?? value.schema} does not match its schema:\n  ${describe(validate)}`);
};

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

  const stopped = events.find((e) => e.type === "subagent.stopped");
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

test("SessionStart hands the session the path to harness-emit", () => {
  const dir = makeRepo();
  const out = JSON.parse(hook(dir, "session-start", { session_id: SESSION, source: "startup" }).stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /mode: observe/);
  assert.match(out.hookSpecificOutput.additionalContext, /bin\/harness-emit\.mjs/);
  assert.match(out.hookSpecificOutput.additionalContext, /bin\/harness-eval\.mjs/);
  // ...and records where the plugin lives, for the repository's git hooks.
  assert.equal(JSON.parse(readFileSync(join(dir, ".harness-home", "plugin.json"), "utf8")).root, root);
});
