# The Harness

A Claude Code plugin, part of PreviouslyUpcoming. It scores every task for complexity, runs it on the model that score calls for, gates commits on an independent eval, and writes a metadata stream that PU ingests and visualises.

Read in this order (and [docs/ANY-REPO.md](docs/ANY-REPO.md) for how it runs in any repository with nothing written into it):

1. [docs/DESIGN.md](docs/DESIGN.md): how it works, with every review fix and spike result applied.
2. [docs/EVENTS.md](docs/EVENTS.md): the two metadata outputs (Harness Events v1 and Routing log v1), with examples.
3. [docs/PLAN.md](docs/PLAN.md): milestones M1–M7, the design changes C1–C16, and what we won't build.
4. [docs/spikes.md](docs/spikes.md): the day-1 checks of the Claude Code behaviour the design depends on.

The original design documents are in [docs/sources/](docs/sources/).

## Trying it in a repository

1. Enrol the repository: `/harness:init` in a Claude Code session with the plugin, or `node <this checkout>/bin/harness-init.mjs --apply` from its root. It gives the repository a home under `~/.harness/repos/` and writes nothing into it. `/harness:forget` undoes it. (`pu harness` does this for you.)
2. Start Claude Code there with the plugin and the orchestrator:

   ```sh
   claude --plugin-dir c:/src/harness --agent harness:orchestrator
   ```

   Or install it once: run `/plugin marketplace add c:/src/harness`, then `/plugin install harness@harness-local`.
3. Give it a task. Its plan, events and routing log land in the repository's home, `~/.harness/repos/<name>-<hash>/`.

In a repository that isn't enrolled, the plugin does nothing.

## Building

The scripts are written in TypeScript in `src/` and bundled into self-contained JavaScript files in `bin/` by `npm run build` (esbuild), so the plugin runs from a plain checkout with no `npm install` and no compile step. `bin/` is committed, and CI fails if it is out of date (`npm run check:bin`).

## Tests

```sh
npm ci
npm run typecheck   # tsc, strict, for src/ and test/
npm test            # Node runs the .ts tests directly (type stripping)
```

`npm test` validates every example in `docs/*.md` against the JSON Schemas in [`schema/`](schema/). It also checks that each design fix is enforced, by confirming that deliberately broken records are rejected. CI runs the typecheck and the tests on every pull request.
