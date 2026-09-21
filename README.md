# meetAI

**Project memory for teams that keep forgetting what they decided.**

Teams meet, decide things, promise dates, hit blockers, and change their minds.
A few weeks later nobody can reconstruct *why* a decision was made, who
committed to what, or which old agreement the new plan just contradicted. The
recording does not help — nobody rewatches an hour of video to find one sentence.

meetAI reads meeting transcripts and builds a **living memory of the project**
out of them: not a summary you read once, but structured claims that accumulate,
change, and can be questioned later, with the original transcript lines attached
as evidence.

## What that looks like

**Monday's meeting**

> Rahul will complete the payment API by Friday.

meetAI records a commitment — Rahul, payment API, due Friday — sourced to that
line in Monday's transcript.

**The following Monday**

> The payment API is still incomplete because the gateway documentation was delayed.

meetAI does not simply log a second fact. It recognises this as *the same
commitment*, now missed; that a blocker appeared; and that the blocker is
external. So a week later someone can ask:

> **Why is the payment API delayed?**

and get an answer that cites both meetings — rather than a summary telling them
the payment API was discussed.

The questions it is built to answer: what changed since the last meeting, who
committed to what, what is at risk, what is blocked, and which decision
contradicts which.

## Status

Under active development. Where each part stands:

| Part | State |
| --- | --- |
| `apps/proxy` — LLM serving layer | Working, in daily use |
| `packages/ai` — extraction, tool layer, prompts | Built; answering in progress |
| `packages/ingestion` — windowing, processing job | Windowing built; job in progress |
| `packages/memory` — persistence, state, contradictions | Contracts defined, implementation in progress |
| `packages/retrieval` — embeddings, index, search | Contracts defined, implementation in progress |
| `apps/api`, `apps/web` | Contracts defined, implementation in progress |

Known issues are tracked in [`docs/audit.md`](docs/audit.md) rather than left
implicit — including a demonstrated case of the ambiguity resolver inventing a
referent.

Transcription and speaker diarization are **out of scope**. meetAI assumes the
transcript already exists, one line per turn:

```
Yash [15:03 2026-09-07]: I'm not convinced chunking the transcript is going to work.
```

## How it works

```
transcript → windows → extraction (LLM + tools) → propositions
                                                       │
                                                       ▼
                          memory ← entity resolution ← claims
                             │
                             ├── state changes, contradictions, timeline
                             └── retrieval → evidence-cited answers
```

Extraction runs against a **self-hosted Qwen3.5-4B on a laptop GPU** — an RTX
3050 with 4 GB of VRAM — rather than a hosted API, so the whole system runs end
to end with no API keys and no external dependency. That constraint shapes
everything: small context windows, JSON-schema constrained output, and tool
calls instead of one giant prompt.

## Running it

Requires [Bun](https://bun.sh). There is no build step.

```bash
bun install          # one lockfile covers every workspace
bun run typecheck    # every package, in parallel
bun run dev:proxy    # the proxy — run this on the machine with the GPU
bun run eval         # extraction quality against a live proxy
```

`bun run eval` needs a reachable proxy. Point it at your own with
`PROXY_BASE_URL=http://your-host:8000 bun run eval`.

## Layout

```
apps/proxy      OpenAI-compatible LLM server over Ollama (MIT, standalone)
apps/api        backend: HTTP surface and composition root
apps/web        frontend: React, talks to the API over HTTP
packages/core   shared contracts — the domain model, as zod schemas
packages/*      one package per area: ingestion, ai, memory, retrieval
evals/          extraction quality suites
docs/           product spec, architecture, audit, work split
```

## Documentation

- [`docs/product-spec.md`](docs/product-spec.md) — what the system is meant to do, in full
- [`docs/architecture.md`](docs/architecture.md) — the module boundaries, and why they are where they are
- [`docs/audit.md`](docs/audit.md) — an honest review of the codebase, including known bugs
- [`docs/work-split.md`](docs/work-split.md) — how the work divides across the team
- [`CLAUDE.md`](CLAUDE.md) — conventions for anyone, or anything, writing code here

## License

`apps/proxy/` is MIT — see [`apps/proxy/LICENSE`](apps/proxy/LICENSE). The rest
of the repository is not licensed for reuse yet; if you want to use it, open an
issue and ask.
