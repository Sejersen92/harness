// Preloaded by `npm test` (--import): strips GIT_* but GIT_CONFIG_* from the test process's own
// environment, so src functions the tests call in-process (which run git with process.env) never
// reach a repository a git hook's GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE or GIT_PREFIX points at.
for (const key of Object.keys(process.env)) {
  if (/^GIT_/i.test(key) && !/^GIT_CONFIG_/i.test(key)) delete process.env[key];
}
