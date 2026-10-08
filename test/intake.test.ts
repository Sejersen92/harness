// The intake gate and the score review (ANY-REPO.md, H4): no Harness agent starts on a plan until its
// brief is clear enough or a person overrules, and a person's review of the scores is kept beside the
// orchestrator's estimate, never in place of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intakeVerdict, plansIn } from "../src/lib/intake.ts";
import { buildRecord } from "../src/lib/tasklog.ts";
import type { Config, HarnessEvent } from "../src/lib/types.ts";
import { root, validatorFor, type Line } from "./validators.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";

const intake = (plan: string, data: Record<string, unknown>, ts = "2026-10-08T10:00:00Z"): HarnessEvent => ({
  schema: "harness.events/v1", event_id: "01M4QP0A00J3VZ9X8M2N5K7Q4C", ts, type: "plan.intake",
  producer: { name: "harness", version: "0.7.0" }, repo: { name: "r", remote_sha256: "0".repeat(64) },
  mode: "observe", session_id: SESSION, config_sha256: "0".repeat(64), plan_id: plan, data,
});

test("a plan starts only once its latest intake round is under the threshold, or overruled", () => {
  assert.equal(intakeVerdict("PLAN-1", 0, []).allowed, false, "no intake at all");
  assert.match(intakeVerdict("PLAN-1", 0, []).detail, /no intake: write its brief/);

  const unclear = intake("PLAN-1", { round: 1, ambiguity: 1, max_ambiguity: 0, questions: 2, settled: false });
  assert.equal(intakeVerdict("PLAN-1", 0, [unclear]).allowed, false);
  assert.match(intakeVerdict("PLAN-1", 0, [unclear]).detail, /ask the person the open questions/);
  assert.equal(intakeVerdict("PLAN-1", 1, [unclear]).allowed, true, "a repository may allow 1 in routing.yaml");

  const clear = intake("PLAN-1", { round: 2, ambiguity: 0, max_ambiguity: 0, questions: 0, settled: true }, "2026-10-08T10:05:00Z");
  assert.equal(intakeVerdict("PLAN-1", 0, [unclear, clear]).allowed, true, "the latest round counts");
  assert.equal(intakeVerdict("PLAN-1", 0, [clear, intake("PLAN-1", { round: 3, ambiguity: 2, max_ambiguity: 0, questions: 1, settled: false })]).allowed, false, "a later, worse round closes it again");
  assert.equal(intakeVerdict("PLAN-2", 0, [clear]).allowed, false, "another plan's intake doesn't count");

  const overruled = intake("PLAN-1", { round: 1, ambiguity: 2, max_ambiguity: 0, questions: 1, settled: true, review: { verdict: "overruled", by: "human", reason: "a spike" } });
  assert.equal(intakeVerdict("PLAN-1", 0, [overruled]).allowed, true);
  assert.match(intakeVerdict("PLAN-1", 0, [overruled]).detail, /overruled by the person: a spike/);
});

test("the threshold is routing.yaml's, never the one the orchestrator wrote into the event", () => {
  const lowered = intake("PLAN-1", { round: 1, ambiguity: 2, max_ambiguity: 2, questions: 0, settled: true });
  assert.equal(intakeVerdict("PLAN-1", 0, [lowered]).allowed, false);
});

test("a dispatch's plans come from its header line only", () => {
  assert.deepEqual(plansIn("WRITE-TESTS: PLAN-7.2\n\n### PLAN-7.2 — x\n- Depends on: PLAN-7.1"), ["PLAN-7"]);
  assert.deepEqual(plansIn("EVALUATE: PLAN-3.1, PLAN-4.2"), ["PLAN-3", "PLAN-4"]);
  assert.deepEqual(plansIn("do the thing"), []);
  // The first gated run (2026-10-08): PLAN-9.1's dispatch named PLAN-6's and PLAN-8's tests further down.
  assert.deepEqual(plansIn("\n  IMPLEMENT: PLAN-9.1\nThe existing tests PLAN-6.1/AC-2 and PLAN-8.2/AC-1 must keep passing."), ["PLAN-9"]);
  assert.deepEqual(plansIn("do the thing\nfor PLAN-9.1"), [], "a task named only below the first line is no header");
});

