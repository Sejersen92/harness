# The Harness

A Claude Code plugin, part of PreviouslyUpcoming. It scores every task for complexity, runs it on the model that score calls for, gates commits on an independent eval, and writes a metadata stream that PU ingests and visualises.

The contract is written; no plugin code exists yet. Read in this order:

1. [docs/DESIGN.md](docs/DESIGN.md): how it works, with every review fix and spike result applied.
2. [docs/EVENTS.md](docs/EVENTS.md): the two metadata outputs (Harness Events v1 and Routing log v1), with examples.
3. [docs/PLAN.md](docs/PLAN.md): milestones M1–M7, the design changes C1–C16, and what we won't build.
4. [docs/spikes.md](docs/spikes.md): the day-1 checks of the Claude Code behaviour the design depends on.

The original design documents are in [docs/sources/](docs/sources/).

## Tests

```sh
npm ci
npm test
```

`npm test` validates every example in `docs/*.md` against the JSON Schemas in [`schema/`](schema/). It also checks that each design fix is enforced, by confirming that deliberately broken records are rejected. CI runs it on every pull request.
