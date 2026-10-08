// harness-init [--apply] [--branch <name>]: enrol this repository, giving it a home under ~/.harness/repos/ (ANY-REPO.md).
// Nothing in the repository's working tree is written; the only change in the clone is core.hooksPath
// (and harness.previousHooksPath, so its own hooks keep running). Without --apply it only says what it
// would do. With --apply it makes the changes and runs the doctor's checks. Each step leaves what is
// already right alone, so running it again is safe, and puts the hooks back if something moved them.
//
// `pu harness` runs it with --apply whenever it starts the Harness in a repository: a repository is
// enrolled when it is first worked in, never before.
//
// harness-init --ci [--apply | --decline]: the one change the Harness ever proposes for a repository's
// tree, and only for a repository its owner commits the Harness to (C1): .github/harness-eval.yml with
// routing.yaml's eval.stages, and the workflow that runs harness-eval --ci --config on it. A file that
// exists is never overwritten. It writes but doesn't commit; `pu harness` commits the files on the
// Harness branch. Its ci: line says where the repository stands: present, missing, partial or declined.
// --decline records the owner's no in repo.json, so the offer isn't made again.
import { ciPlan } from "../lib/ci.ts";
import { loadConfig, pluginRoot, projectDir } from "../lib/config.ts";
import { declineCi, enrolPlan, readRepoRecord } from "../lib/home.ts";
import { checks } from "../lib/setup.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
// --branch <name>: also mark that branch as a Harness branch (pu harness passes the one it starts on).
const branchAt = args.indexOf("--branch");
const branch = branchAt >= 0 ? args[branchAt + 1] : undefined;
const dir = projectDir();
const say = (line: string = ""): boolean => process.stdout.write(line + "\n");

if (args.includes("--ci")) {
  const config = loadConfig(dir);
  if (!config.layout) {
    say(`harness-init --ci: ${dir} is not enrolled, so there are no eval stages to put in CI. Run harness-init --apply first.`);
    process.exit(1);
  }
  const decline = args.includes("--decline");
  const { state, steps } = ciPlan(dir, config.stages, Boolean(readRepoRecord(config.home)?.ci_declined));
  say(`harness-init --ci: ${dir}${apply || decline ? "" : " (dry run: nothing is changed)"}`);
  say(`  ci: ${state}`);
  if (decline) {
    declineCi(config.home);
    say(`  the no is recorded in ${config.home}, so pu harness won't offer the CI files again; harness-init --ci --apply still adds them`);
    process.exit(0);
  }
  if (!steps.length) {
    say("  nothing to do: both CI files are in the repository");
    process.exit(0);
  }
  if (!config.stages.length) {
    say(`  eval.stages is empty in ${config.layout.routingYaml}, so there is nothing to put in CI yet`);
    process.exit(1);
  }
  for (const step of steps) say(`  - ${step.what}`);
  if (!apply) {
    say("\nRun again with --apply to write them, or with --decline to stop pu harness offering them.");
    process.exit(0);
  }
  for (const step of steps) step.apply();
  say(`\nwrote ${steps.length} file(s). They aren't committed: CI runs them once they're committed and pushed.`);
  process.exit(0);
}

const root = pluginRoot();
if (!root) {
  say("harness-init: can't find the plugin's own folder, so there is no template to enrol from");
  process.exit(1);
}
const { home, steps } = enrolPlan(dir, root, branch ? { branch } : {});

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
