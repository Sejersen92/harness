// LN1 (0.20.0): what the lineage view needs from the Harness. The tests the evaluator wrote and why each failed
// first (tests.written), kept for good in the task's record; decisions with ids; criteria with ids; plan acceptance
// criteria that cite them. Brief: ~/.harness/briefs/LN1.md; decisions in PreviouslyUpcoming's LN1-LN2-PLAN.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecord, fitted } from "../src/lib/tasklog.ts";
import { MAX_RED, MAX_TESTS, normalizeTestsWritten, splitTestsWritten } from "../src/lib/tests-written.ts";
import { citationVerdict } from "../src/lib/plan.ts";
import type { Config, HarnessEvent } from "../src/lib/types.ts";
import { describe, root, validators, type Line } from "./validators.ts";
import { cleanEnv, git } from "./git.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";
const text = (path: string): string => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

const at = (ts: string, type: string, task: string | null, data: Record<string, unknown> = {}, plan = "PLAN-1"): HarnessEvent => ({
  schema: "harness.events/v1", event_id: `01M4QP0A00J3VZ9X8M2N5K${ts.slice(14, 16)}${ts.slice(17, 19)}`, ts, type,
  producer: { name: "harness", version: "0.20.0" }, repo: { name: "r", remote_sha256: "0".repeat(64) },
  mode: "observe", session_id: SESSION, config_sha256: "0".repeat(64), plan_id: plan, ...(task ? { task_id: task } : {}), data,
} as HarnessEvent);

const scores = { scores: { ambiguity: 0, blast: 0, coupling: 0, novelty: 0, reversibility: 0, verification: 0 }, total: 0, score_band: "T1", overrides: [], tier_planned: "T1" };
const done = { outcome: "pass_first_try", final_tier: "T1", eval_rounds: 1, escalations: 0 };

