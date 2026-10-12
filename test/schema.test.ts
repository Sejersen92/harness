// The contract test: every example in the docs must validate against the v1 schemas,
// and every design fix (C6-C12) must be enforced by the schema, not just written down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, root, validators, type Line } from "./validators.ts";

/** Every fenced json/jsonl block in docs/*.md that claims one of our schemas, with where it came from. */
function docExamples(): { where: string; piece: string }[] {
  const examples: { where: string; piece: string }[] = [];
  for (const file of readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(root, "docs", file), "utf8").replace(/\r\n/g, "\n");
    for (const block of text.matchAll(/^```(jsonl?)[^\n]*\n([\s\S]*?)^```/gm)) {
      const fence = text.slice(0, block.index).split("\n").length;
      const [, kind, body = ""] = block;
      // A jsonl block is one example per line; a json block is one example, located at its fence.
      const pieces = kind === "jsonl"
        ? body.split("\n").map((piece, i) => ({ piece, line: fence + 1 + i })).filter((p) => p.piece.trim())
        : [{ piece: body, line: fence }];
      for (const { piece, line } of pieces) {
        if (!/"schema":\s*"harness\./.test(piece)) continue;
        examples.push({ where: `docs/${file}:${line}`, piece });
      }
    }
  }
  return examples;
}

const examples = docExamples();

test("the docs contain examples of both outputs, so this test cannot pass by checking nothing", () => {
  const schemas = new Set(examples.map((e) => { try { return (JSON.parse(e.piece) as Line).schema as unknown; } catch { return null; } }));
  assert.ok(examples.length >= 10, `only ${examples.length} examples found`);
  assert.ok(schemas.has("harness.events/v1"), "no event examples found");
  assert.ok(schemas.has("harness.routing-log/v1"), "no routing-log examples found");
});

for (const { where, piece } of examples) {
  test(`example at ${where} is valid`, () => {
    let value: Line = {};
    assert.doesNotThrow(() => { value = JSON.parse(piece) as Line; }, `${where} is not valid JSON (no "…" placeholders in examples)`);
    const validate = validators[String(value.schema)];
    assert.ok(validate, `${where} names an unknown schema ${value.schema}`);
    assert.ok(validate(value), `${where}:\n  ${describe(validate)}`);
  });
}

// --- Each design fix must be enforced, not only documented ---------------------------------

const firstOf = (schema: string, type?: string): Line => {
  const found = examples.map((e) => JSON.parse(e.piece) as Line).find((v) => v.schema === schema && (!type || v.type === type));
  assert.ok(found, `no ${type ?? schema} example in the docs to mutate`);
  return structuredClone(found);
};
const rejects = (value: Line, why: string): void => {
  const validate = validators[String(value.schema)];
  assert.ok(validate, `no schema ${String(value.schema)}`);
  assert.equal(validate(value), false, `should be rejected: ${why}`);
};
const accepts = (value: Line, why: string): void => {
  const validate = validators[String(value.schema)];
  assert.ok(validate, `no schema ${String(value.schema)}`);
  assert.ok(validate(value), `should be accepted: ${why}\n  ${describe(validate)}`);
};

test("C6: short score names (a, b, c, n, r, v) are rejected", () => {
  const event = firstOf("harness.events/v1", "task.scored");
  event.data.scores = { a: 0, b: 1, c: 2, n: 0, r: 0, v: 1 };
  rejects(event, "short score names");
  const record = firstOf("harness.routing-log/v1");
  record.rubric.scores = { a: 0, b: 1, c: 2, n: 0, r: 0, v: 1 };
  rejects(record, "short score names in the routing log");
});

test("C7: task.scored without score_band is rejected", () => {
  const event = firstOf("harness.events/v1", "task.scored");
  delete event.data.score_band;
  rejects(event, "missing score_band");
});

test("C8: an unqualified acceptance-criterion id is rejected", () => {
  const event = firstOf("harness.events/v1", "eval.completed");
  event.data.failed_acs = ["AC-2"];
  rejects(event, "failed_acs not qualified with its task");
  const record = firstOf("harness.routing-log/v1");
  record.eval_rounds[0].failed_acs = ["AC-2"];
  rejects(record, "routing-log failed_acs not qualified");
});

