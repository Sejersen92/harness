// harness-policy apply --json '<policy>' | show: PreviouslyUpcoming's routing policy for this repository.
//
// apply sets mode and each tier's model and effort in the home's routing.yaml, changing no other byte,
// then records the policy in <home>/state/policy.json. show prints what policy.json holds. Every
// outcome is one line on stdout: applied, unchanged, hand edit replaced, or refused (exit 1, nothing
// written).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectDir, repoHome } from "../lib/config.ts";
import { applyPolicy, oneLineText, readState, showLine, validatePolicy, type ApplyOutcome } from "../lib/policy.ts";

const USAGE = "use harness-policy apply --json '<policy>' or harness-policy show";

function apply(home: string, args: string[]): ApplyOutcome {
  const at = args.indexOf("--json");
  const json = at >= 0 ? args[at + 1] : undefined;
  if (json === undefined) return { line: `refused: apply needs --json '<policy>'`, code: 1 };
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    return { line: "refused: the policy is not valid JSON", code: 1 };
  }
  const checked = validatePolicy(input);
  if (!checked.ok) return { line: `refused: ${checked.why}`, code: 1 };
  return applyPolicy(home, checked.policy);
}

function main(): ApplyOutcome {
  const [command, ...args] = process.argv.slice(2);
  const home = repoHome(projectDir());
  const enrolled = existsSync(join(home, "routing.yaml"));
  if (command === "show") return { line: enrolled ? showLine(readState(home)) : "none · not enrolled", code: 0 };
  if (command === "apply") {
    if (!enrolled) return { line: "refused: not enrolled (this repository has no Harness home; run /harness:init first)", code: 1 };
    return apply(home, args);
  }
  return { line: `refused: ${command === undefined ? "no command" : `unknown command ${JSON.stringify(command)}`}; ${USAGE}`, code: 1 };
}

let outcome: ApplyOutcome;
try {
  outcome = main();
} catch (error) {
  outcome = { line: `failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, code: 1 };
}
// Every outcome is exactly one line, whatever text it echoes.
process.stdout.write(oneLineText(outcome.line) + "\n");
process.exit(outcome.code);
