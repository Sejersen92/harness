// Each Harness agent gets the skills its role needs (the roster, 2026-10-17): the subagents through Claude Code's
// own `skills:` preload, the main-thread orchestrator through the SessionStart hook. These check that every
// declared skill exists and is pinned, that the orchestrator's fit the hook's slots whole, and that the hook
// injects them for the orchestrator only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { declaredSkills, pack, SLOT_BUDGET, SLOTS, slotContext } from "../src/lib/skills.ts";
import { root } from "./validators.ts";

const agents = readdirSync(join(root, "agents")).filter((f) => f.endsWith(".md"));
const definition = (agent: string): string => readFileSync(join(root, "agents", `${agent}.md`), "utf8");
const skillsOf = (agent: string): string[] => declaredSkills(definition(agent));

/** The cut Claude Code applies to one hook's additionalContext (probed 2026-10-17). */
const HOOK_CONTEXT_LIMIT = 10_000;

test("each agent preloads the skills its role needs, and the dispatcher none", () => {
  assert.deepEqual(skillsOf("orchestrator"), [
    "harness:complexity-rubric", "harness:the-clarity-contract", "harness:the-assumption-tax", "harness:the-same-room",
    "harness:rigid-mobility", "harness:the-tunnel", "harness:definition-of-ready", "harness:boundaries-and-dependencies",
    "harness:plan-honestly",
  ]);
  assert.deepEqual(skillsOf("dispatcher"), [], "the dispatcher runs PLAN.md by fixed rules; principles would invite it to interpret");
  for (const tier of ["impl-t1", "impl-t2"]) assert.deepEqual(skillsOf(tier), ["harness:gfa-precepts"], tier);
  for (const tier of ["impl-t3", "impl-t4"]) assert.deepEqual(skillsOf(tier), ["harness:gfa-precepts", "harness:gfa-blueprint"], tier);
  assert.deepEqual(skillsOf("evaluator"), ["harness:definition-of-done", "harness:audit-exhaust", "harness:the-same-room", "harness:gfa-precepts"]);
});

test("no agent can call the Skill tool, so two runs of one brief start from the same standards", () => {
  for (const agent of agents) {
    const tools = readFileSync(join(root, "agents", agent), "utf8").match(/^tools:.*$/m)?.[0] ?? "";
    assert.ok(tools, `${agent} has no tools line, so it would get every tool, Skill included`);
    assert.doesNotMatch(tools, /\bSkill\b/, agent);
  }
});

test("every declared skill is one of this plugin's", () => {
  for (const agent of agents) {
    const { missing, overflow } = pack(root, readFileSync(join(root, "agents", agent), "utf8"));
    assert.deepEqual(missing, [], `${agent} declares skills the plugin doesn't have`);
    assert.deepEqual(overflow, [], `${agent} has skills too large to inject`);
  }
});

test("skills/SOURCES.json pins every skill as it is, so the version pins the text (C16)", () => {
  const sources = JSON.parse(readFileSync(join(root, "skills", "SOURCES.json"), "utf8")) as {
    governanceos: { commit: string };
    skills: Record<string, { source: string; sha256: string }>;
  };
  assert.match(sources.governanceos.commit, /^[0-9a-f]{40}$/);
  const onDisk = readdirSync(join(root, "skills")).filter((n) => existsSync(join(root, "skills", n, "SKILL.md"))).sort();
  assert.deepEqual(Object.keys(sources.skills).sort(), onDisk);
  for (const name of onDisk) {
    const sha = createHash("sha256").update(readFileSync(join(root, "skills", name, "SKILL.md"))).digest("hex");
    assert.equal(sha, sources.skills[name]?.sha256, `skills/${name}/SKILL.md changed since it was generated: edit skills-src/ and run npm run skills`);
  }
});

test("the orchestrator's skills fit the hook's slots whole, each part under the per-hook cut", () => {
  const { parts } = pack(root, definition("orchestrator"));
  assert.ok(parts.length <= SLOTS, `${parts.length} parts for ${SLOTS} slots`);
  for (let slot = 1; slot <= parts.length; slot++) {
    const context = slotContext(root, "harness:orchestrator", slot) ?? "";
    assert.ok(context.length < HOOK_CONTEXT_LIMIT, `part ${slot} is ${context.length} characters`);
  }
  assert.ok(SLOT_BUDGET < HOOK_CONTEXT_LIMIT);
});

test("hooks.json registers one session-skills hook per slot", () => {
  const hooks = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as {
    hooks: { SessionStart: { hooks: { args: string[] }[] }[] };
  };
  const slots = hooks.hooks.SessionStart.flatMap((g) => g.hooks).filter((h) => h.args[0]?.endsWith("hook-session-skills.mjs")).map((h) => h.args[1]);
  assert.deepEqual(slots, Array.from({ length: SLOTS }, (_, i) => String(i + 1)));
});

const runHook = (input: object, slot: number): string =>
  spawnSync("node", [join(root, "bin", "hook-session-skills.mjs"), String(slot)], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
    input: JSON.stringify(input),
    encoding: "utf8",
  }).stdout;

test("the hook injects every orchestrator skill across its slots, once each", () => {
  const injected = Array.from({ length: SLOTS }, (_, i) => runHook({ agent_type: "harness:orchestrator", source: "startup" }, i + 1))
    .filter(Boolean)
    .map((out) => (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext)
    .join("\n");
  const named = [...injected.matchAll(/^## Skill: (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(named, skillsOf("orchestrator"));
  assert.doesNotMatch(injected, /<!-- Generated/);
});

test("the hook is silent for anything but a Harness agent with skills", () => {
  assert.equal(runHook({ source: "startup" }, 1), "", "a plain session");
  assert.equal(runHook({ agent_type: "harness:dispatcher" }, 1), "", "the dispatcher declares none");
  assert.equal(runHook({ agent_type: "other:orchestrator" }, 1), "", "another plugin's agent");
  assert.equal(runHook({ agent_type: "harness:orchestrator" }, SLOTS), "", "a slot past the last part");
});
