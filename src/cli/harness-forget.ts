// harness-forget [--all] [--yes]: remove what enrolment set up, for this repository or (--all) for every
// one on this machine. Without --yes it only says what it would do.
//
// For each home: core.hooksPath goes back to what it was before enrolment, the home is deleted, and its
// spool comes off the registry. The repository's working tree is not touched. What it can't undo is
// said, not hidden: lines PU has already received stay in PU, and Claude Code's own transcripts stay
// where Claude Code keeps them. Lines PU has not received yet are lost; this script can't see what PU
// has sent, so `pu harness forget`, which can, checks first.
import { projectDir, repoHome } from "../lib/config.ts";
import { forgetPlan, homes } from "../lib/home.ts";

const args = process.argv.slice(2);
const all = args.includes("--all");
const yes = args.includes("--yes");
const say = (line: string = ""): boolean => process.stdout.write(line + "\n");

const dir = projectDir();
const targets = all ? homes() : [{ home: repoHome(dir), repoDir: dir }];
const plans = targets.map((t) => ({ ...t, ...forgetPlan(t.home, t.repoDir) })).filter((p) => p.steps.length);

say(`harness-forget: ${all ? "every enrolled repository on this machine" : dir}${yes ? "" : " (dry run: nothing is changed)"}`);
if (!plans.length) {
  say(all ? "  nothing to do: no repository is enrolled" : "  nothing to do: this repository is not enrolled");
  process.exit(0);
}
for (const plan of plans) {
  say(`  ${plan.repoDir ?? "(a home whose clone is unknown)"}`);
  for (const step of plan.steps) say(`    - ${step.what}`);
}

const atRisk = plans.reduce((sum, p) => sum + p.unsentRisk, 0);
if (atRisk) say(`\n${atRisk} spool line(s) go with the home(s). Any PU has not received yet are lost; \`pu harness forget\` checks that first.`);
say("Not removed: what PU has already received (delete it in PU), Claude Code's transcripts, the plugin, and any Harness files committed to a repository.");

if (!yes) {
  say("\nRun again with --yes to make these changes.");
  process.exit(0);
}

for (const plan of plans) for (const step of plan.steps) step.apply();
say(`\nforgot ${plans.length} repository(ies).`);
process.exit(0);
