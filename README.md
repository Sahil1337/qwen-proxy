# qwen-proxy

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-fbf0df.svg)](https://bun.sh)

A minimal OpenAI-compatible HTTP proxy in front of a local [Ollama](https://ollama.com) running **Qwen3.5-4B**. Point any OpenAI SDK at it and get three things the raw model doesn't reliably give you:

- **Adaptive thinking** — picks `think:false`/`think:true` per request, enforces a token budget, and forces an answer if the model overruns it. Reasoning comes back in `reasoning_content`, never mixed into `content`.
- **Tool calls that always validate** — native Ollama tool calls when available, a Hermes-style `<tool_call>` parser as fallback, constrained decoding when a tool is forced, and ajv validation with one retry. Never a silently wrong call.
- **Structured output that always validates** — `response_format` maps to Ollama's `format`, is validated against your schema, retried once, then rejected with a 502.

It also **boots and supervises `ollama serve` itself**, so the tuning that matters on a small GPU (context length, KV cache quantization, flash attention, parallelism, GPU layers) lives in this repo's `.env` instead of a system service.

Single process, TypeScript, Express 4, no database.

## Quick start

Requirements: [Bun](https://bun.sh) 1.1+, [Ollama](https://ollama.com/download) installed (just the binary), and the model pulled once:

```bash
ollama pull qwen3.5:4b
```

```bash
git clone <this repo> && cd qwen-proxy
bun install
cp .env.example .env      # edit if needed
bun run dev                # starts ollama serve + the proxy on :8000
```

Production:

```bash
bun run start
```

On a laptop, `bun run serve` does the same but keeps the machine from suspending while the proxy runs (the screen may still blank). It uses KDE's `kde-inhibit`; on GNOME or a headless box use `systemd-inhibit --what=sleep:idle bun run start` or the systemd unit below.

If an Ollama is already listening on `OLLAMA_BASE_URL`, the proxy attaches to it instead of managing its own and logs a warning that the tuning below doesn't apply. To get the tuning, stop the other instance first (`sudo systemctl disable --now ollama` on a package install).

<details>
<summary>Reusing models from a previous systemd install</summary>

The Debian/systemd install keeps models under `/usr/share/ollama/.ollama/models`, owned by the `ollama` user but world-readable. Set `OLLAMA_MODELS=/usr/share/ollama/.ollama/models` in `.env` to reuse them read-only instead of pulling 3 GB again.

</details>

## Why the GPU settings matter

On an RTX 3050 with 4 GB of VRAM, Ollama's automatic memory fit reserves ~1 GB for the vision encoder bundled with `qwen3.5:4b` and offloads only 23 of the model's 34 layers — the 11 layers left on the CPU dominate generation time. Measured on that card:

| Layers on GPU             | Generation | Prompt eval |
| ------------------------- | ---------- | ----------- |
| 23 / 34 (Ollama auto-fit) | 13.9 tok/s | 15 tok/s    |
| 34 / 34 (`NUM_GPU=34`)    | 39.5 tok/s | 128 tok/s   |

The proxy sends `num_gpu`, `num_ctx` and the KV cache type on **every** request, including the router's classifier call, so Ollama never reloads the model between requests. If you see out-of-memory errors, lower `NUM_CTX` before lowering `NUM_GPU`. Sending images isn't supported — the vision encoder would need the VRAM headroom this config deliberately spends on layers.

## Configuration

All settings are environment variables, validated at startup with [t3-env](https://env.t3.gg). `.env` in the working directory is loaded automatically.

| Variable                  | Default                  | Meaning                                                                                                                                           |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `8000`                   | Proxy port.                                                                                                                                       |
| `API_KEY`                 | unset                    | When set, `/v1/*` requires `Authorization: Bearer <key>`. `/health` stays open.                                                                   |
| `LOG_LEVEL`               | `info`                   | `debug` adds a `model.io` event per request with the prompt, the model's full reasoning, tool calls and answer. `trace` adds Ollama's own output. |
| `LOG_FORMAT`              | `auto`                   | `pretty` (coloured, human-readable), `json` (one line per event), or `auto` (pretty on a terminal, json otherwise).                               |
| `LOG_CONTENT`             | `true`                   | Include the prompt and an answer preview in the per-request events. Set `false` if logs must not hold user content.                               |
| `OLLAMA_MANAGED`          | `true`                   | Spawn and supervise `ollama serve`. `false` = attach to an existing server.                                                                       |
| `OLLAMA_BIN`              | `ollama`                 | Binary to spawn.                                                                                                                                  |
| `OLLAMA_BASE_URL`         | `http://127.0.0.1:11434` | Where Ollama listens.                                                                                                                             |
| `OLLAMA_MODELS`           | unset                    | Model directory for the child process.                                                                                                            |
| `OLLAMA_START_TIMEOUT_MS` | `30000`                  | How long to wait for the child to answer.                                                                                                         |
| `OLLAMA_PRELOAD`          | `true`                   | Load the model into VRAM at startup.                                                                                                              |
| `MODEL`                   | `qwen3.5:4b`             | The single served model.                                                                                                                          |
| `NUM_CTX`                 | `8192`                   | Context window; sent on every request.                                                                                                            |
| `NUM_GPU`                 | `34`                     | Layers on the GPU. `-1` = Ollama auto-fit.                                                                                                        |
| `KV_CACHE_TYPE`           | `q8_0`                   | KV cache quantization for the child.                                                                                                              |
| `FLASH_ATTENTION`         | `true`                   | Flash attention for the child.                                                                                                                    |
| `KEEP_ALIVE`              | `30m`                    | How long Ollama keeps the model loaded.                                                                                                           |
| `MAX_PARALLEL`            | `2`                      | Proxy concurrency; must match Ollama's parallelism.                                                                                               |
| `DEFAULT_MODE`            | `adaptive`               | `thinking`, `fast` or `adaptive` when the caller sends no `mode`.                                                                                 |
| `THINK_BUDGET_TOKENS`     | `1024`                   | Thinking budget per request.                                                                                                                      |
| `DEFAULT_MAX_TOKENS`      | `2048`                   | Answer budget when the caller sends no `max_tokens`.                                                                                              |
| `ADAPTIVE_SHORT_TOKENS`   | `60`                     | Router rule 5 threshold (chars / 4).                                                                                                              |
| `ADAPTIVE_TOOLS_THINK`    | `true`                   | Router rule 3: tools imply thinking.                                                                                                              |
| `CLASSIFIER_TIMEOUT_MS`   | `3000`                   | Router rule 6 timeout; timeout means fast.                                                                                                        |
| `TOOL_INJECTION`          | `native`                 | `native` passes tools to Ollama's template; `prompt` injects a Hermes tools block and always parses.                                              |
| `TOOL_SCHEMA_SLIM`        | `true`                   | Strip validation-only keywords from tool schemas before the model sees them.                                                                      |
| `QUEUE_TIMEOUT_MS`        | `120000`                 | Max wait for a slot before 503.                                                                                                                   |
| `UPSTREAM_TIMEOUT_MS`     | `600000`                 | Per-call Ollama timeout.                                                                                                                          |
| `MAX_PROMPT_TOKENS`       | `7000`                   | Estimated prompt tokens above this are rejected with 400.                                                                                         |

## Endpoints

| Method | Path                   | Purpose                                                                                     |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------- |
| `POST` | `/v1/chat/completions` | OpenAI chat completions. Extension: `mode`.                                                 |
| `GET`  | `/v1/models`           | The configured model.                                                                       |
| `GET`  | `/health`              | Ollama reachable, model loaded, queue depth.                                                |
| `POST` | `/v1/route`            | Router decision for a request body, without generating.                                     |
| `POST` | `/v1/inspect`          | Router decision **and** the exact payload that would be sent to Ollama, without generating. |

Every completion carries a `meetiq` object the OpenAI SDK ignores (router decision, retries, timing) and `x-meetiq-*` headers. `debug: true` on a request adds the exact upstream payloads sent for it.

<details>
<summary>Architecture &amp; internals</summary>

### How a request flows

```

OpenAI SDK ──► POST /v1/chat/completions
│ parse + validate body (zod), estimate prompt size, bearer auth
▼
queue slot (MAX_PARALLEL)
│
▼
router ──► mode: fast | thinking (rules 1-6, may make one tiny classifier call)
│
▼
plan ──► messages (tool results -> <tool_response>, assistant tool_calls -> <tool_call>)
tools for the model (slimmed) | tools for validation (full)
format (JSON schema -> grammar) | think flag | num_predict
│
▼
turn ──► POST /api/chat on Ollama
thinking: budget = THINK_BUDGET_TOKENS + max_tokens
cut off by the budget (no or partial answer)? -> continuation call with forced </think>
│
▼
validate ──► tool args (ajv) / structured output (ajv)
invalid? -> one retry with the error appended -> 502
│
▼
OpenAI response (+ meetiq metadata, x-meetiq-* headers, one log line)

```

### Thinking modes

| Mode       | Upstream            | Behaviour                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fast`     | `think:false`       | Any `<think>` that leaks into content is stripped.                                                                                                                                                                                                                                                                                          |
| `thinking` | `think:true`        | `num_predict = THINK_BUDGET_TOKENS + max_tokens`. Reasoning returns in `choices[0].message.reasoning_content`. A budget overrun (no answer, or a partial one cut off on length) triggers a second call that continues from the truncated thinking and any partial answer with a forced `</think>`, and sets `meetiq.think_budget_hit=true`. |
| `adaptive` | decided per request | See the router below.                                                                                                                                                                                                                                                                                                                       |

### Adaptive router

Rules are evaluated in order; the first match wins (`meetiq.router.rule` / `x-meetiq-rule` reports it).

| #   | Rule                | Condition                                                      | Mode           |
| --- | ------------------- | -------------------------------------------------------------- | -------------- |
| 1   | `explicit`          | Caller sent `mode` or `reasoning_effort`.                      | as requested   |
| 1b  | `default`           | `DEFAULT_MODE` is not `adaptive`.                              | `DEFAULT_MODE` |
| 2   | `structured_output` | `response_format` present, no tools.                           | fast           |
| 3   | `tools`             | `tools` present (unless `ADAPTIVE_TOOLS_THINK=false`).         | thinking       |
| 4   | `reasoning_cue`     | Last user message asks why/compare/plan/trade-off/etc.         | thinking       |
| 5   | `short_prompt`      | Last user message shorter than `ADAPTIVE_SHORT_TOKENS`.        | fast           |
| 6   | `classifier`        | One classifier call to the model. Timeout or error means fast. | model decides  |

### Tool calling

1. `TOOL_INJECTION=native` (default): tools are passed to Ollama; structured `message.tool_calls` are used when returned (`tool_parse: "native"`).
2. Otherwise the content is parsed for Hermes-style `<tool_call>{"name":...,"arguments":{...}}</tool_call>` blocks (`tool_parse: "fallback"`), with lenient JSON repair for malformed model output.
3. Arguments are validated with ajv against the tool's `parameters`; one retry on failure, then **502 `tool_call_invalid`**.
4. `tool_choice: "required"` or a forced function uses constrained decoding — Ollama's `format` becomes a JSON schema for the call, so this path can't produce malformed output.
5. Incoming `role:"tool"` messages become `<tool_response>` text; a preceding assistant `tool_calls` message is re-rendered as `<tool_call>` text.

### Structured output

`response_format: {type:"json_schema", json_schema:{schema}}` sends the schema as Ollama's `format`; the result is parsed, validated with ajv, retried once, then rejected with **502 `structured_output_invalid`**. Structured requests default to fast (router rule 2).

### Streaming

Send `stream: true` and read server-sent events, exactly as with OpenAI. The stream ends with `data: [DONE]`.

- Thinking tokens arrive as `delta.reasoning_content`, answer tokens as `delta.content`, in that order.
- The first chunk carries `delta.role`; the last carries `finish_reason`, `usage` and `meetiq`.
- If the thinking budget runs out, the continuation call streams into the same response: you see reasoning stop and the answer begin.

With the OpenAI SDK:

```ts
const stream = await client.chat.completions.create({ model: 'qwen3.5:4b', messages, stream: true });
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta as { content?: string; reasoning_content?: string };
  if (delta.reasoning_content) process.stderr.write(delta.reasoning_content); // thinking
  if (delta.content) process.stdout.write(delta.content); // answer
}
```

**Limitation:** when `tools` or `response_format` are present the proxy must see the whole output before it can validate it, so the response is buffered and delivered as one content/tool_calls chunk followed by the finish chunk. It is still a valid SSE stream, just not token by token. Plain chat streams token by token.

### Concurrency and limits

- `MAX_PARALLEL` requests run at once; others wait, and waiting past `QUEUE_TIMEOUT_MS` yields **503 `queue_timeout`**. Ollama itself may serialize requests for Qwen3.5's architecture regardless of this setting.
- Request bodies over 2 MB get **413**; prompts over `MAX_PROMPT_TOKENS` get **400 `context_length_exceeded`**.

</details>

## Errors

Always the OpenAI envelope:

```json
{ "error": { "message": "…", "type": "upstream_error", "code": "tool_call_invalid", "details": { … } } }
```

| Status | Code                                                               | When                                                           |
| ------ | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| 400    | `invalid_request_error`, `invalid_json`, `context_length_exceeded` | Validation.                                                    |
| 401    | `invalid_api_key`                                                  | `API_KEY` set and header missing or wrong.                     |
| 413    | `request_too_large`                                                | Body over 2 MB.                                                |
| 499    | `client_closed_request`                                            | Client disconnected while waiting or generating.               |
| 502    | `tool_call_invalid`, `structured_output_invalid`, `upstream_error` | Model output failed validation twice; Ollama returned 4xx/5xx. |
| 503    | `upstream_unavailable`, `queue_timeout`                            | Ollama unreachable; queue wait exceeded.                       |
| 504    | `upstream_timeout`                                                 | Ollama exceeded `UPSTREAM_TIMEOUT_MS`.                         |

## Client

[`src/client/index.ts`](src/client/index.ts) is a dependency-free client to import from another service. It shares only the wire types in [`src/shared/types.ts`](src/shared/types.ts) with the server, so you can copy the two files or reference them as `qwen-proxy/client` and `qwen-proxy/types`.

```ts
import { QwenProxyClient } from 'qwen-proxy/client';

const qwen = new QwenProxyClient({ baseUrl: 'https://ai.example.com', apiKey: process.env.QWEN_API_KEY });

// Schema-validated JSON: `value` matches the schema or the call throws.
const { value } = await qwen.extract<{ decisions: string[] }>(messages, schema);

// Tool loop: your handlers run, results go back, until the model answers.
const { completion } = await qwen.runTools(messages, tools, { search_memory: async ({ query }) => db.search(query) });

// Plain and streaming chat, router dry-run, health.
await qwen.chat({ messages, mode: 'thinking' });
for await (const chunk of qwen.stream({ messages })) process.stdout.write(chunk.choices[0]?.delta.content ?? '');
await qwen.route({ messages });
await qwen.health();
```

Errors are thrown as `QwenProxyError` with `status`, `code` (the proxy's error code such as `tool_call_invalid` or `queue_timeout`), `details`, and `retryAfterSeconds` when the proxy sent `Retry-After`. See [`examples/08-client.ts`](examples/08-client.ts).

## Examples

Runnable versions of everything below live in [`examples/`](examples/README.md).

```bash
curl -s localhost:8000/v1/chat/completions -H 'content-type: application/json' -d '{
  "messages": [{"role":"user","content":"Why did the team decide to postpone the launch?"}]
}'
```

With the OpenAI SDK:

```ts
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://proxy-host:8000/v1', apiKey: process.env.PROXY_API_KEY ?? 'unused' });
const res = await client.chat.completions.create({
  model: 'qwen3.5:4b',
  messages: [{ role: 'user', content: 'Why did revenue drop?' }],
});
```

<details>
<summary>More: streaming, dry-run, tool calls, inspect</summary>

Streaming:

```bash
curl -sN localhost:8000/v1/chat/completions -H 'content-type: application/json' -d '{
  "stream": true,
  "messages": [{"role":"user","content":"Give me three names for a meeting-notes product."}]
}'
```

Dry-run the router:

```bash
curl -s localhost:8000/v1/route -H 'content-type: application/json' -d '{
  "messages": [{"role":"user","content":"Compare the two vendor proposals."}]
}'
```

See exactly what the model would receive, without generating:

```bash
curl -s localhost:8000/v1/inspect -H 'content-type: application/json' -d '{
  "messages": [{"role":"user","content":"Weather in Oslo?"}],
  "tools": [{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false}}}]
}'
```

A tool-call round trip. First call:

```bash
curl -s localhost:8000/v1/chat/completions -H 'content-type: application/json' -d '{
  "messages": [{"role":"user","content":"What was decided about pricing in the last two meetings?"}],
  "tools": [{"type":"function","function":{"name":"search_memory","description":"Search project memory",
    "parameters":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":20}},"required":["query"],"additionalProperties":false}}}]
}'
```

Then send the tool result back:

```bash
curl -s localhost:8000/v1/chat/completions -H 'content-type: application/json' -d '{
  "messages": [
    {"role":"user","content":"What was decided about pricing in the last two meetings?"},
    {"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"search_memory","arguments":"{\"query\":\"pricing decision\",\"limit\":5}"}}]},
    {"role":"tool","tool_call_id":"call_1","content":"[{\"meeting\":\"2026-08-28\",\"text\":\"Agreed: Pro tier at $49, decision final.\"}]"}
  ],
  "tools": [{"type":"function","function":{"name":"search_memory","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}}]
}'
```

</details>

## Running as a service

The proxy owns the Ollama process, so only **one** unit is needed. Do not also enable the packaged `ollama.service`.

```ini
# /etc/systemd/system/qwen-proxy.service
[Unit]
Description=qwen-proxy (OpenAI-compatible proxy + managed Ollama)
After=network-online.target
Wants=network-online.target

[Service]
User=sahil
WorkingDirectory=/home/sahil/qwen-proxy
EnvironmentFile=/home/sahil/qwen-proxy/.env
ExecStart=/usr/bin/bun run src/server/index.ts
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now qwen-proxy
```

## Security note

Bind Ollama to `127.0.0.1` (the default `OLLAMA_BASE_URL` does this) and expose **only this proxy** on the LAN. Ollama has no authentication; the proxy has `API_KEY`, request validation, size and concurrency limits.

## Development

```bash
bun run dev           # bun --watch
bun examples/04-tool-call-round-trip.ts   # runnable use cases, see examples/README.md
bun run typecheck     # strict TypeScript
bun run format        # prettier --write
```

See [AGENTS.md](AGENTS.md) for architecture and conventions.

## Non-goals

No embeddings, no per-request model switching, no persistence, no multi-tenant auth, no application prompt templates.

## License

MIT
