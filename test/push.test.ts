// The push guard (U1, H3): which pushes a Harness session may make. S21 (c) found the home's deny
// patterns let `HEAD:main`, `-f` and `+HEAD` through, so those five probes lead the table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pushRefusal, type PushContext } from "../src/lib/push.ts";

const onFeature: PushContext = { current: () => "feat/x", protectedBranches: () => ["main"] };
const onMain: PushContext = { current: () => "main", protectedBranches: () => ["main"] };
const detached: PushContext = { current: () => null, protectedBranches: () => ["main"] };
const defaultIsDevelop: PushContext = { current: () => "feat/x", protectedBranches: () => ["main", "develop"] };

const REFUSED: [string, PushContext][] = [
  // S21 (c), all five
  ["git push origin HEAD:main --dry-run", onFeature],
  ["git push origin main --dry-run", onFeature],
  ["git push -f origin HEAD --dry-run", onFeature],
  ["git push origin +HEAD --dry-run", onFeature],
  ["git push --force-with-lease origin HEAD --dry-run", onFeature],
  // other spellings of force
  ["git push --force origin feat/x", onFeature],
  ["git push origin feat/x --force", onFeature],
  ["git push -uf origin feat/x", onFeature],
  ["git push --force-if-includes --force-with-lease origin feat/x", onFeature],
  ["git push origin +feat/x:feat/x", onFeature],
  // other spellings of main
  ["git push origin feat/x:main", onFeature],
  ["git push origin HEAD:refs/heads/main", onFeature],
  ["git push origin refs/heads/main", onFeature],
  ["git push origin :main", onFeature],
  ["git push origin --delete main", onFeature],
  ["git push origin feat/x main", onFeature],
  ["git push origin feat/x:develop", defaultIsDevelop],
  // everything at once
  ["git push --mirror origin", onFeature],
  ["git push --all origin", onFeature],
  // a bare push, or HEAD, from the default branch or from nowhere
  ["git push", onMain],
  ["git push origin", onMain],
  ["git push -u origin HEAD", onMain],
  ["git push", detached],
  ["git push origin HEAD", detached],
  // refspecs that can't be read before they run
  ["git push origin $BRANCH", onFeature],
  ["git push origin $(git branch --show-current):main", onFeature],
  // the ways in that isCommit already knows
  ["git -C ../svc push origin HEAD:main", onFeature],
  ["npm test && git push origin HEAD:main", onFeature],
  ['bash -c "git push -f"', onFeature],
  ['"C:/Program Files/Git/bin/git.exe" push origin main', onFeature],
  ["git status; git push origin main", onFeature],
];

const ALLOWED: [string, PushContext][] = [
  ["git push -u origin feat/x", onFeature],
  ["git push -u origin HEAD", onFeature],
  ["git push", onFeature],
  ["git push origin feat/x:feat/x", onFeature],
  ["git push origin --delete feat/old", onFeature],
  ["git push --dry-run origin feat/x", onFeature],
  ["git -C ../svc push -u origin feat/x", onFeature],
  ["git push -o ci.skip origin feat/x", onFeature],
  ["git push origin refs/heads/feat/x", onFeature],
  ["git push origin feat/main-menu", onFeature],
  ["git push origin feat/x:develop", onFeature],
  ["git log --oneline origin/main..; git status", onFeature],
  ["npm run push", onFeature],
  ["echo pushed", onFeature],
  ["git stash push -m wip", onFeature],
  ["git push origin feat/x && git log -1 main", onFeature],
];

for (const [command, context] of REFUSED) {
  test(`refused: ${JSON.stringify(command)}`, () => assert.ok(pushRefusal(command, "/repo", context), "let through"));
}
for (const [command, context] of ALLOWED) {
  test(`allowed: ${JSON.stringify(command)}`, () => assert.equal(pushRefusal(command, "/repo", context), null));
}

test("-C is resolved against the session's folder before the branch is looked up", () => {
  const seen: string[] = [];
  const context: PushContext = { current: (dir) => (seen.push(dir), "feat/x"), protectedBranches: () => ["main"] };
  pushRefusal("git -C svc push", "/work", context);
  assert.match(seen[0] ?? "", /[\\/]work[\\/]svc$/);
});

test("a refusal says why in words", () => {
  assert.match(pushRefusal("git push origin HEAD:main", "/repo", onFeature) ?? "", /pushes to main/);
  assert.match(pushRefusal("git push -f", "/repo", onFeature) ?? "", /forces/);
  assert.match(pushRefusal("git push origin feat/x:develop", "/repo", defaultIsDevelop) ?? "", /default branch/);
});