test("the hook refuses a Harness agent for a plan without a settled intake, and lets it through after", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-intake-"));
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, "routing.yaml"), readFileSync(join(root, "templates", "routing.yaml")));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: root, HARNESS_HOME: join(dir, ".harness-home") };
  const dispatch = (subagent_type: string, prompt: string): Line | null => {
    const result = spawnSync("node", [join(root, "bin", "hook-pre-tool-use.mjs")], {
      cwd: dir, env, encoding: "utf8",
      input: JSON.stringify({ session_id: SESSION, tool_name: "Agent", tool_input: { subagent_type, prompt, description: "d" } }),
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? (JSON.parse(result.stdout) as { hookSpecificOutput: Line }).hookSpecificOutput : null;
  };
  const emit = (...args: string[]) => spawnSync("node", [join(root, "bin", "harness-emit.mjs"), ...args], { cwd: dir, env, encoding: "utf8" });

  const refused = dispatch("harness:evaluator", "WRITE-TESTS: PLAN-1.1");
  assert.equal(refused?.permissionDecision, "deny");
  assert.match(String(refused?.permissionDecisionReason), /intake gate: PLAN-1 has had no intake/);

  assert.match(String(dispatch("harness:impl-t2", "please do it")?.permissionDecisionReason), /must start with its header line naming the task/);
  assert.equal(dispatch("general-purpose", "look around"), null, "agents that aren't the Harness's are not gated");

  emit("plan.intake", "--plan", "PLAN-1", "--data", JSON.stringify({ round: 1, ambiguity: 1, max_ambiguity: 0, questions: 2, settled: false }));
  assert.match(String(dispatch("harness:evaluator", "WRITE-TESTS: PLAN-1.1")?.permissionDecisionReason), /still scores ambiguity 1, over the 0/);

  emit("plan.intake", "--plan", "PLAN-1", "--data", JSON.stringify({ round: 2, ambiguity: 0, max_ambiguity: 0, questions: 0, settled: true }));
  assert.equal(dispatch("harness:evaluator", "WRITE-TESTS: PLAN-1.1"), null, "a clear brief lets the work start");
  assert.equal(dispatch("harness:impl-t2", "IMPLEMENT: PLAN-1.1\nKeep PLAN-0.3/AC-1 passing."), null, "an older plan named below the header is not gated");
});

test("an overrule must say why, and a score overrule must keep the orchestrator's original", () => {
  const scored = (review: Record<string, unknown>): Line => ({
    ...intake("PLAN-1", {}), type: "task.scored", task_id: "PLAN-1.1",
    data: { scores: { ambiguity: 0, blast: 2, coupling: 1, novelty: 0, reversibility: 0, verification: 1 }, total: 4, score_band: "T2", overrides: [], tier_planned: "T3", review },
  });
  const original = { scores: { ambiguity: 0, blast: 1, coupling: 1, novelty: 0, reversibility: 0, verification: 0 }, total: 2, score_band: "T1", tier_planned: "T1" };
  const valid = (line: Line): boolean => validatorFor(line)(line) as boolean;

  assert.equal(valid(scored({ verdict: "agreed", by: "human" })), true);
  assert.equal(valid(scored({ verdict: "overruled", by: "human", reason: "touches payments", original })), true);
  assert.equal(valid(scored({ verdict: "overruled", by: "human", original })), false, "no reason");
  assert.equal(valid(scored({ verdict: "overruled", by: "human", reason: "touches payments" })), false, "no original");
  assert.equal(valid(scored({ verdict: "agreed", by: "the orchestrator" })), false, "a review is a person's");
  assert.equal(valid({ ...intake("PLAN-1", { round: 1, ambiguity: 2, max_ambiguity: 0, questions: 0, settled: true, review: { verdict: "overruled", by: "human" } }) }), false, "an intake overrule needs a reason too");
});

test("the routing log carries the person's review of the score", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-intake-log-"));
  const base = (ts: string, type: string, data: Record<string, unknown>): HarnessEvent => ({ ...intake("PLAN-1", data, ts), type, task_id: "PLAN-1.1" });
  const review = { verdict: "overruled", by: "human", reason: "touches payments", original: { scores: {}, total: 2, score_band: "T1", tier_planned: "T1" } };
  const events = [
    base("2026-10-08T10:00:00Z", "task.scored", { scores: {}, total: 4, score_band: "T2", overrides: [], tier_planned: "T3", review }),
    base("2026-10-08T10:01:00Z", "task.dispatched", { tier: "T3", isolation: "none" }),
    base("2026-10-08T10:09:00Z", "task.completed", { outcome: "pass_first_try", final_tier: "T3" }),
  ];
  const config = { dir, includeJustifications: true, layout: { planPath: join(dir, "PLAN.md") } } as Config;
  const { record } = buildRecord(config, "PLAN-1.1", events, []);
  assert.deepEqual((record?.rubric as { review?: unknown }).review, review);
});
