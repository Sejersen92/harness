// The eval in CI, for a repository its owner commits the Harness's two CI files to (ANY-REPO.md, C1).
// A CI runner has no home, so the stages travel in the repository: .github/harness-eval.yml holds only
// eval.stages, and the workflow runs harness-eval --ci --config on it. The stages are then written
// twice, in the home's routing.yaml and in that file; harness-doctor warns when the two differ.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { Step } from "./home.ts";
import type { Stage } from "./types.ts";

/** The stages CI runs, relative to the repository root. */
export const CI_CONFIG = ".github/harness-eval.yml";
/** The workflow that runs them on every pull request. */
export const CI_WORKFLOW = ".github/workflows/harness-eval.yml";
/** Where the workflow checks the Harness out from. It is public, so no token is needed. */
export const HARNESS_REPOSITORY = "Sejersen92/harness";

/** The stages in a CI stage file, or why they can't be read. */
export function readCiStages(path: string): { stages: Stage[] } | { problem: string } {
  if (!existsSync(path)) return { problem: `there is no ${path}` };
  let yaml: { eval?: { stages?: unknown } } | null;
  try {
    yaml = parse(readFileSync(path, "utf8")) as { eval?: { stages?: unknown } } | null;
  } catch (error) {
    return { problem: `${path} is not valid YAML: ${(error as Error).message.split("\n")[0]}` };
  }
  const stages = yaml?.eval?.stages;
  return Array.isArray(stages) ? { stages: stages as Stage[] } : { problem: `${path} has no eval.stages list` };
}

/** A stage with only the fields that change what runs, in one order, so two lists compare by content. */
const canonical = (stages: readonly Stage[]): string =>
  JSON.stringify(stages.map((s) => ({ name: s.name, run: s.run, cwd: s.cwd ?? null, env: s.env ?? null, timeout_minutes: s.timeout_minutes ?? null })));

export const sameStages = (a: readonly Stage[], b: readonly Stage[]): boolean => canonical(a) === canonical(b);

/** .github/harness-eval.yml for these stages. */
export function ciConfigText(stages: readonly Stage[]): string {
  return [
    "# The stages harness-eval runs on every pull request, from .github/workflows/harness-eval.yml.",
    "# They are a copy of eval.stages in this repository's routing.yaml, which is in its Harness home",
    "# because a CI runner has none. Change both together: harness-doctor warns when they differ.",
    stringify({ eval: { stages } }).trimEnd(),
    "",
  ].join("\n");
}

/**
 * .github/workflows/harness-eval.yml for these stages. Node is always set up, because harness-eval is
 * Node. The .NET SDK is added when a stage runs dotnet, and npm dependencies are installed in each folder
 * a stage runs npm in. Anything else a stage needs is the owner's to add.
 */
export function ciWorkflowText(dir: string, stages: readonly Stage[]): string {
  const npmFolders = [...new Set(stages.filter((s) => /^\s*npm\b/.test(s.run)).map((s) => s.cwd ?? "."))];
  const dotnet = stages.some((s) => /^\s*dotnet\b/.test(s.run));
  const lines = [
    "# The Harness eval on every pull request: the stages in .github/harness-eval.yml, run by the same",
    "# harness-eval that gates a commit locally. Written by harness-init --ci.",
    "#",
    "# The local gate can be skipped (git commit --no-verify); this runs on whatever a branch contains.",
    "# Make it a required check on the default branch to close the loop.",
    "name: harness-eval",
    "",
    "on:",
    "  pull_request:",
    "  workflow_dispatch:",
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  eval:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "",
    "      # The Harness is public, so this needs no token.",
    "      - uses: actions/checkout@v4",
    "        with:",
    `          repository: ${HARNESS_REPOSITORY}`,
    "          path: .harness-plugin",
    "",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 22",
  ];
  if (dotnet) {
    lines.push("", "      - uses: actions/setup-dotnet@v4", "        with:", '          dotnet-version: "10.0.x"');
  }
  for (const folder of npmFolders) {
    const install = existsSync(join(dir, folder, "package-lock.json")) ? "npm ci" : "npm install";
    lines.push("", `      - name: Install dependencies${folder === "." ? "" : ` (${folder})`}`, `        run: ${install}`);
    if (folder !== ".") lines.push(`        working-directory: ${folder}`);
  }
  lines.push(
    "",
    "      # --ci evaluates the checkout as it is and writes no pass marker. A failing stage fails the check,",
    "      # and its last lines are in the log.",
    "      - name: Harness eval",
    `        run: node .harness-plugin/bin/harness-eval.mjs --ci --config ${CI_CONFIG}`,
    "",
  );
  return lines.join("\n");
}

/** Where a repository stands on the two CI files, as harness-init --ci reports it on its ci: line. */
export type CiState = "present" | "missing" | "partial" | "declined";

/**
 * What adding the CI files would write: each file that is missing, never one that exists. The state is
 * "declined" when the owner said no and neither file has appeared since.
 */
export function ciPlan(dir: string, stages: readonly Stage[], declined: boolean): { state: CiState; steps: Step[] } {
  const config = join(dir, CI_CONFIG);
  const workflow = join(dir, CI_WORKFLOW);
  const have = [existsSync(config), existsSync(workflow)];
  const state: CiState = have.every(Boolean) ? "present" : have.some(Boolean) ? "partial" : declined ? "declined" : "missing";
  const steps: Step[] = [];
  if (!have[0]) steps.push({ what: `write ${CI_CONFIG} (stages: ${stages.map((s) => s.name).join(", ")})`, apply: () => write(config, ciConfigText(stages)) });
  if (!have[1]) steps.push({ what: `write ${CI_WORKFLOW} (runs harness-eval --ci --config ${CI_CONFIG} on every pull request)`, apply: () => write(workflow, ciWorkflowText(dir, stages)) });
  return { state, steps };
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
