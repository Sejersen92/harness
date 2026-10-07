// PreToolUse for Bash, Edit, Write, MultiEdit and NotebookEdit: the Harness's policies, in one process
// rather than one per policy, because this runs on every Bash call and Node's start-up is most of
// its cost.
//
// - commit-gate: a Bash command that commits is denied unless harness-eval passed for exactly what is
//   staged (lib/gate.mjs). Every decision is recorded as gate.decision.
// - marker-guard: nothing but harness-eval may write the pass marker, so no tool call may touch it.
//
// A deny is a JSON permissionDecision, never exit 1, which Claude Code treats as a non-blocking error
// and lets the call through (S8). Anything this script can't decide, it allows: an unreadable input
// or a broken repository is not a reason to stop all work, and the git pre-commit hook still stands.
import { join } from "node:path";
import { loadConfig, pluginRoot } from "../lib/config.mjs";
import { checkMarker, isCommit, isMarkerPath } from "../lib/gate.mjs";
import { emitEvent } from "../lib/spool.mjs";
import { readHookInput } from "./input.mjs";

const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }));
  process.exit(0);
};

const input = await readHookInput();
const tool = input.tool_name;
const args = input.tool_input ?? {};
const command = tool === "Bash" ? String(args.command ?? "") : "";

// The cheap questions first: most calls are neither a commit nor about the marker, and they leave
// before routing.yaml is read.
const touchesMarker = tool === "Bash"
  ? /eval-pass\.json/i.test(command) && !/harness-eval(\.mjs)?\b/.test(command)
  : isMarkerPath(args.file_path ?? args.notebook_path);
const commits = tool === "Bash" && isCommit(command);
if (!touchesMarker && !commits) process.exit(0);

const config = loadConfig();
if (config.mode === "off") process.exit(0);

if (touchesMarker) {
  deny("harness: the eval pass marker (.claude/state/eval-pass.json) is written only by harness-eval. Run harness-eval instead of touching the file.");
}

let verdict;
try {
  verdict = checkMarker(config.dir, config.markerTtlMinutes);
} catch (error) {
  process.stderr.write(`harness: commit gate could not check the marker (${error.message}); the git pre-commit hook decides\n`);
  process.exit(0);
}

emitEvent(config, "gate.decision", { session_id: input.session_id, prompt_id: input.prompt_id, agent_id: input.agent_id, agent_type: input.agent_type },
  { decision: verdict.decision, reason: verdict.reason });

if (verdict.decision === "deny") {
  const evalPath = join(pluginRoot(), "bin", "harness-eval.mjs").replace(/\\/g, "/");
  deny(`harness: commit denied (${verdict.reason}): ${verdict.detail}. Stage exactly what you mean to commit, run node "${evalPath}" --task PLAN-n.m, and commit once it passes.`);
}
process.exit(0);
