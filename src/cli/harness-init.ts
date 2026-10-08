// harness-init [--apply]: set the Harness up in this repository. Without --apply it only says what it
// would do, including the exact change to .claude/settings.json (S7: a plugin can't ship permission
// rules, so they are merged here, and a person sees them first). With --apply it makes the changes and
// runs the doctor's checks. Each step leaves what is already right alone, so running it twice is safe.
import { pluginRoot, projectDir } from "../lib/config.ts";
import { checks, initPlan, settingsDiff } from "../lib/setup.ts";

const apply = process.argv.includes("--apply");
const dir = projectDir();
const root = pluginRoot();
if (!root) {
  process.stdout.write("harness-init: can't find the plugin's own folder, so there is no template to set up from\n");
  process.exit(1);
}
const { steps, settingsBefore, settingsAfter } = initPlan(dir, root);
const say = (line: string = ""): boolean => process.stdout.write(line + "\n");

say(`harness-init: ${dir}${apply ? "" : " (dry run: nothing is changed)"}`);
if (!steps.length) say("  nothing to do: everything init sets up is already in place");
for (const step of steps) say(`  - ${step.what}`);

const diff = settingsDiff(settingsBefore, settingsAfter);
if (diff.length) {
  say();
  say(".claude/settings.json would change like this. The deny rules apply to every Claude Code session in this repository:");
  for (const line of diff) say(`  ${line}`);
}

if (!apply) {
  if (steps.length) say("\nRun again with --apply to make these changes.");
  process.exit(0);
}

for (const step of steps) step.apply();
say(`\napplied ${steps.length} change(s). The doctor's checks now:`);
const results = checks(dir, { pluginRoot: root });
for (const r of results) say(`  ${r.status.padEnd(5)} ${r.name.padEnd(16)} ${r.detail}`);
process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
