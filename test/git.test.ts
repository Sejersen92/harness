// test/git.ts: the one place tests spawn git, and cleanEnv(), the environment every test child gets.
// A git hook exports GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE and GIT_PREFIX; a test's git call that
// inherits them rewrites the repository the hook runs in instead of its own throwaway one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv } from "./git.ts";

test("PLAN-1.1/AC-3 cleanEnv() drops every GIT_* variable but GIT_CONFIG_*, keeps the rest, and leaves process.env alone", () => {
  // None of these is a real repository, and no git command runs while they are set.
  const nowhere = join(tmpdir(), "harness-no-such-repo");
  const set: Record<string, string> = {
    GIT_DIR: join(nowhere, ".git"),
    GIT_INDEX_FILE: join(nowhere, ".git", "index"),
    GIT_WORK_TREE: nowhere,
    GIT_PREFIX: "sub/",
    GIT_OBJECT_DIRECTORY: join(nowhere, ".git", "objects"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "harness.probe",
    GIT_CONFIG_VALUE_0: "kept",
    HARNESS_CLEAN_ENV_PROBE: "kept",
  };
  const previous = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  Object.assign(process.env, set);
  let env: NodeJS.ProcessEnv;
  try {
    env = cleanEnv();
    assert.equal(process.env.GIT_DIR, set.GIT_DIR, "cleanEnv() must return a copy, not strip process.env itself");
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const gitVars = Object.keys(env).filter((k) => /^GIT_/i.test(k)).sort();
  assert.deepEqual(gitVars, ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]);
  assert.equal(env.GIT_CONFIG_VALUE_0, "kept");
  assert.equal(env.HARNESS_CLEAN_ENV_PROBE, "kept");
  assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path);
});
