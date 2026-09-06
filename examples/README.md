# Examples

Each file is standalone and uses the importable client in [`../src/client/index.ts`](../src/client/index.ts). Start the proxy first (`bun run dev`), then:

```bash
bun examples/01-fast-extraction.ts
```

Set `PROXY_URL` and `API_KEY` if the proxy is not on `http://127.0.0.1:8000` or has a key:

```bash
PROXY_URL=https://ai.example.com API_KEY=... bun examples/04-tool-call-round-trip.ts
```

| File                         | Shows                                                                 |
| ---------------------------- | --------------------------------------------------------------------- |
| `01-fast-extraction.ts`      | `extract()`: JSON-schema output, validated, fast routing.             |
| `02-thinking.ts`             | Explicit thinking mode, `reasoning_content`, the thinking budget.     |
| `03-adaptive-router.ts`      | `route()`: which router rule fires for different prompts.             |
| `04-tool-call-round-trip.ts` | `runTools()`: tools, handlers, results sent back, final answer.       |
| `05-streaming.ts`            | `stream()`: reasoning and answer deltas as they arrive.               |
| `06-inspect-and-debug.ts`    | `inspect()` and `debug: true`: the exact payloads the model receives. |
| `07-openai-sdk.ts`           | The unmodified OpenAI SDK against the proxy (needs `bun add openai`). |
| `08-errors-and-health.ts`    | `health()` and `QwenProxyError` with proxy status codes.              |