const ac = (i: number, task = "PLAN-1.1") => ({
  ac: `${task}/AC-${i}`, tests: [`${task}/AC-${i} the thing number ${i} behaves as the criterion says`], file: `test/feature-${i}.test.ts`,
  red: `expected the count ${i} but the function returned undefined because it isn't written yet`,
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-ln1-"));
  git(["init", "-q", dir]);
  git(["-C", dir, "remote", "add", "origin", "https://github.com/example/Sample-Repo.git"]);
  writeFileSync(join(dir, "routing.yaml"), readFileSync(join(root, "templates", "routing.yaml")));
  return dir;
}
const env = (dir: string): NodeJS.ProcessEnv => ({ ...cleanEnv(), CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: root, HARNESS_HOME: join(dir, ".harness-home") });
const emit = (dir: string, ...args: string[]) => spawnSync("node", [join(root, "bin", "harness-emit.mjs"), ...args], { cwd: dir, env: env(dir), encoding: "utf8" });
const eventLines = (dir: string): Line[] => {
  const path = join(dir, ".harness", "events");
  if (!existsSync(path)) return [];
  return readdirSync(path).flatMap((f) => readFileSync(join(path, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line));
};

// --- C1: the event and its schema ---------------------------------------------------------------------------

test("LN1 C1: tests.written is in the schema and the catalogue, with an example that validates", () => {
  const validate = validators["harness.events/v1"]!;
  const good = at("2026-11-19T10:00:00Z", "tests.written", "PLAN-1.1", { part: 1, parts: 1, acs: [ac(1), ac(2)], untestable: [{ ac: "PLAN-1.1/AC-3", how: "needs a browser: check the page by hand" }], gaps: 1 });
  assert.ok(validate(good), describe(validate));
  assert.match(text("docs/EVENTS.md"), /^\| `tests\.written` \|/m, "no catalogue row for tests.written in docs/EVENTS.md");
  assert.match(text("docs/EVENTS.md"), /"type":\s*"tests\.written"/, "no tests.written example in docs/EVENTS.md (schema.test.ts validates it)");
});

test("LN1 C1: tests.written rejects an unqualified ac, too many tests, a long red and a missing task id", () => {
  const validate = validators["harness.events/v1"]!;
  const base = (data: Record<string, unknown>, task: string | null = "PLAN-1.1") => at("2026-11-19T10:00:00Z", "tests.written", task, { part: 1, parts: 1, acs: [ac(1)], untestable: [], gaps: 0, ...data });
  assert.equal(validate(base({ acs: [{ ...ac(1), ac: "AC-1" }] })), false, "an ac that isn't an ac_id");
  assert.equal(validate(base({ acs: [{ ...ac(1), tests: Array.from({ length: 11 }, (_, i) => `t${i}`) }] })), false, "more than 10 tests");
  assert.equal(validate(base({ acs: [{ ...ac(1), tests: [] }] })), false, "no tests");
  assert.equal(validate(base({ acs: [{ ...ac(1), red: "x".repeat(161) }] })), false, "red over 160 characters");
  assert.equal(validate(base({ untestable: [{ ac: "AC-3", how: "by hand" }] })), false, "an untestable ac that isn't an ac_id");
  assert.equal(validate(base({}, null)), false, "no task_id on the envelope");
  assert.equal(validate(base({ part: 0 })), false, "parts count from 1");
  assert.ok(validate(base({ acs: [], untestable: [{ ac: "PLAN-1.1/AC-1", how: "by hand" }] })), "every criterion untestable is still a report");
});

// --- C2: lines that fit -------------------------------------------------------------------------------------

test("LN1 C2: the report is normalized to what the schema allows, never refused for it", () => {
  const long = normalizeTestsWritten({ acs: [{ ...ac(1), tests: Array.from({ length: 14 }, (_, i) => `t${i}`), red: "r".repeat(400) }], untestable: [{ ac: "PLAN-1.1/AC-2", how: "h".repeat(400) }], gaps: 2 });
  const [first] = long.acs;
  assert.equal(first?.tests.length, MAX_TESTS);
  assert.equal(MAX_TESTS, 10);
  assert.ok((first?.red ?? "").length <= MAX_RED && MAX_RED === 160, "red is cut to 160 characters");
  assert.ok((long.untestable[0]?.how ?? "").length <= MAX_RED);
  assert.equal(long.gaps, 2);
});

test("LN1 C2: a 25-criterion report is written as parts that each fit a line, losing and repeating no criterion", () => {
  const acs = Array.from({ length: 25 }, (_, i) => ac(i + 1));
  const parts = splitTestsWritten({ acs, untestable: [{ ac: "PLAN-1.1/AC-26", how: "by hand" }], gaps: 3 });
  assert.ok(parts.length > 1, "25 criteria don't fit one line");
  parts.forEach((p, i) => { assert.equal(p.part, i + 1); assert.equal(p.parts, parts.length); });
  assert.deepEqual(parts.flatMap((p) => p.acs.map((a) => a.ac)), acs.map((a) => a.ac), "every criterion once, in order");
  assert.equal(parts.filter((p) => p.untestable.length).length, 1, "untestable criteria are written once");
  assert.equal(parts.reduce((n, p) => n + p.gaps, 0), 3, "gaps are counted once");

  // Through harness-emit, as the dispatcher calls it: one call, several lines, each under 4 KB and valid.
  const dir = makeRepo();
  const run = emit(dir, "tests.written", "--task", "PLAN-1.1", "--data", JSON.stringify({ acs, untestable: [], gaps: 0 }));
  assert.equal(run.status, 0, run.stderr);
  const written = eventLines(dir).filter((e) => e.type === "tests.written");
  assert.ok(written.length > 1, `one call should write several parts, wrote ${written.length}`);
  const validate = validators["harness.events/v1"]!;
  for (const line of written) {
    assert.ok(Buffer.byteLength(JSON.stringify(line)) < 4096, "a part over 4 KB");
    assert.ok(validate(line), describe(validate));
  }
  assert.deepEqual(written.flatMap((e) => (e.data.acs as { ac: string }[]).map((a) => a.ac)), acs.map((a) => a.ac));
  assert.equal(existsSync(join(dir, ".harness", "emit-failures")), false, "nothing was refused");
});

// --- C3: the dispatcher records it ---------------------------------------------------------------------------

test("LN1 C3: the dispatcher records tests.written after WRITE-TESTS and before IMPLEMENT, and lists it as its own", () => {
  const dispatcher = text("agents/dispatcher.md");
  const steps = dispatcher.split("## For every task, in the order given")[1] ?? "";
  const record = steps.indexOf("harness-emit tests.written --task PLAN-n.m");
  assert.ok(record > 0, "the dispatcher's steps don't record tests.written");
  assert.ok(steps.indexOf("WRITE-TESTS: PLAN-n.m") < record, "recorded before the tests are written");
  assert.ok(record < steps.indexOf("IMPLEMENT: PLAN-n.m"), "recorded after the implementer starts");
  assert.match(dispatcher, /You record `task\.dispatched`, `task\.redispatched`, `tests\.written`, `security\.reviewed` and `task\.completed`, and nothing else/);
});

// --- C4–C6: the record ----------------------------------------------------------------------------------------

const config = (dir: string): Config => ({ dir, includeJustifications: false, layout: { planPath: join(dir, "PLAN.md") } }) as Config;

test("LN1 C4: the record carries the tests written, the criteria that failed first, and per-criterion detail, merging parts", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-ln1-rec-"));
  const events = [
    at("2026-11-19T10:00:00Z", "task.scored", "PLAN-1.1", scores),
    at("2026-11-19T10:01:00Z", "tests.written", "PLAN-1.1", { part: 1, parts: 2, acs: [{ ...ac(1), tests: ["a", "b"] }], untestable: [], gaps: 0 }),
    at("2026-11-19T10:01:01Z", "tests.written", "PLAN-1.1", { part: 2, parts: 2, acs: [{ ac: "PLAN-1.1/AC-2", tests: ["c"], file: "test/x.test.ts" }], untestable: [], gaps: 0 }),
    at("2026-11-19T10:02:00Z", "task.dispatched", "PLAN-1.1", { tier: "T1", isolation: "none" }),
    at("2026-11-19T10:09:00Z", "task.completed", "PLAN-1.1", done),
  ];
  const { record } = buildRecord(config(dir), "PLAN-1.1", events, []);
  assert.ok(record);
  const acceptance = record.acceptance as Record<string, unknown>;
  assert.equal(acceptance.tests_added, 3);
  assert.equal(acceptance.tests_failed_before, 1, "only AC-1 says why it failed");
  assert.deepEqual(acceptance.tests, [
    { ac: "PLAN-1.1/AC-1", count: 2, file: "test/feature-1.test.ts", red: ac(1).red },
    { ac: "PLAN-1.1/AC-2", count: 1, file: "test/x.test.ts" },
  ]);
  const validate = validators["harness.routing-log/v1"]!;
  assert.ok(validate(record), describe(validate));
});

test("LN1 C4: a task written again takes only the latest WRITE-TESTS, and only its own criteria", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-ln1-rec-"));
  const events = [
    at("2026-11-19T10:00:00Z", "task.scored", "PLAN-1.1", scores),
    at("2026-11-19T10:01:00Z", "tests.written", "PLAN-1.1", { part: 1, parts: 1, acs: [ac(1), ac(2)], untestable: [], gaps: 0 }),
    at("2026-11-19T10:05:00Z", "tests.written", "PLAN-1.1", { part: 1, parts: 1, acs: [ac(1), ac(1, "PLAN-1.2")], untestable: [], gaps: 0 }),
    at("2026-11-19T10:06:00Z", "task.dispatched", "PLAN-1.1", { tier: "T1", isolation: "none" }),
    at("2026-11-19T10:09:00Z", "task.completed", "PLAN-1.1", done),
  ];
  const { record } = buildRecord(config(dir), "PLAN-1.1", events, []);
  const tests = (record?.acceptance as { tests: { ac: string }[] }).tests;
  assert.deepEqual(tests.map((t) => t.ac), ["PLAN-1.1/AC-1"], "the re-plan's set, without another task's criterion");
});

