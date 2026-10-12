// The orchestrator's instructions show the events it emits as `harness-emit <type> --task|--plan <id> --data '<json>'`
// commands. Every complete one must be a valid v1 event once wrapped in an envelope, so the agent is never told
// to emit something the schema rejects. Elided examples (with `...`) are not JSON and are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, root, validators, type Line } from "./validators.ts";

const file = "agents/orchestrator.md";
const text = readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");

type Example = { where: string; event: Line };

/** The placeholder ids in the instructions (PLAN-n, PLAN-n.m) stand for real ones, in the command and in its data. */
const placeholders = (s: string): string => s.replace(/PLAN-n\.m\b/g, "PLAN-7.1").replace(/PLAN-n\b/g, "PLAN-7");

/** Every `harness-emit` command in the file whose --data parses, wrapped as a full v1 event of its type. */
function emitExamples(): Example[] {
  const found: Example[] = [];
  for (const m of text.matchAll(/harness-emit ([a-z]+(?:\.[a-z_]+)+) --(task|plan) (\S+) --data '([^']*)'/g)) {
    const [, type, flag, id, json = ""] = m;
    let data: unknown;
    try { data = JSON.parse(placeholders(json)); } catch { continue; }
    const line = text.slice(0, m.index).split("\n").length;
    const event: Line = {
      schema: "harness.events/v1",
      event_id: "01M5A2Q0000V8T7S6R5Q4P3N2M",
      ts: "2026-10-12T09:00:00Z",
      type,
      producer: { name: "harness", version: "0.8.2" },
      repo: { name: "previouslyupcoming", remote_sha256: "8870c7e3b16d6d10f365ee183b8906cfe8c76d6a9fd8229e1990e0247877a6e3" },
      mode: "route",
      session_id: "3f6a9c2e-7d41-4b8e-a5c0-1e2d3f4a5b6c",
      config_sha256: "9f811fd217cfa016d705daa56a07b63e731424ff9223514e5091e4d7802bdff5",
      data,
    };
    const real = placeholders(id ?? "");
    if (flag === "task") { event.task_id = real; event.plan_id = real.replace(/\..*$/, ""); }
    else event.plan_id = real;
    found.push({ where: `${file}:${line} (${type})`, event });
  }
  return found;
}

const examples = emitExamples();
const ofType = (type: string): Line[] => examples.filter((e) => e.event.type === type).map((e) => e.event.data as Line);

test("PLAN-1.4/AC-5 the orchestrator's instructions hold complete emit examples, so the check cannot pass on nothing", () => {
  assert.ok(examples.length >= 5, `only ${examples.length} complete harness-emit examples found in ${file}`);
  assert.ok(ofType("task.scored").length >= 1, "no complete task.scored example");
  assert.ok(ofType("task.dispatched").length >= 1, "no complete task.dispatched example");
});

for (const { where, event } of examples) {
  test(`PLAN-1.4/AC-5 emit example at ${where} is a valid harness.events/v1 event`, () => {
    const validate = validators["harness.events/v1"];
    assert.ok(validate, "events schema not loaded");
    assert.ok(validate(event), `${where}:\n  ${describe(validate)}`);
  });
}

test("PLAN-1.4/AC-3 a task.scored example records the policy fit", () => {
  const withFit = ofType("task.scored").filter((d) => d.policy_fit !== undefined);
  assert.ok(withFit.length >= 1, `no task.scored example in ${file} carries policy_fit`);
});

test("PLAN-1.4/AC-3 a task.scored example shows a recommendation {model, effort, reason} with policy_fit recommended", () => {
  const recommended = ofType("task.scored").filter((d) => d.policy_fit === "recommended");
  assert.ok(recommended.length >= 1, `no task.scored example in ${file} has policy_fit "recommended"`);
  for (const d of recommended) {
    const r = d.recommendation as Line | undefined;
    assert.ok(r && typeof r === "object", "a recommended task.scored example has no recommendation");
    assert.equal(typeof r.model, "string", "recommendation.model missing");
    assert.equal(typeof r.effort, "string", "recommendation.effort missing");
    assert.ok(typeof r.reason === "string" && r.reason.length > 0, "recommendation.reason missing");
  }
});

test("PLAN-1.4/AC-4 a task.dispatched example records model_source", () => {
  const withSource = ofType("task.dispatched").filter((d) => d.model_source !== undefined);
  assert.ok(withSource.length >= 1, `no task.dispatched example in ${file} carries model_source`);
  for (const d of withSource) {
    assert.ok(["policy", "override"].includes(String(d.model_source)), `model_source ${String(d.model_source)} is not policy or override`);
  }
});

test("PLAN-1.4/AC-4 an overridden dispatch example asks for an alias, never inherit", () => {
  for (const d of ofType("task.dispatched").filter((x) => x.model_source === "override")) {
    assert.notEqual(d.model_requested, "inherit", "an override passes its alias as model, so model_requested is the alias");
  }
});
