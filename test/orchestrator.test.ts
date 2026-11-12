// The orchestrator's instructions show the events it emits as `harness-emit <type> --task|--plan <id> --data '<json>'`
// commands. Every complete one must be a valid v1 event once wrapped in an envelope, so the agent is never told
// to emit something the schema rejects. Elided examples (with `...`) are not JSON and are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, root, validators, type Line } from "./validators.ts";

// The orchestrator records the plan, the scores and a person's decisions; the dispatcher records the dispatches.
const files = ["agents/orchestrator.md", "agents/dispatcher.md"];
const file = files.join(" and ");

type Example = { where: string; event: Line };

/** The placeholder ids in the instructions (PLAN-n, PLAN-n.m) stand for real ones, in the command and in its data. */
const placeholders = (s: string): string => s.replace(/PLAN-n\.m\b/g, "PLAN-7.1").replace(/PLAN-n\b/g, "PLAN-7");

/** Every `harness-emit` command in the file whose --data parses, wrapped as a full v1 event of its type. */
function emitExamples(): Example[] {
  const found: Example[] = [];
  for (const source of files) {
  const text = readFileSync(join(root, source), "utf8").replace(/\r\n/g, "\n");
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
    found.push({ where: `${source}:${line} (${type})`, event });
  }
  }
  return found;
}

/** The agent types a definition's `tools: Agent(...)` line allows. */
const agentsAllowed = (source: string): string[] => {
  const tools = readFileSync(join(root, source), "utf8").match(/^tools:.*$/m)?.[0] ?? "";
  return (tools.match(/Agent\(([^)]*)\)/)?.[1] ?? "").split(",").map((a) => a.trim()).filter(Boolean);
};

test("the orchestrator's Agent list allows the dispatcher and everything the dispatcher starts", () => {
  // The main thread's list is the whole session's: a nested agent can start nothing it leaves out.
  const session = agentsAllowed("agents/orchestrator.md");
  const workers = agentsAllowed("agents/dispatcher.md");
  assert.ok(session.includes("harness:dispatcher"), "the orchestrator can't start the dispatcher");
  assert.ok(workers.length >= 5, `the dispatcher's Agent list has only ${workers.length} agents`);
  for (const worker of workers) assert.ok(session.includes(worker), `${worker} is in the dispatcher's list but not the orchestrator's, so the dispatcher can't start it`);
});

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

test("M5 criterion 4: a task re-run after a re-plan is recorded as task.redispatched with reason replan and its tier", () => {
  const replan = emitExamples().filter((e) => e.event.type === "task.redispatched" && (e.event.data as { reason?: string }).reason === "replan");
  assert.ok(replan.length > 0, "the dispatcher shows a task.redispatched replan example");
  for (const e of replan) assert.match(String((e.event.data as { tier?: string }).tier), /^T[1-4]$/, e.where);
});

test("M5 criterion 4: a task that stops a second time is the person's, and that choice comes first", () => {
  const text = readFileSync(join(root, "agents/orchestrator.md"), "utf8").replace(/\r\n/g, "\n");
  const choices = text.slice(text.indexOf("**Then read the reports and the working tree, and choose one:**"));
  const first = choices.split("\n").find((l) => l.trim().startsWith("- **"));
  assert.match(first ?? "", /stopped before/, "the first choice after a stop is the second-stop rule");
  assert.match(first ?? "", /always the person's/);
  assert.match(first ?? "", /human\.intervention/);
});

test("every agent definition says to run git as git -C, and none shows cd … && git (U1, H4)", () => {
  // `cd X && git …` is a form no permission rule can allow, so an unattended run is refused it (S17, PLAN-15).
  // The rule's own wording names it with a placeholder (`cd <dir> && git`), which this doesn't count.
  const dir = join(root, "agents");
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
    const text = readFileSync(join(dir, name), "utf8");
    assert.match(text, /`git -C <dir> …`/, `${name} doesn't say to use git -C`);
    assert.doesNotMatch(text, /\bcd\s+(?!<)\S+\s*&&\s*git\b/, `${name} shows cd … && git`);
  }
});