test("LN1 C5: an over-long record drops red, then file, before anything else, and never the ids or counts", () => {
  // Long enough that dropping red alone doesn't fit, so both steps run; short enough to fit once both have.
  const tests = Array.from({ length: 25 }, (_, i) => ({ ac: `PLAN-1.1/AC-${i + 1}`, count: 2, file: `test/${"deep/".repeat(22)}feature-${i + 1}.test.ts`, red: "r".repeat(150) }));
  const record = {
    schema: "harness.routing-log/v1", task_id: "PLAN-1.1", revision: 1, plan_id: "PLAN-1",
    rubric: { scores: {}, total: 0, justifications: { blast: "kept if it fits" } },
    gate: { denials: 0, denial_reasons: [], allowed: 1 }, runs: [], eval_rounds: [],
    acceptance: { criteria: 25, tests_added: 50, tests_failed_before: 25, tests },
  };
  const trimmed = fitted(record as never);
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed)) < 4096, "it fits");
  assert.deepEqual((trimmed.trimmed as string[]).slice(0, 2), ["acceptance.tests.red", "acceptance.tests.file"]);
  const kept = (trimmed.acceptance as { tests: Record<string, unknown>[] }).tests;
  assert.equal(kept.length, 25);
  assert.deepEqual(Object.keys(kept[0] ?? {}).sort(), ["ac", "count"]);
  assert.ok(!(trimmed.trimmed as string[]).includes("rubric.justifications"), "stopped once it fit");
});

