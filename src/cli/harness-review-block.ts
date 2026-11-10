// harness-review-block SERIES-n | PLAN-n [...]: prints the security section for a pull request (H10)
// from the review files harness:security-reviewer wrote. A series means the plans its SERIES-n.json
// lists. It reads files only, so the same files always print the same block.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.ts";
import { readReviews, reviewBlock } from "../lib/review.ts";

function fail(message: string): never {
  process.stderr.write(`harness-review-block: ${message}\n`);
  return process.exit(1);
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!args.length || args.some((a) => !/^(SERIES|PLAN)-\d+$/.test(a))) {
  fail("usage: harness-review-block SERIES-n | PLAN-n [PLAN-n ...]");
}

const config = loadConfig();
if (config.mode === "off") fail(`this repository is not enrolled (${config.reason}).`);

const plans: string[] = [];
for (const id of args) {
  if (id.startsWith("PLAN-")) {
    plans.push(id);
    continue;
  }
  const file = join(config.metadataDir, "series", `${id}.json`);
  if (!existsSync(file)) fail(`${id} has no ${file}.`);
  try {
    const series = JSON.parse(readFileSync(file, "utf8")) as { plans?: { plan?: string }[] };
    for (const p of series.plans ?? []) if (p.plan) plans.push(p.plan);
  } catch {
    fail(`${file} isn't readable JSON.`);
  }
}

process.stdout.write(reviewBlock(args.join(", "), readReviews(config.metadataDir, plans)));