test("C9: an event or record without config_sha256 is rejected", () => {
  const event = firstOf("harness.events/v1");
  delete event.config_sha256;
  rejects(event, "missing config_sha256");
  const record = firstOf("harness.routing-log/v1");
  delete record.config_sha256;
  rejects(record, "routing log missing config_sha256");
});

test("C12: a record marked incomplete must say what was missing", () => {
  const record = firstOf("harness.routing-log/v1");
  record.complete = false;
  delete record.missing_events;
  rejects(record, "complete: false without missing_events");
  record.missing_events = ["task.scored"];
  accepts(record, "complete: false with missing_events");
});

test("event ids are full 26-character ULIDs (Appendix A's examples used 14)", () => {
  const event = firstOf("harness.events/v1");
  event.event_id = "01JA8Z6Q3K9V2W";
  rejects(event, "14-character event_id");
});

test("mode: off writes nothing, so it never appears in a line", () => {
  const event = firstOf("harness.events/v1");
  event.mode = "off";
  rejects(event, "mode off");
});

test("v1 is additive: unknown event types and unknown fields are accepted", () => {
  const event = firstOf("harness.events/v1");
  event.type = "task.paused";
  event.data = { anything: true };
  accepts(event, "unknown event type checked against the envelope only");
  const scored = firstOf("harness.events/v1", "task.scored");
  scored.data.new_field_from_a_later_v1 = 1;
  scored.envelope_extra = "x";
  accepts(scored, "unknown fields");
});

// --- PLAN-1.3: the run's fit check (policy_fit, recommendation, model_source) ------------------

const recommendation = { model: "opus", effort: "high", reason: "Touches the payment flow" };
const parsedExamples = (): Line[] => examples.flatMap((e) => { try { return [JSON.parse(e.piece) as Line]; } catch { return []; } });

test("PLAN-1.3/AC-1 task.scored accepts policy_fit recommended with a recommendation, and fits without one", () => {
  const recommended = firstOf("harness.events/v1", "task.scored");
  recommended.data.policy_fit = "recommended";
  recommended.data.recommendation = { ...recommendation };
  accepts(recommended, "policy_fit recommended with a recommendation");
  for (const model of ["haiku", "sonnet", "opus"]) {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      recommended.data.recommendation = { model, effort, reason: "r" };
      accepts(recommended, `recommendation ${model}/${effort}`);
    }
  }
  const fits = firstOf("harness.events/v1", "task.scored");
  fits.data.policy_fit = "fits";
  accepts(fits, "policy_fit fits without a recommendation");
  // Fails until the schema knows the fields: recommended without a recommendation must not pass.
  const bare = firstOf("harness.events/v1", "task.scored");
  bare.data.policy_fit = "recommended";
  rejects(bare, "policy_fit recommended without a recommendation");
});

test("PLAN-1.3/AC-1 task.scored rejects a recommendation that is missing, forbidden or malformed", () => {
  const event = firstOf("harness.events/v1", "task.scored");
  event.data.policy_fit = "recommended";
  rejects(event, "recommended without a recommendation");

  event.data.policy_fit = "fits";
  event.data.recommendation = { ...recommendation };
  rejects(event, "fits with a recommendation");

  event.data.policy_fit = "recommended";
  for (const [bad, why] of [
    [{ ...recommendation, model: "gpt-4" }, "unknown model"],
    [{ ...recommendation, model: "claude-opus-5-5" }, "a full model id, not an alias"],
    [{ ...recommendation, effort: "extreme" }, "unknown effort"],
    [{ ...recommendation, reason: "" }, "empty reason"],
    [{ model: "opus", effort: "high" }, "missing reason"],
    [{ effort: "high", reason: "r" }, "missing model"],
    [{ model: "opus", reason: "r" }, "missing effort"],
    ["opus", "recommendation not an object"],
  ] as const) {
    event.data.recommendation = structuredClone(bad);
    rejects(event, `recommendation with ${why}`);
  }
});