test("LN1 C6: a dispatched task without tests.written is incomplete and names it; one without a dispatch is as before", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-ln1-rec-"));
  const worked = [
    at("2026-11-19T10:00:00Z", "task.scored", "PLAN-1.1", scores),
    at("2026-11-19T10:02:00Z", "task.dispatched", "PLAN-1.1", { tier: "T1", isolation: "none" }),
    at("2026-11-19T10:09:00Z", "task.completed", "PLAN-1.1", done),
  ];
  const { record } = buildRecord(config(dir), "PLAN-1.1", worked, []);
  assert.ok(record);
  assert.equal(record.complete, false);
  assert.ok((record.missing_events as string[]).includes("tests.written"));
  assert.equal("tests" in (record.acceptance as object), false, "no tests array when none were reported");

  const byHand = [worked[0]!, at("2026-11-19T10:09:00Z", "task.completed", "PLAN-1.1", { ...done, outcome: "human" })];
  const human = buildRecord(config(dir), "PLAN-1.1", byHand, []).record;
  assert.ok(!(human?.missing_events as string[]).includes("tests.written"), "a task no one dispatched wrote no tests to report");
});

test("LN1 C6: a record written before 0.20.0 still validates", () => {
  const validate = validators["harness.routing-log/v1"]!;
  const blocks = [...text("docs/EVENTS.md").matchAll(/^```jsonl?[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1] ?? "");
  const found = blocks.flatMap((b) => [b, ...b.split("\n")]).find((piece) => /"schema":\s*"harness\.routing-log\/v1"/.test(piece) && (() => { try { JSON.parse(piece); return true; } catch { return false; } })());
  const old = found ? JSON.parse(found) as Line : null;
  assert.ok(old, "no routing-log example in docs/EVENTS.md to check");
  delete (old.acceptance as Record<string, unknown>).tests;
  assert.ok(validate(old), describe(validate));
});

// --- C7–C9: the sitting and the plans --------------------------------------------------------------------------

const orchestrator = (): string => text("agents/orchestrator.md");
const section = (from: string, to: string): string => orchestrator().split(from)[1]?.split(to)[0] ?? "";

test("LN1 C7: PROGRAMME mode writes decisions with an id, a round, what they replace and what they affect", () => {
  const template = section("## PROGRAMME-n.md template", "## Unattended runs");
  assert.match(template, /^- D<n> \(round <r>\[; replaces D<m>\]; affects <ids>\): <question>: <the answer> \(the person\)/m);
  const programme = section("## Planning a programme", "## PROGRAMME-n.md template");
  assert.match(programme, /`\(replaced by D<n>\)`/, "a replaced decision stays, marked");
  assert.match(programme, /S-, A- or C-ids/, "what a decision may affect");
});

test("LN1 C8: phase criteria are written with ids, unique within the phase", () => {
  const programme = section("## Planning a programme", "## PROGRAMME-n.md template");
  assert.match(programme, /`- \[built\] C1 /, "the id form is not shown");
  assert.match(programme, /unique within the phase/);
  assert.match(programme, /`- \[built\] C3 \(S3\) /, "a bundle criterion shows its id before its citation");
});

test("LN1 C9: SERIES mode marks a plan from a programme phase and makes every acceptance criterion cite its criterion", () => {
  const series = section("## Planning a series", "## SERIES-n.md template");
  assert.match(series, /`- From: PROG-n\/PHASE-k`/);
  assert.match(series, /`AC-1 \(C3\) /);
  assert.match(section("## PLAN.md brief template", "## PLAN.md task template"), /^- From: PROG-n\/PHASE-k/m);
});

const planFile = (dir: string, from: string | null, acs: string[]): string => {
  const path = join(dir, "PLAN.md");
  writeFileSync(path, [
    "## PLAN-5 — Lineage", "", "### Brief", "- Goal: g", ...(from ? [`- From: ${from}`] : []), "",
    "### PLAN-5.1 — One", "- Acceptance criteria:", ...acs.map((a) => `  - ${a}`), "",
    "### PLAN-5.2 — Two", "- Acceptance criteria:", "  - AC-1 (C2) two", "",
    "## PLAN-6 — Other", "", "### PLAN-6.1 — x", "- Acceptance criteria:", "  - AC-1 uncited but another plan", "",
  ].join("\n"));
  return path;
};

test("LN1 C9: citationVerdict lists a programme plan's uncited criteria, and leaves a plan on its own alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-ln1-plan-"));
  const bad = citationVerdict(planFile(dir, "PROG-6/PHASE-0", ["AC-1 (C1) cites", "AC-2 cites nothing", "AC-3 (S4) cites a story, not a criterion"]), "PLAN-5");
  assert.equal(bad.allowed, false);
  assert.deepEqual(bad.uncited, ["PLAN-5.1/AC-2", "PLAN-5.1/AC-3"]);
  assert.match(bad.detail, /PLAN-5 comes from PROG-6\/PHASE-0.*PLAN-5\.1\/AC-2, PLAN-5\.1\/AC-3/);

  assert.equal(citationVerdict(planFile(dir, "PROG-6/PHASE-0", ["AC-1 (C1) cites", "AC-2 (C1, C4) cites two"]), "PLAN-5").allowed, true);
  assert.equal(citationVerdict(planFile(dir, null, ["AC-1 cites nothing"]), "PLAN-5").allowed, true, "a plan not from a programme isn't checked");
  assert.equal(citationVerdict(join(dir, "missing.md"), "PLAN-5").allowed, true, "no PLAN.md: the intake gate speaks for that");
});

