// PreToolUse for Bash, Edit, Write, MultiEdit, NotebookEdit and Agent: the Harness's policies, in one process
// rather than one per policy, because this runs on every Bash call and Node's start-up is most of
// its cost.
//
// - commit-gate: a Bash command that commits is denied unless harness-eval passed for exactly what is
//   staged (lib/gate.ts). Every decision is recorded as gate.decision.
// - marker-guard: nothing but harness-eval may write the pass marker. A tool call may read it, nothing more.
// - push-guard: a push of the session's own feature branch only, never forced and never to main or the
//   default branch (lib/push.ts, U1).
// - protect-tests: an implementer (harness:impl-t*) may not edit a test file.
// - tests-only: the evaluator (harness:evaluator) may edit nothing but test files.
//   Both read routing.yaml's eval.tests globs. They cover the edit tools; a test file rewritten
//   through Bash is outside what a hook can see reliably, and the evaluator's review is the backstop.
// - intake-gate: no Harness agent (harness:*) is dispatched for a plan until the plan's brief has passed
//   intake (lib/intake.ts, H4).
//
// A deny is a JSON permissionDecision, never exit 1, which Claude Code treats as a non-blocking error
// and lets the call through (S8). Anything this script can't decide, it allows: an unreadable input
// or a broken repository is not a reason to stop all work, and the git pre-commit hook still stands.
import { join } from "node:path";
import { loadConfig, pluginRoot } from "../lib/config.ts";
import { checkMarker, isCommit, isMarkerPath, isTestPath, writesMarker } from "../lib/gate.ts";
import { intakeVerdict, plansIn } from "../lib/intake.ts";
import { pushRefusal } from "../lib/push.ts";
import { emitEvent, readEvents } from "../lib/spool.ts";
import { messageOf } from "../lib/types.ts";
import { readHookInput } from "./input.ts";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// The subagent tool's name now, and the one it had before.
const AGENT_TOOLS = new Set(["Agent", "Task"]);

const deny = (reason: string): never => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }));
  return process.exit(0);
};

const input = await readHookInput();
const tool = input.tool_name ?? "";
const args = input.tool_input ?? {};
const command = tool === "Bash" ? String(args.command ?? "") : "";

// The cheap questions first: most calls are neither a commit nor about the marker, and they leave
// before routing.yaml is read.
const touchesMarker = tool === "Bash" ? writesMarker(command) : isMarkerPath(args.file_path ?? args.notebook_path);
const commits = tool === "Bash" && isCommit(command);
const pushes = tool === "Bash" && /\bpush\b/.test(command);
const agent = String(input.agent_type ?? "");
const role = agent.startsWith("harness:impl-t") ? "implementer" : agent === "harness:evaluator" ? "evaluator" : null;
const edited = EDIT_TOOLS.has(tool) ? (args.file_path ?? args.notebook_path) : null;
const policedEdit = Boolean(role && edited);
const dispatched = AGENT_TOOLS.has(tool) ? String(args.subagent_type ?? "") : "";
const harnessDispatch = dispatched.startsWith("harness:");
if (!touchesMarker && !commits && !pushes && !policedEdit && !harnessDispatch) process.exit(0);

const config = loadConfig();
if (config.mode === "off") process.exit(0);

if (touchesMarker) {
  deny("harness: the eval pass marker (eval-pass.json) is written only by harness-eval. Reading it is fine; run harness-eval instead of writing it.");
}

if (pushes) {
  const refusal = pushRefusal(command, input.cwd ?? config.dir);
  if (refusal) deny(`harness: push refused: ${refusal}. A Harness session pushes its own feature branch only, never forced and never to main or the default branch.`);
  if (!commits) process.exit(0);
}

if (harnessDispatch) {
  const plans = plansIn(args.prompt);
  if (!plans.length) deny(`harness: a ${dispatched} dispatch must start with its header line naming the task or the plan (WRITE-TESTS:, IMPLEMENT: or EVALUATE: PLAN-n.m, or DISPATCH: PLAN-n), so the intake gate can tell which plan it is for.`);
  const events = readEvents(config);
  for (const plan of plans) {
    const verdict = intakeVerdict(plan, config.intakeMaxAmbiguity, events);
    if (!verdict.allowed) deny(`harness: intake gate: ${verdict.detail}.`);
  }
  process.exit(0);
}

if (policedEdit) {
  const test = isTestPath(edited, config.dir, config.testGlobs);
  if (role === "implementer" && test) {
    deny(`harness: implementers don't change tests (${edited} is a test by routing.yaml's eval.tests). If a test is wrong, say so in an ESCALATE report.`);
  }
  if (role === "evaluator" && !test) {
    deny(`harness: the evaluator writes tests only, and ${edited} is not one by routing.yaml's eval.tests. Report what the code needs in FAIL instead.`);
  }
  process.exit(0);
}

let verdict: ReturnType<typeof checkMarker>;
try {
  verdict = checkMarker(config.dir, config.layout.markerPath, config.markerTtlMinutes);
} catch (error) {
  process.stderr.write(`harness: commit gate could not check the marker (${messageOf(error)}); the git pre-commit hook decides\n`);
  process.exit(0);
}

emitEvent(config, "gate.decision", { session_id: input.session_id, prompt_id: input.prompt_id, agent_id: input.agent_id, agent_type: input.agent_type },
  { decision: verdict.decision, reason: verdict.reason });

if (verdict.decision === "deny") {
  const evalPath = join(pluginRoot() ?? "", "bin", "harness-eval.mjs").replace(/\\/g, "/");
  deny(`harness: commit denied (${verdict.reason}): ${verdict.detail}. Stage exactly what you mean to commit, run node "${evalPath}" --task PLAN-n.m, and commit once it passes.`);
}
process.exit(0);
