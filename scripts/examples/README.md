# Cloud examples

The client in [`qwen-proxy/client`](../../apps/proxy/src/client/index.ts) is
not tied to the proxy — it speaks plain OpenAI chat-completions, so the same
code runs against a hosted provider. These examples show what that looks like
with an API key and no GPU.

[`apps/proxy/examples/`](../../apps/proxy/examples/README.md) is the other half:
same client, pointed at the proxy, exercising the extensions a provider does not
have (`route()`, `inspect()`, `health()`, `mode`, `debug`).

## Running them

Copy [`../.env.example`](../.env.example) to `scripts/.env` and fill it in:

```bash
cp scripts/.env.example scripts/.env
$EDITOR scripts/.env

cd scripts && bun examples/01-extraction.ts
```

Bun reads `.env` from the working directory and does **not** walk up, so it has
to be `scripts/.env` — a `.env` at the repository root is not picked up, and
neither is `apps/api/.env`. Same variable names, separate file, per the
one-`.env`-per-workspace rule in [`CLAUDE.md`](../../CLAUDE.md). Real
environment variables work too, and override the file:

```bash
PROXY_BASE_URL=https://api.groq.com/openai PROXY_API_KEY=gsk_... PROXY_MODEL=llama-3.3-70b-versatile bun scripts/examples/01-extraction.ts
```

`PROXY_BASE_URL` is the host **minus** the `/v1` the client appends.
`PROXY_BASE_URL` and `PROXY_MODEL` default to the Groq pair above;
`PROXY_API_KEY` has no default — the examples exit if it is unset.

For a bare connectivity check rather than a walkthrough, use
[`../test-cloud.ts`](../test-cloud.ts) (`bun run test:cloud` from the root).

| File                 | Shows                                                                          |
| -------------------- | ------------------------------------------------------------------------------ |
| `01-extraction.ts`   | `extract()`: a JSON schema out, a parsed object back.                          |

## What changes off the proxy

- **`meetiq` is a proxy extension**, so no provider sends it. The client fills it
  in with `router.rule: 'upstream'` and zeroed timings rather than leaving it
  undefined, so `completion.meetiq` is always safe to read — but check that
  field before treating routing or `tok/s` numbers as real. A missing `usage` is
  zeroed the same way.
- **`route()`, `inspect()` and `health()` are proxy endpoints** and 404
  elsewhere. None of these examples call them.
- **`mode`, `reasoning_effort` and `debug` are proxy request fields.** A
  provider ignores unknown fields, so passing them is harmless but does nothing;
  `reasoning_content` comes back empty.
- **`json_schema` support varies by provider and model.** The proxy compiles a
  schema into a decoding grammar, so `extract()` cannot return malformed JSON.
  A provider may only support `json_object`, or ignore the schema. This is the
  one difference worth testing per model — see `01-extraction.ts`.
- **Tool calls are native**, so `meetiq.tool_parse` reports `native` and the
  proxy's text-extraction fallbacks never come into play.
