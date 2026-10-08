// harness-init [--apply] [--branch <name>]: enrol this repository, giving it a home under ~/.harness/repos/ (ANY-REPO.md).
// Nothing in the repository's working tree is written; the only change in the clone is core.hooksPath
// (and harness.previousHooksPath, so its own hooks keep running). Without --apply it only says what it
// would do. With --apply it makes the changes and runs the doctor's checks. Each step leaves what is
// already right alone, so running it again is safe, and puts the hooks back if something moved them.
//
// `pu harness` runs it with --apply whenever it starts the Harness in a repository: a repository is
// enrolled when it is first worked in, never before.
import { pluginRoot, projectDir } from "../lib/config.ts";
import { enrolPlan } from "../lib/home.ts";
import { checks } from "../lib/setup.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
// --branch <name>: also mark that branch as a Harness branch (pu harness passes the one it starts on).
const branchAt = args.indexOf("--branch");
const branch = branchAt >= 0 ? args[branchAt + 1] : undefined;
const dir = projectDir();
const root = pluginRoot();
if (!root) {
  process.stdout.write("harness-init: can't find the plugin's own folder, so there is no template to enrol from\n");
  process.exit(1);
}
const { home, steps } = enrolPlan(dir, root, branch ? { branch } : {});
const say = (line: string = ""): boolean => process.stdout.write(line + "\n");

say(`harness-init: ${dir}${apply ? "" : " (dry run: nothing is changed)"}`);
say(`  home: ${home}`);
if (!steps.length) say("  nothing to do: it is enrolled, and everything enrolment sets up is in place");
for (const step of steps) say(`  - ${step.what}`);

if (!apply) {
  if (steps.length) say("\nRun again with --apply to make these changes. harness-forget undoes them.");
  process.exit(0);
}

for (const step of steps) step.apply();
say(`\napplied ${steps.length} change(s); harness-forget undoes them. The doctor's checks now:`);
const results = checks(dir, { pluginRoot: root });
for (const r of results) say(`  ${r.status.padEnd(5)} ${r.name.padEnd(16)} ${r.detail}`);
process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
