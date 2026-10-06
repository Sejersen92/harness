// The contract test: every example in the docs must validate against the v1 schemas,
// and every design fix (C6-C12) must be enforced by the schema, not just written down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

// strict catches misspelt keywords; strictTypes is off because the small `is` matchers
// deliberately omit "type": "object" (the envelope already requires it).
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
addFormats(ajv);
ajv.addSchema(readJson("schema/harness.events.v1.json"));
ajv.addSchema(readJson("schema/routing-log.v1.json"));
const validators = {
  "harness.events/v1": ajv.getSchema("https://github.com/Sejersen92/harness/schema/harness.events.v1.json"),
  "harness.routing-log/v1": ajv.getSchema("https://github.com/Sejersen92/harness/schema/routing-log.v1.json"),
};

const describe = (validate) => ajv.errorsText(validate.errors, { separator: "\n  " });

/** Every fenced json/jsonl block in docs/*.md that claims one of our schemas, with where it came from. */
function docExamples() {
  const examples = [];
  for (const file of readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(root, "docs", file), "utf8").replace(/\r\n/g, "\n");
    for (const block of text.matchAll(/^```(jsonl?)[^\n]*\n([\s\S]*?)^```/gm)) {
      const fence = text.slice(0, block.index).split("\n").length;
      const [, kind, body] = block;
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
  const schemas = new Set(examples.map((e) => { try { return JSON.parse(e.piece).schema; } catch { return null; } }));
  assert.ok(examples.length >= 10, `only ${examples.length} examples found`);
  assert.ok(schemas.has("harness.events/v1"), "no event examples found");
  assert.ok(schemas.has("harness.routing-log/v1"), "no routing-log examples found");
});

for (const { where, piece } of examples) {
  test(`example at ${where} is valid`, () => {
    let value;
    assert.doesNotThrow(() => { value = JSON.parse(piece); }, `${where} is not valid JSON (no "…" placeholders in examples)`);
    const validate = validators[value.schema];
    assert.ok(validate, `${where} names an unknown schema ${value.schema}`);
    assert.ok(validate(value), `${where}:\n  ${describe(validate)}`);
  });
}

// --- Each design fix must be enforced, not only documented ---------------------------------

const firstOf = (schema, type) => {
  const found = examples.map((e) => JSON.parse(e.piece)).find((v) => v.schema === schema && (!type || v.type === type));
  assert.ok(found, `no ${type ?? schema} example in the docs to mutate`);
  return structuredClone(found);
};
const rejects = (value, why) => {
  const validate = validators[value.schema];
  assert.equal(validate(value), false, `should be rejected: ${why}`);
};
const accepts = (value, why) => {
  const validate = validators[value.schema];
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
