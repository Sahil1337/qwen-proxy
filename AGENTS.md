# AGENTS.md

Guidance for AI coding agents (and humans) working on `qwen-proxy`.
`CLAUDE.md` points here; keep this file the single source of truth.

## What this project is

A minimal, single-process, OpenAI-compatible HTTP proxy in front of a local
Ollama instance serving Qwen3.5-4B. It exists so that any OpenAI SDK client
gets three things the raw model does not reliably give:

1. **Adaptive thinking** — per-request choice between `think:false` and
   `think:true` with a token budget and a forced-close continuation.
2. **Tool calls that always validate** — native Ollama tool calls when
   available, a Hermes-style `<tool_call>` parser as fallback, constrained
   decoding when the caller forces a tool, and ajv validation of arguments
   with one retry. Never a silently wrong call.
3. **Structured output that always validates** — `response_format` mapped to
   Ollama's `format`, validated with ajv, one retry, then a 502.

The proxy also boots and supervises `ollama serve` itself so the inference
tuning (context length, KV cache type, flash attention, parallelism, GPU
layers) lives in this repo's `.env`, not in a system service.

## Non-goals

No embeddings, no per-request model switching, no persistence, no
multi-tenant auth, no application prompt templates. Callers own their prompts.

## Layout

```
src/
  index.ts            bootstrap: load config, start Ollama, listen, handle signals
  app.ts              createApp(deps) -> Express app; the only place routes are wired
  config.ts           zod-validated env -> Config
  middleware.ts       request id, bearer auth, error envelope
  routes/             thin HTTP handlers; no business logic
  core/
    ollama.ts         native /api/chat client (stream + non-stream) + error mapping
    supervisor.ts     spawn/wait/restart/stop the managed `ollama serve`
    mapping.ts        OpenAI <-> Ollama request/response types and conversion
    router.ts         adaptive fast/thinking decision (rules 1-6)
    thinking.ts       <think> splitting, budget enforcement, one model "turn"
    tools.ts          tool prompt injection, <tool_call> parser, JSON repair, ajv
    structured.ts     response_format -> format, output validation
    completion.ts     orchestration of one chat completion (retries, meta)
    stream.ts         SSE writer in OpenAI chunk format
    queue.ts          bounded concurrency with a wait timeout
    errors.ts         ProxyError -> OpenAI error envelope
  util/               tokens (chars/4 estimate), ids, logger
test/                 vitest; Ollama is always faked, never contacted
```

## Conventions

- TypeScript strict, ESM, [Bun](https://bun.sh) 1.1+. Relative imports end in `.js`.
- Under ten runtime dependencies. Add one only if it replaces >100 lines.
- Routes do HTTP only: parse, call `core/`, write. Logic lives in `core/`.
- Every upstream call goes through `OllamaClient` so tests can inject a fake.
- Errors are thrown as `ProxyError(status, code, message)` and rendered by
  the error middleware. Never `res.status(...).json(...)` an error by hand.
- Proxy-specific response fields live under `meetiq` and the `x-meetiq-*`
  headers. Do not add non-OpenAI fields anywhere else.
- Log one pino JSON line per request from the chat route; do not scatter
  `log.info` through the pipeline. `debug` is fine anywhere.
- Prefer small pure functions with tests over classes with state. Long-lived
  state lives only in the queue, the Ollama client and the supervisor; the
  per-request classes (`ThinkSplitter`, `SseWriter`) hold no state beyond one
  request.

## Testing

```
bun test          # vitest, fully offline
bun run typecheck # src and test
```

Every parser edge case, every router rule, and every mapping rule has a unit
test. Behavioural changes to the pipeline get an end-to-end test in
`test/chat.e2e.test.ts` using the `FakeOllama` client. Do not add tests that
need a running Ollama.

## Changing behaviour safely

- The `<tool_call>` parser targets exactly the Hermes format Qwen is trained
  on. Do not "generalise" it to other formats without a test per format.
- `NUM_GPU`, `NUM_CTX` and the KV cache type must be identical in every
  request, including the router's classifier call, or Ollama reloads the
  model. Set them in one place (`mapping.ts: baseOptions`).
- The router rules are ordered and first-match. Keep the order in
  `router.ts` identical to the README table.