test("the SERIES-n.md template's Plans line is the contract pu harness series run reads (U2, H6)", () => {
  // pu reads the plan ids in run order from this one line: `- Plans: PLAN-8, PLAN-9`, nothing else on it.
  const text = readFileSync(join(root, "agents/orchestrator.md"), "utf8").replace(/\r\n/g, "\n");
  const template = text.split("## SERIES-n.md template")[1]?.split("## Unattended runs")[0] ?? "";
  assert.match(template, /^- Plans: PLAN-[a-z0-9]+(?:, PLAN-[a-z0-9]+)*$/m, "the template has no Plans line pu can read");
  assert.match(text, /\*\*At most 4 plans\.\*\*/, "the series cap (decision 4) is not in the definition");
});

test("SERIES mode's plan.created names the series and the plan's place in it, and the example is valid (U3, H7)", () => {
  // PU groups a series' runs and costs by the series that plan.created names; a plan.created without it is a plan on its own.
  const text = readFileSync(join(root, "agents/orchestrator.md"), "utf8").replace(/\r\n/g, "\n");
  const series = text.split("## Planning a series")[1]?.split("## SERIES-n.md template")[0] ?? "";
  const example = series.match(/harness-emit plan\.created --plan PLAN-n --data '([^']+)'/)?.[1];
  assert.ok(example, "the SERIES section shows no plan.created to emit");
  const data = JSON.parse(example) as Record<string, unknown>;
  assert.match(String(data.series), /^SERIES-\d+$/);
  assert.equal(typeof data.series_position, "number");
  assert.match(series, /series number first/, "the series number must be chosen before the plans are recorded");
});

test("the PROGRAMME-n.md template carries the lines and tables pu harness programme new reads (G1, H8)", () => {
  // pu reads the phase ids in run order from the Phases line, each phase's Repository, Brief and Plans lines,
  // and the contracts' hashes, then refuses a programme whose phases break the caps or whose hashes don't match.
  const text = readFileSync(join(root, "agents/orchestrator.md"), "utf8").replace(/\r\n/g, "\n");
  const template = text.split("## PROGRAMME-n.md template")[1]?.split("## Unattended runs")[0] ?? "";
  assert.match(template, /^- Phases: PHASE-\d+(?:, PHASE-\d+)*$/m, "the template has no Phases line pu can read");
  for (const line of ["Repository", "Brief", "Plans", "Takes in", "Publishes", "Ready when"]) {
    assert.match(template, new RegExp(`^- ${line}: `, "m"), `a phase has no ${line} line`);
  }
  assert.match(template, /^\| Contract \| Kind \| SHA-256 \| Published by \| Taken in by \|$/m);
  assert.match(template, /^\| Id \| Outside input \| Provided by \| Needed by \|$/m);
});

test("PROGRAMME mode decides nothing vague, tags every criterion and records no events (G1, H8)", () => {
  const text = readFileSync(join(root, "agents/orchestrator.md"), "utf8").replace(/\r\n/g, "\n");
  const programme = text.split("## Planning a programme")[1]?.split("## PROGRAMME-n.md template")[0] ?? "";
  assert.match(programme, /you record no events/);
  assert.match(programme, /Never turn a vague, unmeasurable or missing item into a criterion/);
  assert.match(programme, /\*\*Mark every criterion `\[built\]`\*\*/);
  assert.match(programme, /\*\*at most 4 plans\*\*/);
  assert.match(programme, /Plan no series and dispatch nothing/);
  assert.doesNotMatch(programme, /harness-emit /, "a programme folder has no home, so the sitting can't record events");
});

