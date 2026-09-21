# CLAUDE.md

Conventions for anyone — human or agent — writing code in this repository.
`README.md` is the public introduction to the project; this file is the working
manual. See [`docs/architecture.md`](docs/architecture.md) for the unit
boundaries and the reasoning behind them, and
[`docs/work-split.md`](docs/work-split.md) for who owns what.

## Layout

```
apps/            things that run — each has a process and a deploy target
  proxy/         qwen-proxy: OpenAI-compatible server over Ollama/Qwen3.5
  api/           the backend: HTTP surface + composition root        (unit 1)
  web/           the frontend: React, consumes the HTTP API only     (unit 5)
packages/        things that get imported — never run standalone
  core/          shared contracts: domain model (zod), cross-unit interfaces,
                 and the transcript grammar
  ingestion/     transcript intake, windowing, the processing job     (unit 1)
  ai/            extraction agent, tool layer, prompts, answering     (unit 2)
  memory/        persistence, entity resolution, state, changes       (unit 3)
  retrieval/     embeddings, index, search                            (unit 4)
  tsconfig/      the base tsconfig everything else extends
evals/           eval suites — not deployed, not imported
  propositions/  extraction quality: fixtures, checks, manual verdict loop
docs/            product spec, architecture, audit, work split, reading list
```

`apps/` vs `packages/` is the only split rule: an app has a port, a package is
an import. Each unit's `README.md` states its owner, its boundary, and its first
task.

## Commands

```bash
bun install          # one lockfile at the root covers every workspace
bun run typecheck    # every package, in parallel — must stay clean
bun run eval         # proposition extraction evals against a live proxy
bun run dev:api      # the backend
bun run dev:proxy    # the proxy, on the machine with the GPU
```

Runtime is [Bun](https://bun.sh), not Node. Internal packages export raw
TypeScript through their `exports` map, so there is no build step to keep
working — don't add one unless something genuinely needs it.

## Rules that matter

- **Imports flow one way: apps → packages → core.** A unit package
  (`ingestion`, `ai`, `memory`, `retrieval`) imports `@meetai/core` and nothing
  else in `packages/`. The only place two units meet is
  `apps/api/src/container.ts`. Any other arrangement makes one owner wait on
  another, or fork their types.
- **Any type that crosses a unit boundary lives in `@meetai/core`**, as a zod
  schema with the type inferred from it. Not in the unit that happened to need
  it first.
- **`apps/web` imports `@meetai/core` type-only** and otherwise talks to
  `apps/api` over HTTP. It never calls the proxy.
- **Nothing in `packages/` imports from `apps/`.** The one exception is
  `qwen-proxy`, which publishes a client through its `exports` map — a
  maintained contract, not an app internal.
- **The transcript line grammar has one parser**: `parseTranscript` in
  `@meetai/core`. It previously had three, and they disagreed on malformed
  input. Do not write a fourth.
- **Tools are declared, not wired.** A tool is one file under
  `packages/ai/src/tools/` — name, description, zod parameter schema and handler
  together — registered in `ToolRegistry`. The proxy-facing JSON Schema is
  derived from the zod schema, never hand-written beside it. The agent loop
  names no tool; adding one should require no edit to it.
- **`.env` per app, never one at the root.** The proxy runs on a different
  machine than the API; a shared env file would be a lie.
- **The proxy is a dumb, stateless endpoint.** Retrieval, embeddings, memory and
  state never run there. Keep it general — meetAI prompts, fixtures, transcripts
  and schemas do not belong under `apps/proxy/`.
- **`apps/proxy/` keeps its own conventions.** It is independently usable and
  separately licensed, so it has its own `AGENTS.md`, its MIT `LICENSE` and its
  own house style — single quotes, 120 columns, NodeNext `.js` specifiers.
  Follow those inside that directory, and the root style outside it.
