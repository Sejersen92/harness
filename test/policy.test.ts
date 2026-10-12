// Runs bin/harness-policy against a throwaway repository enrolled by hand in a scratch HARNESS_HOME,
// with the real template routing.yaml as its home's routing.yaml, so comments, aligned spacing and
// flow-style tiers are there to be preserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { loadConfig, repoHome } from "../src/lib/config.ts";
import { root } from "./validators.ts";
import { cleanEnv, git } from "./git.ts";

const TEMPLATE = readFileSync(join(root, "templates", "routing.yaml"), "utf8");

type Tier = { model: string; effort: string };
type Policy = { revision: unknown; mode: unknown; tiers: Record<string, unknown>; updatedBy: unknown; [key: string]: unknown };

/** The template's own values: applying this changes no byte of routing.yaml. */
const SAME_AS_TEMPLATE = (): Policy => ({
  revision: 1,
  mode: "observe",
  tiers: {
    T1: { model: "sonnet", effort: "low" },
    T2: { model: "sonnet", effort: "medium" },
    T3: { model: "sonnet", effort: "high" },
    T4: { model: "opus", effort: "medium" },
  },
  updatedBy: "work-pc",
});

/** Changes mode, T1's model, T2's effort and T4's effort; T3 stays as the template has it. */
const CHANGED = (revision = 3): Policy => ({
  revision,
  mode: "route",
  tiers: {
    T1: { model: "haiku", effort: "low" },
    T2: { model: "sonnet", effort: "high" },
    T3: { model: "sonnet", effort: "high" },
    T4: { model: "opus", effort: "xhigh" },
  },
  updatedBy: "work-pc",
});

function withHarnessHome<T>(harnessHome: string, fn: () => T): T {
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = harnessHome;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous;
  }
}