test("PLAN-1.3/AC-2 task.dispatched accepts model_source policy or override, and rejects anything else", () => {
  const event = firstOf("harness.events/v1", "task.dispatched");
  for (const source of ["policy", "override"]) {
    event.data.model_source = source;
    accepts(event, `model_source ${source}`);
  }
  for (const bad of ["inherit", "routing", "", "Policy", 1]) {
    event.data.model_source = bad;
    rejects(event, `model_source ${JSON.stringify(bad)}`);
  }
});

test("PLAN-1.3/AC-3 events without the new fields still validate, and unknown values are rejected", () => {
  const scored = firstOf("harness.events/v1", "task.scored");
  delete scored.data.policy_fit;
  delete scored.data.recommendation;
  accepts(scored, "task.scored without policy_fit or recommendation (v1 unchanged)");
  const dispatched = firstOf("harness.events/v1", "task.dispatched");
  delete dispatched.data.model_source;
  accepts(dispatched, "task.dispatched without model_source (v1 unchanged)");

  for (const bad of ["maybe", "fit", "recommend", "", "FITS", true]) {
    scored.data.policy_fit = bad;
    rejects(scored, `policy_fit ${JSON.stringify(bad)}`);
  }
  dispatched.data.model_source = "manual";
  rejects(dispatched, "model_source manual");
});

test("PLAN-1.3/AC-4 the routing-log rubric accepts policy_fit, recommendation and model_source, and rejects bad values", () => {
  const record = firstOf("harness.routing-log/v1");
  delete record.rubric.policy_fit;
  delete record.rubric.recommendation;
  delete record.rubric.model_source;
  accepts(record, "a record without the new fields (v1 unchanged)");

  record.rubric.policy_fit = "recommended";
  record.rubric.recommendation = { ...recommendation };
  record.rubric.model_source = "override";
  accepts(record, "a record with policy_fit, recommendation and model_source");

  record.rubric.policy_fit = "fits";
  delete record.rubric.recommendation;
  record.rubric.model_source = "policy";
  accepts(record, "a record that fits, dispatched by policy");

  const bad = (mutate: (r: Line) => void, why: string): void => {
    const copy = structuredClone(record);
    mutate(copy);
    rejects(copy, why);
  };
  bad((r) => { r.rubric.policy_fit = "maybe"; }, "unknown policy_fit in the routing log");
  bad((r) => { r.rubric.model_source = "manual"; }, "unknown model_source in the routing log");
  bad((r) => { r.rubric.policy_fit = "recommended"; r.rubric.recommendation = { ...recommendation, model: "gpt-4" }; }, "unknown recommendation model in the routing log");
  bad((r) => { r.rubric.policy_fit = "recommended"; r.rubric.recommendation = { ...recommendation, reason: "" }; }, "empty recommendation reason in the routing log");
});

test("PLAN-1.3/AC-5 the docs carry examples of policy_fit, recommendation and model_source", () => {
  const all = parsedExamples();
  const events = all.filter((v) => v.schema === "harness.events/v1");
  assert.ok(
    events.some((v) => v.type === "task.scored" && v.data?.policy_fit === "recommended" && v.data?.recommendation),
    "no task.scored example with policy_fit \"recommended\" and a recommendation",
  );
  assert.ok(
    events.some((v) => v.type === "task.scored" && v.data?.policy_fit === "fits"),
    "no task.scored example with policy_fit \"fits\"",
  );
  assert.ok(
    events.some((v) => v.type === "task.dispatched" && typeof v.data?.model_source === "string"),
    "no task.dispatched example with model_source",
  );
  assert.ok(
    all.some((v) => v.schema === "harness.routing-log/v1" && v.rubric?.policy_fit && v.rubric?.model_source),
    "no routing-log example carrying policy_fit and model_source in its rubric",
  );
  // Each of these is also validated by the "example at docs/…:n is valid" tests above.
});
