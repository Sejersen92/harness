# The Harness

A Claude Code plugin, part of PreviouslyUpcoming. It scores every task for complexity, runs it on the model that score calls for, gates commits on an independent eval, and writes a metadata stream that PU ingests and visualises.

The contract is written; no plugin code exists yet. Read in this order:

1. [docs/DESIGN.md](docs/DESIGN.md): how it works, with every review fix and spike result applied.
2. [docs/EVENTS.md](docs/EVENTS.md): the two metadata outputs (Harness Events v1 and Routing log v1), with examples.
3. [docs/PLAN.md](docs/PLAN.md): milestones M1–M7, the design changes C1–C16, and what we won't build.
4. [docs/spikes.md](docs/spikes.md): the day-1 checks of the Claude Code behaviour the design depends on.

The original design documents are in [docs/sources/](docs/sources/).

## Trying it in a repository

1. Copy [templates/routing.yaml](templates/routing.yaml) to the repository root (`mode: observe`), and add `.harness/` to its `.gitignore`.
2. Start Claude Code there with the plugin and the orchestrator:

   ```sh
   claude --plugin-dir c:/src/harness --agent harness:orchestrator
   ```

   Or install it once: run `/plugin marketplace add c:/src/harness`, then `/plugin install harness@harness-local`.
3. Give it a task. Events land in `.harness/events/`, and one routing-log line per completed task lands in `.harness/routing-log/`.

Without a `routing.yaml`, the plugin does nothing in that repository.

## Building

The scripts are written in `src/` and bundled into self-contained files in `bin/` by `npm run build`, so the plugin runs from a plain checkout with no `npm install`. `bin/` is committed, and CI fails if it is out of date (`npm run check:bin`).

## Tests

```sh
npm ci
npm test
```

`npm test` validates every example in `docs/*.md` against the JSON Schemas in [`schema/`](schema/). It also checks that each design fix is enforced, by confirming that deliberately broken records are rejected. CI runs it on every pull request.