test("LN1 C9: the gate refuses an agent for a programme plan with uncited criteria, and lets it through once they cite", () => {
  const dir = makeRepo();
  const plan = planFile(dir, "PROG-6/PHASE-0", ["AC-1 cites nothing"]);
  // A settled intake, so only the citation check can refuse it.
  emit(dir, "plan.intake", "--plan", "PLAN-5", "--data", JSON.stringify({ round: 1, ambiguity: 0, max_ambiguity: 0, questions: 0, settled: true }));
  const dispatch = (): string => spawnSync("node", [join(root, "bin", "hook-pre-tool-use.mjs")], {
    cwd: dir, env: env(dir), encoding: "utf8",
    input: JSON.stringify({ session_id: SESSION, tool_name: "Agent", tool_input: { subagent_type: "harness:evaluator", prompt: "WRITE-TESTS: PLAN-5.1", description: "d" } }),
  }).stdout;
  const refused = dispatch();
  assert.match(refused, /"permissionDecision":\s*"deny"/);
  assert.match(refused, /PLAN-5\.1\/AC-1/);

  writeFileSync(plan, readFileSync(plan, "utf8").replace("AC-1 cites nothing", "AC-1 (C1) cites"));
  assert.doesNotMatch(dispatch(), /"permissionDecision":\s*"deny"/);
});

// --- C10 -------------------------------------------------------------------------------------------------------

test("LN1 C10: the plugin is 0.21.0 everywhere it says its version", () => {
  for (const file of ["package.json", ".claude-plugin/plugin.json"]) assert.equal(JSON.parse(text(file)).version, "0.21.0", file);
  assert.equal(JSON.parse(text("package-lock.json")).version, "0.21.0", "package-lock.json");
});
