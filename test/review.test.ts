// H10: the security review's file, the PR block built from it, and harness-review-block itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSubcommands } from "../src/lib/gate.ts";
import { counts, isReviewPath, parseReview, readReviews, reviewBlock, reviewFileName } from "../src/lib/review.ts";
import { cleanEnv } from "./git.ts";
import { root, validatorFor } from "./validators.ts";

const review = (rows: string[], sound: string[] = ["tokens never reach stdout"]): string => [
  "# Security review: PLAN-3.2, round 1",
  "",
  "## Findings",
  "",
  "| Severity | Where | Finding | Fix |",
  "|---|---|---|---|",
  ...rows,
  "",
  "## Checked and sound",
  "",
  ...sound.map((s) => `- ${s}`),
  "",
].join("\n");

test("H10 a review file reads back as findings and checked-and-sound lines", () => {
  const r = parseReview("PLAN-3.2", 1, review([
    "| medium | src/client.ts:212 | the https check is skipped on this path | run BaseProblem first |",
    "| low | src/a.ts:9 | a \\| pipe in a cell | escape it |",
  ]));
  assert.equal(r.findings.length, 2);
  assert.deepEqual(r.findings[0], { severity: "medium", where: "src/client.ts:212", finding: "the https check is skipped on this path", fix: "run BaseProblem first" });
  assert.equal(r.findings[1]?.finding, "a | pipe in a cell");
  assert.deepEqual(r.sound, ["tokens never reach stdout"]);
  assert.deepEqual(counts(r), { high: 0, medium: 1, low: 1 });
});

test("H10 an unreadable severity counts as high, never as a quiet low", () => {
  const r = parseReview("PLAN-3.2", 1, review(["| critical | x.ts:1 | leaks | stop |"]));
  assert.equal(r.findings[0]?.severity, "high");
});

test("H10 a review with no findings has an empty table", () => {
  assert.deepEqual(parseReview("PLAN-3.2", 1, review([])).findings, []);
});

test("H10 the reviewer may write only a review file inside the reviews folder", () => {
  const meta = join(tmpdir(), "home");
  assert.equal(isReviewPath(join(meta, "reviews", "PLAN-3.2.security.md"), meta), true);
  assert.equal(isReviewPath(join(meta, "reviews", "PLAN-3.2.security.round-2.md"), meta), true);
  assert.equal(isReviewPath(join(meta, "reviews", "notes.md"), meta), false);
  assert.equal(isReviewPath(join(meta, "reviews", "sub", "PLAN-3.2.security.md"), meta), false);
  assert.equal(isReviewPath(join(meta, "PLAN.md"), meta), false);
  assert.equal(isReviewPath(join(meta, "reviews", "..", "PLAN-3.2.security.md"), meta), false);
  assert.equal(reviewFileName("PLAN-3.2", 1), "PLAN-3.2.security.md");
  assert.equal(reviewFileName("PLAN-3.2", 2), "PLAN-3.2.security.round-2.md");
});

test("H10 git subcommands are found however git is called", () => {
  assert.deepEqual(gitSubcommands("git -C /x diff --cached"), ["diff"]);
  assert.deepEqual(gitSubcommands('git -c a=b log -1 && git add -A'), ["log", "add"]);
  assert.deepEqual(gitSubcommands("ls -la"), []);
});

test("H10 the PR block shows a fixed medium, an open low, what was sound, and one unticked box", () => {
  const block = reviewBlock("SERIES-2", [
    parseReview("PLAN-3.2", 1, review(["| medium | src/c.ts:1 | skips the https check | check first |"])),
    parseReview("PLAN-3.2", 2, review(["| low | src/c.ts:40 | no size cap | cap at 16 MB |"], ["redirects are off"])),
  ]);
  assert.match(block, /^## Security review$/m);
  assert.match(block, /\| PLAN-3\.2 \| medium \| src\/c\.ts:1 \| skips the https check \| fixed in round 2 \|/);
  assert.match(block, /\| PLAN-3\.2 \| low \| src\/c\.ts:40 \| no size cap \| open \|/);
  assert.match(block, /- PLAN-3\.2: redirects are off/);
  assert.equal(block.match(/- \[ \] /g)?.length, 1);
  assert.doesNotMatch(block, /tokens never reach stdout/, "only the last round's checked list is shown");
});

test("H10 a series with no T4 task still answers the question", () => {
  assert.match(reviewBlock("SERIES-4", []), /No task in SERIES-4 was T4, so no task needed a security review\./);
});

test("H10 readReviews takes only the plans asked for, in task and round order", () => {
  const meta = mkdtempSync(join(tmpdir(), "harness-review-"));
  mkdirSync(join(meta, "reviews"));
  writeFileSync(join(meta, "reviews", "PLAN-3.10.security.md"), review([]));
  writeFileSync(join(meta, "reviews", "PLAN-3.2.security.round-2.md"), review([]));
  writeFileSync(join(meta, "reviews", "PLAN-3.2.security.md"), review([]));
  writeFileSync(join(meta, "reviews", "PLAN-4.1.security.md"), review([]));
  assert.deepEqual(readReviews(meta, ["PLAN-3"]).map((r) => `${r.task}#${r.round}`), ["PLAN-3.2#1", "PLAN-3.2#2", "PLAN-3.10#1"]);
});

test("H10 a security.reviewed event is valid harness.events/v1, and needs its counts", () => {
  const event = (data: object) => ({
    schema: "harness.events/v1", event_id: "01M4QQBANR5HEHMCWWG0MDNMH9", ts: "2026-11-10T12:00:00Z", type: "security.reviewed",
    producer: { name: "harness", version: "0.17.0" }, repo: { name: "r", remote_sha256: "0".repeat(64) }, mode: "observe",
    session_id: "s", config_sha256: "0".repeat(64), plan_id: "PLAN-3", task_id: "PLAN-3.2", data,
  });
  const good = event({ high: 0, medium: 1, low: 2, round: 1 });
  const validate = validatorFor(good);
  assert.equal(validate(good), true, JSON.stringify(validate.errors));
  assert.equal(validate(event({ high: 0, medium: 1, low: 2 })), false, "round is required");
});

test("H10 harness-review-block prints a series' block from the files alone, the same twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-review-repo-"));
  writeFileSync(join(dir, "routing.yaml"), "version: 1\nmode: observe\n");
  const meta = join(dir, ".harness");
  mkdirSync(join(meta, "reviews"), { recursive: true });
  mkdirSync(join(meta, "series"), { recursive: true });
  writeFileSync(join(meta, "series", "SERIES-2.json"), JSON.stringify({ series: "SERIES-2", plans: [{ plan: "PLAN-3" }] }));
  writeFileSync(join(meta, "reviews", "PLAN-3.2.security.md"), review(["| low | a.ts:1 | x | y |"]));
  const run = () => spawnSync("node", [join(root, "bin", "harness-review-block.mjs"), "SERIES-2"], {
    cwd: dir, encoding: "utf8", env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: dir, HARNESS_HOME: join(dir, ".harness-home") },
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /\| PLAN-3\.2 \| low \| a\.ts:1 \| x \| open \|/);
  assert.equal(run().stdout, first.stdout);
  assert.equal(spawnSync("node", [join(root, "bin", "harness-review-block.mjs"), "nonsense"], { cwd: dir, encoding: "utf8", env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: dir } }).status, 1);
});