test("an unattended hand-back's human.intervention reason always starts with handback: (U3, H7)", () => {
  // PU lists hand-backs by this prefix; every other human.intervention is a decision made at the keyboard.
  const text = readFileSync(join(root, "agents/orchestrator.md"), "utf8").replace(/\r\n/g, "\n");
  const handback = text.split("## Unattended runs")[1] ?? "";
  assert.match(handback, /harness-emit human\.intervention --task PLAN-n\.m --data '\{"reason":"handback: /);
  assert.match(handback, /\*\*always starts with `handback: `\*\*/);
});

test("HANDBACK.md has the fixed Question and Options shape pu reads (H11)", () => {
  // pu harness offers the options to pick from in the terminal: it reads `## Question`, then `- (a) …` under `### Options`.
  const text = readFileSync(join(root, "agents/orchestrator.md"), "utf8").replace(/\r\n/g, "\n");
  const template = text.split("### HANDBACK.md template")[1] ?? "";
  assert.ok(template.length > 0, "the unattended section has no HANDBACK.md template");
  for (const heading of ["# HANDBACK: PLAN-n.m — ", "## What stopped", "## Evidence", "## Left behind", "## Question", "### Options"])
    assert.ok(template.includes(heading), `the template has no ${heading}`);
  assert.match(template, /^- \(a\) .+ \(recommended\)$/m);
  assert.match(template, /^- \(b\) /m);
  assert.match(template, /mark at most one `\(recommended\)`/);
  assert.match(template, /leave the `### Options` section out/);
});

test("a DECISION line is recorded as the person's, written into the plan, and dispatched; a vague one is handed back (H11)", () => {
  const text = readFileSync(join(root, "agents/orchestrator.md"), "utf8").replace(/\r\n/g, "\n");
  const decision = text.split("### A person's decision: `DECISION PLAN-n.m: …`")[1]?.split("### HANDBACK.md template")[0] ?? "";
  assert.ok(decision.length > 0, "the unattended section has no DECISION mode");
  assert.match(decision, /`DECISION PLAN-n\.m: <their decision>`/);
  assert.match(decision, /don't guess: hand back again/);
  assert.match(decision, /harness-emit human\.intervention --task PLAN-n\.m --data '\{"reason":"decided: /);
  assert.match(decision, /never starts with `handback: `/);
  assert.match(decision, /into the brief's Decisions/);
  assert.match(decision, /Test edits go to the evaluator's WRITE-TESTS/);
  assert.match(decision, /\*\*Delete `HANDBACK\.md`\*\*/);
  // The order matters: a decision is recorded and planned before anything is dispatched.
  assert.ok(decision.indexOf("**Record it") < decision.indexOf("**Write it into the plan") &&
    decision.indexOf("**Write it into the plan") < decision.indexOf("**Dispatch as planned"));
});

test("PROGRAMME mode reads a gov-os delivery bundle with the stories as the backbone (G1.5, H9)", () => {
  // pu harness programme new --bundle (P7) starts the sitting on <file>.delivery-bundle.json with STORIES.md next to
  // it, and after the sitting checks coverage: every S-id cited or under Not doing, every criterion citing a known id.
  const text = readFileSync(join(root, "agents/orchestrator.md"), "utf8").replace(/\r\n/g, "\n");
  const programme = text.split("## Planning a programme")[1]?.split("## PROGRAMME-n.md template")[0] ?? "";
  const bundle = programme.split("### From a gov-os delivery bundle")[1] ?? "";
  assert.ok(bundle.length > 0, "PROGRAMME mode has no section for a delivery bundle");
  assert.match(bundle, /\.delivery-bundle\.json/);
  assert.match(bundle, /STORIES\.md/);
  assert.match(bundle, /`- \[built\] \(S3\) /, "the criterion citation form is not shown");
  assert.match(bundle, /`- \[built\] \(A1\) /, "the citation form for an addition is not shown");
  assert.match(bundle, /## Added by the sitting/);
  assert.match(bundle, /Never invent a story/);
  assert.doesNotMatch(bundle, /harness-emit /);
});

test("the PROGRAMME-n.md template carries what the coverage check reads for a bundle (G1.5, H9)", () => {
  const text = readFileSync(join(root, "agents/orchestrator.md"), "utf8").replace(/\r\n/g, "\n");
  const template = text.split("## PROGRAMME-n.md template")[1]?.split("## Unattended runs")[0] ?? "";
  assert.match(template, /^- Bundle: /m, "the template has no Bundle line");
  assert.match(template, /^## Added by the sitting$/m);
  assert.match(template, /^\| Id \| What \| Why \| Phase \|$/m);
  assert.match(template, /^- S\d+: /m, "Not doing shows no story line");
});

test("the plugin's version is the one that brings the decision door (H11)", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(pkg.version, "0.18.0");
  assert.equal(plugin.version, "0.18.0");
});