/** A repository and a scratch ~/.harness; enrolled = its home holds the template routing.yaml. */
function makeRepo({ enrolled = true }: { enrolled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-policy-repo-"));
  const harnessHome = mkdtempSync(join(tmpdir(), "harness-policy-home-"));
  git(["init", "-q", dir]);
  const home = withHarnessHome(harnessHome, () => repoHome(dir));
  if (enrolled) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "routing.yaml"), TEMPLATE);
  }
  const routingPath = join(home, "routing.yaml");
  const policyPath = join(home, "state", "policy.json");
  const env: NodeJS.ProcessEnv = { ...cleanEnv(), CLAUDE_PROJECT_DIR: dir, HARNESS_HOME: harnessHome };
  const run = (...args: string[]) => {
    const r = spawnSync("node", [join(root, "bin", "harness-policy.mjs"), ...args], { cwd: dir, env, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", line: (r.stdout ?? "").replace(/\r?\n$/, "") };
  };
  const apply = (policy: unknown) => run("apply", "--json", typeof policy === "string" ? policy : JSON.stringify(policy));
  const routing = (): string => readFileSync(routingPath, "utf8");
  const policyJson = (): Record<string, unknown> => JSON.parse(readFileSync(policyPath, "utf8")) as Record<string, unknown>;
  const sha = (): string => withHarnessHome(harnessHome, () => {
    const config = loadConfig(dir);
    assert.ok("config_sha256" in config, "the repository is enrolled");
    return config.config_sha256;
  });
  return { dir, harnessHome, home, routingPath, policyPath, run, apply, routing, policyJson, sha };
}

/** Exactly one line on stdout (AC-8), returned without its newline. */
function oneLine(r: { stdout: string; stderr: string }): string {
  const lines = r.stdout.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  assert.equal(lines.length, 1, `expected exactly one line on stdout, got ${JSON.stringify(r.stdout)} (stderr: ${r.stderr.slice(0, 300)})`);
  return lines[0];
}

const lines = (text: string): string[] => text.split("\n");
const isOwnedLine = (line: string): boolean => /^mode:/.test(line) || /^ {2}T[1-4]:/.test(line);
const tierLine = (text: string, tier: string): string => lines(text).find((l) => l.startsWith(`  ${tier}:`)) ?? "";

// ---------------------------------------------------------------- AC-1

test("PLAN-1.2/AC-1 apply sets mode and each tier's model and effort", () => {
  const r = makeRepo();
  const out = r.apply(CHANGED());
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const yaml = parse(r.routing()) as { mode: string; tiers: Record<string, Tier & { max_score: number; agent: string }> };
  assert.equal(yaml.mode, "route");
  for (const [tier, values] of Object.entries(CHANGED().tiers) as [string, Tier][]) {
    assert.equal(yaml.tiers[tier].model, values.model, `${tier}.model`);
    assert.equal(yaml.tiers[tier].effort, values.effort, `${tier}.effort`);
  }
  assert.deepEqual(Object.keys(yaml.tiers), ["T1", "T2", "T3", "T4"]);
});

test("PLAN-1.2/AC-1 every line without an owned key is unchanged byte for byte", () => {
  const r = makeRepo();
  assert.equal(r.apply(CHANGED()).status, 0);
  const before = lines(TEMPLATE);
  const after = lines(r.routing());
  assert.equal(after.length, before.length, "no line added or removed");
  before.forEach((line, i) => {
    if (!isOwnedLine(line)) assert.equal(after[i], line, `line ${i + 1} changed`);
  });
  assert.ok(r.routing().endsWith("\n") === TEMPLATE.endsWith("\n"), "the trailing newline is kept");
});

test("PLAN-1.2/AC-1 the mode line keeps its comment", () => {
  const r = makeRepo();
  assert.equal(r.apply(CHANGED()).status, 0);
  const comment = "# off | observe | route   (observe = the baseline: scored, not routed)";
  const modeLine = lines(r.routing()).find((l) => l.startsWith("mode:")) ?? "";
  assert.match(modeLine, /^mode: route\s+#/);
  assert.ok(modeLine.endsWith(comment), `the comment survives: ${JSON.stringify(modeLine)}`);
});

test("PLAN-1.2/AC-1 tier lines stay flow-style, non-owned parts and unchanged values keep their spacing", () => {
  const r = makeRepo();
  assert.equal(r.apply(CHANGED()).status, 0);
  const text = r.routing();
  assert.match(tierLine(text, "T1"), /^ {2}T1: \{ max_score: 2, {2}agent: impl-t1, model: haiku, +effort: low \}$/);
  assert.equal(tierLine(text, "T2"), "  T2: { max_score: 6,  agent: impl-t2, model: sonnet, effort: high }");
  assert.equal(tierLine(text, "T3"), tierLine(TEMPLATE, "T3"), "an untouched tier line is byte-identical");
  assert.equal(tierLine(text, "T4"), "  T4: { max_score: 12, agent: impl-t4, model: opus,   effort: xhigh }");
});

test("PLAN-1.2/AC-1 version, max_score, agent, eval, gate, intake, commits and metadata are unchanged", () => {
  const r = makeRepo();
  assert.equal(r.apply(CHANGED()).status, 0);
  const before = parse(TEMPLATE) as Record<string, unknown> & { tiers: Record<string, Record<string, unknown>> };
  const after = parse(r.routing()) as Record<string, unknown> & { tiers: Record<string, Record<string, unknown>> };
  for (const key of ["version", "eval", "gate", "intake", "commits", "metadata"]) assert.deepEqual(after[key], before[key], key);
  for (const tier of ["T1", "T2", "T3", "T4"]) {
    assert.equal(after.tiers[tier].max_score, before.tiers[tier].max_score, `${tier}.max_score`);
    assert.equal(after.tiers[tier].agent, before.tiers[tier].agent, `${tier}.agent`);
  }
  assert.deepEqual(Object.keys(after), Object.keys(before), "no top-level key added, removed or reordered");
});

// ---------------------------------------------------------------- AC-2

test("PLAN-1.2/AC-2 apply writes state/policy.json with revision, mode, tiers, updatedBy and a UTC appliedAt", () => {
  const r = makeRepo();
  const start = Date.now();
  assert.equal(r.apply(CHANGED(7)).status, 0);
  const end = Date.now();
  assert.ok(existsSync(r.policyPath), "state/policy.json is written in the home");
  const state = r.policyJson();
  assert.deepEqual(Object.keys(state).sort(), ["appliedAt", "mode", "revision", "tiers", "updatedBy"]);
  assert.equal(state.revision, 7);
  assert.equal(state.mode, "route");
  assert.deepEqual(state.tiers, CHANGED().tiers);
  assert.equal(state.updatedBy, "work-pc");
  assert.match(String(state.appliedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "UTC ISO");
  const at = Date.parse(String(state.appliedAt));
  assert.ok(at >= start - 1000 && at <= end + 1000, "appliedAt is the time of the apply");
});

test("PLAN-1.2/AC-2 neither the revision, who set it nor any time is written into routing.yaml", () => {
  const r = makeRepo();
  assert.equal(r.apply({ ...CHANGED(7), updatedBy: "unique-device-name" }).status, 0);
  const text = r.routing();
  assert.doesNotMatch(text, /revision/i);
  assert.doesNotMatch(text, /appliedAt|applied_at/i);
  assert.doesNotMatch(text, /unique-device-name/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no timestamp");
  assert.deepEqual(Object.keys(parse(text) as object), Object.keys(parse(TEMPLATE) as object));
});

test("PLAN-1.2/AC-2 policy.json is not written when routing.yaml can't be", () => {
  const r = makeRepo();
  // routing.yaml read-only (Windows refuses writes and renames onto it) and, on POSIX, the home
  // read-only too, so no write or rename can replace it; state/ itself stays writable.
  mkdirSync(join(r.home, "state"), { recursive: true });
  chmodSync(r.routingPath, 0o444);
  if (process.platform !== "win32") chmodSync(r.home, 0o555);
  try {
    r.apply(CHANGED());
  } finally {
    if (process.platform !== "win32") chmodSync(r.home, 0o755);
    chmodSync(r.routingPath, 0o644);
  }
  assert.equal(r.routing(), TEMPLATE, "routing.yaml could not be written");
  assert.ok(!existsSync(r.policyPath), "policy.json is written only after routing.yaml");
  // The control: once routing.yaml is writable again, the same apply writes both.
  const out = r.apply(CHANGED());
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal((parse(r.routing()) as { mode: string }).mode, "route");
  assert.ok(existsSync(r.policyPath));
});

// ---------------------------------------------------------------- AC-3

test("PLAN-1.2/AC-3 applying the same policy twice: identical bytes and config_sha256, applied then unchanged", () => {
  const r = makeRepo();
  const first = r.apply(CHANGED());
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(oneLine(first), /^applied\b/);
  const bytes = r.routing();
  const sha = r.sha();
  const second = r.apply(CHANGED());
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(oneLine(second), /^unchanged\b/);
  assert.equal(r.routing(), bytes, "routing.yaml's bytes are identical");
  assert.equal(r.sha(), sha, "config_sha256 is identical");
});

test("PLAN-1.2/AC-3 a first apply whose values match routing.yaml is applied, and leaves its bytes alone", () => {
  const r = makeRepo();
  const sha = r.sha();
  const first = r.apply(SAME_AS_TEMPLATE());
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(oneLine(first), /^applied\b/, "policy.json did not hold this revision yet");
  assert.equal(r.routing(), TEMPLATE);
  assert.equal(r.sha(), sha);
  assert.match(oneLine(r.apply(SAME_AS_TEMPLATE())), /^unchanged\b/);
});

test("PLAN-1.2/AC-3 a new revision with the same values is applied, not unchanged", () => {
  const r = makeRepo();
  assert.equal(r.apply(CHANGED(3)).status, 0);
  const bytes = r.routing();
  const out = r.apply(CHANGED(4));
  assert.equal(out.status, 0);
  assert.match(oneLine(out), /^applied\b/);
  assert.equal(r.routing(), bytes);
  assert.equal(r.policyJson().revision, 4);
});

// ---------------------------------------------------------------- AC-4

test("PLAN-1.2/AC-4 a hand edit to a tier's model is replaced and reported with the revision", () => {
  const r = makeRepo();
  assert.equal(r.apply(CHANGED(4)).status, 0);
  const applied = r.routing();
  writeFileSync(r.routingPath, applied.replace(tierLine(applied, "T3"), tierLine(applied, "T3").replace("model: sonnet", "model: opus")));
  assert.notEqual(r.routing(), applied, "the fixture hand-edited T3");
  const out = r.apply(CHANGED(4));
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const line = oneLine(out);
  assert.match(line, /^hand edit replaced/);
  assert.match(line, /\b4\b/, "it names the revision");
  assert.equal(r.routing(), applied, "the owned key is back to the policy's value");
});

test("PLAN-1.2/AC-4 a hand edit to mode is replaced and reported", () => {
  const r = makeRepo();
  assert.equal(r.apply(CHANGED(4)).status, 0);
  const applied = r.routing();
  writeFileSync(r.routingPath, applied.replace(/^mode: route/m, "mode: observe"));
  const out = r.apply(CHANGED(4));
  assert.equal(out.status, 0);
  assert.match(oneLine(out), /^hand edit replaced/);
  assert.equal((parse(r.routing()) as { mode: string }).mode, "route");
});

test("PLAN-1.2/AC-4 a hand edit to an effort is reported even when the new revision changes values too", () => {
  const r = makeRepo();
  assert.equal(r.apply(CHANGED(4)).status, 0);
  const applied = r.routing();
  writeFileSync(r.routingPath, applied.replace(tierLine(applied, "T1"), tierLine(applied, "T1").replace("effort: low", "effort: max")));
  const next = CHANGED(5);
  (next.tiers.T2 as Tier).model = "opus";
  const out = r.apply(next);
  assert.equal(out.status, 0);
  const line = oneLine(out);
  assert.match(line, /^hand edit replaced/, "a hand edit takes precedence over applied");
  assert.match(line, /\b[45]\b/, "it names a revision");
  const yaml = parse(r.routing()) as { tiers: Record<string, Tier> };
  assert.equal(yaml.tiers.T1.effort, "low");
  assert.equal(yaml.tiers.T2.model, "opus");
  assert.equal(r.policyJson().revision, 5);
});

test("PLAN-1.2/AC-4 with no policy.json yet, a difference is applied, not a hand edit", () => {
  const r = makeRepo();
  writeFileSync(r.routingPath, TEMPLATE.replace(tierLine(TEMPLATE, "T2"), tierLine(TEMPLATE, "T2").replace("model: sonnet", "model: opus")));
  const out = r.apply(SAME_AS_TEMPLATE());
  assert.equal(out.status, 0);
  assert.match(oneLine(out), /^applied\b/);
  assert.equal(r.routing(), TEMPLATE);
});

test("PLAN-1.2/AC-4 a change to a non-owned key is not a hand edit", () => {
  const r = makeRepo();
  assert.equal(r.apply(CHANGED(4)).status, 0);
  const edited = r.routing().replace("marker_ttl_minutes: 30", "marker_ttl_minutes: 45");
  writeFileSync(r.routingPath, edited);
  const out = r.apply(CHANGED(4));
  assert.equal(out.status, 0);
  assert.match(oneLine(out), /^unchanged\b/);
  assert.equal(r.routing(), edited, "the non-owned edit is kept");
});

// ---------------------------------------------------------------- AC-5

/** Applies a good policy first, so policy.json exists, then checks the refusal leaves both files alone. */
function assertRefused(args: string[] | ((p: Policy) => unknown)) {
  const r = makeRepo();
  assert.equal(r.apply(CHANGED(2)).status, 0, "the setup policy applies");
  const routingBefore = readFileSync(r.routingPath);
  const policyBefore = readFileSync(r.policyPath);
  const out = Array.isArray(args) ? r.run(...args) : r.apply(args(CHANGED(3)));
  assert.match(oneLine(out), /^refused: \S/);
  assert.equal(out.status, 1);
  assert.deepEqual(readFileSync(r.routingPath), routingBefore, "routing.yaml untouched");
  assert.deepEqual(readFileSync(r.policyPath), policyBefore, "policy.json untouched");
}

test("PLAN-1.2/AC-5 refuses mode off", () => assertRefused((p) => ({ ...p, mode: "off" })));
test("PLAN-1.2/AC-5 refuses an unknown mode", () => assertRefused((p) => ({ ...p, mode: "fast" })));
test("PLAN-1.2/AC-5 refuses a missing mode", () => assertRefused(({ mode: _mode, ...p }) => p));
test("PLAN-1.2/AC-5 refuses an unknown model", () => assertRefused((p) => ({ ...p, tiers: { ...p.tiers, T2: { model: "gpt-5", effort: "medium" } } })));
test("PLAN-1.2/AC-5 refuses an unknown effort", () => assertRefused((p) => ({ ...p, tiers: { ...p.tiers, T2: { model: "sonnet", effort: "extreme" } } })));
test("PLAN-1.2/AC-5 refuses a tier missing its model", () => assertRefused((p) => ({ ...p, tiers: { ...p.tiers, T2: { effort: "medium" } } })));
test("PLAN-1.2/AC-5 refuses a missing tier", () => assertRefused((p) => {
  const { T3: _t3, ...tiers } = p.tiers;
  return { ...p, tiers };
}));
test("PLAN-1.2/AC-5 refuses an extra tier T5", () => assertRefused((p) => ({ ...p, tiers: { ...p.tiers, T5: { model: "opus", effort: "max" } } })));
test("PLAN-1.2/AC-5 refuses an extra key at top level", () => assertRefused((p) => ({ ...p, max_score: 3 })));
test("PLAN-1.2/AC-5 refuses an extra key in a tier", () => assertRefused((p) => ({ ...p, tiers: { ...p.tiers, T1: { model: "haiku", effort: "low", max_score: 3 } } })));
test("PLAN-1.2/AC-5 refuses a missing revision", () => assertRefused(({ revision: _revision, ...p }) => p));
test("PLAN-1.2/AC-5 refuses a non-integer revision", () => assertRefused((p) => ({ ...p, revision: 2.5 })));
test("PLAN-1.2/AC-5 refuses a string revision", () => assertRefused((p) => ({ ...p, revision: "3" })));
test("PLAN-1.2/AC-5 refuses revision 0", () => assertRefused((p) => ({ ...p, revision: 0 })));
test("PLAN-1.2/AC-5 refuses a negative revision", () => assertRefused((p) => ({ ...p, revision: -1 })));
test("PLAN-1.2/AC-5 refuses a missing updatedBy", () => assertRefused(({ updatedBy: _updatedBy, ...p }) => p));
test("PLAN-1.2/AC-5 refuses an empty updatedBy", () => assertRefused((p) => ({ ...p, updatedBy: "" })));
test("PLAN-1.2/AC-5 refuses updatedBy with a line break", () => assertRefused((p) => ({ ...p, updatedBy: "a\nb" })));
test("PLAN-1.2/AC-5 refuses updatedBy with a carriage return", () => assertRefused((p) => ({ ...p, updatedBy: "a\rb" })));
test("PLAN-1.2/AC-5 refuses updatedBy with a tab", () => assertRefused((p) => ({ ...p, updatedBy: "a\tb" })));
test("PLAN-1.2/AC-5 refuses updatedBy with a NUL character", () => assertRefused((p) => ({ ...p, updatedBy: "a\u0000b" })));
test("PLAN-1.2/AC-5 refuses updatedBy with a DEL character", () => assertRefused((p) => ({ ...p, updatedBy: "a\u007fb" })));
test("PLAN-1.2/AC-5 refuses invalid JSON", () => assertRefused(() => '{"revision": 3, "mode": "route",'));
test("PLAN-1.2/AC-5 refuses JSON that is not an object", () => assertRefused(() => "[1, 2, 3]"));
test("PLAN-1.2/AC-5 refuses apply with no --json", () => assertRefused(["apply"]));
test("PLAN-1.2/AC-5 refuses --json with no value", () => assertRefused(["apply", "--json"]));

test("PLAN-1.2/AC-5 a refusal before any policy was applied writes no policy.json", () => {
  const r = makeRepo();
  const out = r.apply({ ...CHANGED(), mode: "off" });
  assert.match(oneLine(out), /^refused: \S/);
  assert.equal(out.status, 1);
  assert.equal(r.routing(), TEMPLATE);
  assert.ok(!existsSync(r.policyPath));
});

// ---------------------------------------------------------------- AC-6

test("PLAN-1.2/AC-6 accepts each mode observe and route", () => {
  const r = makeRepo();
  for (const [i, mode] of ["route", "observe"].entries()) {
    const out = r.apply({ ...CHANGED(10 + i), mode });
    assert.equal(out.status, 0, `${mode}: ${out.stdout}`);
    assert.doesNotMatch(out.stdout, /^refused/);
    assert.equal((parse(r.routing()) as { mode: string }).mode, mode);
  }
});

test("PLAN-1.2/AC-6 accepts each model haiku, sonnet and opus", () => {
  const r = makeRepo();
  for (const [i, model] of ["haiku", "sonnet", "opus"].entries()) {
    const p = CHANGED(10 + i);
    p.tiers.T2 = { model, effort: "medium" };
    const out = r.apply(p);
    assert.equal(out.status, 0, `${model}: ${out.stdout}`);
    assert.equal((parse(r.routing()) as { tiers: Record<string, Tier> }).tiers.T2.model, model);
  }
});

test("PLAN-1.2/AC-6 accepts each effort low, medium, high, xhigh and max", () => {
  const r = makeRepo();
  for (const [i, effort] of ["low", "medium", "high", "xhigh", "max"].entries()) {
    const p = CHANGED(10 + i);
    p.tiers.T3 = { model: "sonnet", effort };
    const out = r.apply(p);
    assert.equal(out.status, 0, `${effort}: ${out.stdout}`);
    assert.equal((parse(r.routing()) as { tiers: Record<string, Tier> }).tiers.T3.effort, effort);
  }
});

for (const [what, bad] of [
  ["mode Route (case)", (p: Policy) => ({ ...p, mode: "Route" })],
  ["model Opus (case)", (p: Policy) => ({ ...p, tiers: { ...p.tiers, T1: { model: "Opus", effort: "low" } } })],
  ["a full model id", (p: Policy) => ({ ...p, tiers: { ...p.tiers, T1: { model: "claude-opus-5-5", effort: "low" } } })],
  ["effort minimal", (p: Policy) => ({ ...p, tiers: { ...p.tiers, T1: { model: "haiku", effort: "minimal" } } })],
  ["effort Max (case)", (p: Policy) => ({ ...p, tiers: { ...p.tiers, T1: { model: "haiku", effort: "Max" } } })],
] as const) {
  test(`PLAN-1.2/AC-6 refuses ${what}: the enums are exact`, () => assertRefused(bad));
}

// ---------------------------------------------------------------- AC-7

test("PLAN-1.2/AC-7 show with no policy applied", () => {
  const r = makeRepo();
  const out = r.run("show");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(oneLine(out), "none · no policy applied here");
});

test("PLAN-1.2/AC-7 show prints the applied policy from policy.json", () => {
  const r = makeRepo();
  assert.equal(r.apply(CHANGED(3)).status, 0);
  const appliedAt = String(r.policyJson().appliedAt);
  const out = r.run("show");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(oneLine(out), `rev 3 · route · T1 haiku/low · T2 sonnet/high · T3 sonnet/high · T4 opus/xhigh (set by work-pc, ${appliedAt})`);
});

test("PLAN-1.2/AC-7 show reads policy.json, not routing.yaml", () => {
  const r = makeRepo();
  assert.equal(r.apply(CHANGED(3)).status, 0);
  const appliedAt = String(r.policyJson().appliedAt);
  writeFileSync(r.routingPath, r.routing().replace(/^mode: route/m, "mode: observe"));
  assert.equal(oneLine(r.run("show")), `rev 3 · route · T1 haiku/low · T2 sonnet/high · T3 sonnet/high · T4 opus/xhigh (set by work-pc, ${appliedAt})`);
});

// ---------------------------------------------------------------- AC-8

test("PLAN-1.2/AC-8 every outcome prints exactly one line", () => {
  const r = makeRepo();
  assert.match(oneLine(r.run("show")), /^none/);
  assert.match(oneLine(r.apply(CHANGED(4))), /^applied\b/);
  assert.match(oneLine(r.apply(CHANGED(4))), /^unchanged\b/);
  writeFileSync(r.routingPath, r.routing().replace(/^mode: route/m, "mode: observe"));
  assert.match(oneLine(r.apply(CHANGED(4))), /^hand edit replaced/);
  assert.match(oneLine(r.apply({ ...CHANGED(5), mode: "off" })), /^refused: /);
  assert.match(oneLine(r.run("show")), /^rev 4 · /);
});

test("PLAN-1.2/AC-8 apply in a repository that is not enrolled is refused: not enrolled", () => {
  const r = makeRepo({ enrolled: false });
  const out = r.apply(CHANGED());
  assert.match(oneLine(out), /^refused: not enrolled/);
  assert.equal(out.status, 1);
  assert.ok(!existsSync(r.routingPath), "no routing.yaml is created");
  assert.ok(!existsSync(r.policyPath), "no policy.json is created");
});

/** show over a policy.json edited by hand: exit 0, one line, no control character, still starts with `rev N · `. */
function assertShowOneLine(edit: (policy: Record<string, unknown>) => Record<string, unknown>) {
  const r = makeRepo();
  assert.equal(r.apply(CHANGED(3)).status, 0, "the setup policy applies");
  writeFileSync(r.policyPath, JSON.stringify(edit(r.policyJson()), null, 2));
  const out = r.run("show");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const line = oneLine(out);
  assert.match(line, /^rev 3 · /);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(line, /[\u0000-\u001f\u007f]/, `no control character in the line: ${JSON.stringify(line)}`);
}

test("PLAN-1.2/AC-8 show prints one line when policy.json holds a line break in updatedBy", () =>
  assertShowOneLine((p) => ({ ...p, updatedBy: "a\nb" })));
test("PLAN-1.2/AC-8 show prints one line when policy.json holds a carriage return in updatedBy", () =>
  assertShowOneLine((p) => ({ ...p, updatedBy: "a\rb" })));
test("PLAN-1.2/AC-8 show prints one line when policy.json holds a line break in appliedAt", () =>
  assertShowOneLine((p) => ({ ...p, appliedAt: "2026-10-12\n12:00" })));
