# Examples

Each file is standalone. Start the proxy first (`bun run dev`), then:

```bash
bun examples/01-fast-extraction.ts
```

Set `PROXY_URL` and `API_KEY` if the proxy is not on `http://127.0.0.1:8000` or has a key.

| File                         | Shows                                                                   |
| ---------------------------- | ----------------------------------------------------------------------- |
| `01-fast-extraction.ts`      | `response_format` with a JSON schema, validated output, fast routing.   |
| `02-thinking.ts`             | Explicit thinking mode, `reasoning_content`, the thinking budget.       |
| `03-adaptive-router.ts`      | Which router rule fires for different prompts, via `/v1/route`.         |
| `04-tool-call-round-trip.ts` | Tools, validated `tool_calls`, sending a `tool` result back.            |
| `05-streaming.ts`            | SSE with reasoning and answer deltas.                                   |
| `06-inspect-and-debug.ts`    | `/v1/inspect` and `debug: true`: the exact payloads the model receives. |
| `07-openai-sdk.ts`           | The unmodified OpenAI SDK against the proxy (needs `bun add openai`).   |

`lib.ts` is a 40-line helper around `fetch`; there is no SDK dependency.
