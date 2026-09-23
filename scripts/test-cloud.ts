/**
 * Connectivity check for whatever `PROXY_BASE_URL` points at — the local proxy,
 * or a hosted OpenAI-compatible endpoint. Exercises the two calls the rest of
 * the system depends on: a plain completion and a schema-constrained one.
 *
 *   bun run test:cloud
 *   PROXY_BASE_URL=https://api.groq.com/openai PROXY_API_KEY=gsk_... PROXY_MODEL=llama-3.3-70b-versatile bun run test:cloud
 *
 * Config comes from `scripts/.env` (see `.env.example`) or the real environment.
 * Bun loads `.env` from the working directory only, and `bun run test:cloud`
 * runs with `scripts/` as the working directory — a `.env` at the repository
 * root is not read. Same variable names as `apps/api/.env`, separate file.
 */

import { QwenProxyClient } from "qwen-proxy/client";

// Same defaults as examples/lib.ts. Point them at the proxy with
// PROXY_BASE_URL=http://127.0.0.1:8000 PROXY_MODEL=qwen3.5:4b.
const baseUrl = process.env.PROXY_BASE_URL ?? "https://api.groq.com/openai";
const apiKey = process.env.PROXY_API_KEY;
const model = process.env.PROXY_MODEL ?? "llama-3.3-70b-versatile";

console.log(`base url   ${baseUrl}`);
console.log(`model      ${model}`);
console.log(`api key    ${apiKey ? `${apiKey.slice(0, 8)}…` : "(none)"}\n`);

const client = new QwenProxyClient({ baseUrl, apiKey, model, timeoutMs: 60_000 });

const LINE = "Yash said he will finish the DB schema by Friday.";

try {
  console.log("1. chat()");
  const completion = await client.chat({
    messages: [
      { role: "system", content: "You are a concise assistant." },
      { role: "user", content: `Summarise in one sentence: ${LINE}` },
    ],
  });
  console.log(`   ${completion.choices[0]?.message.content}`);
  console.log(`   tokens in=${completion.usage.prompt_tokens} out=${completion.usage.completion_tokens}\n`);

  console.log("2. extract()");
  const { value } = await client.extract<{ person: string; task: string; deadline: string }>(
    [{ role: "user", content: LINE }],
    {
      type: "object",
      properties: {
        person: { type: "string" },
        task: { type: "string" },
        deadline: { type: "string" },
      },
      required: ["person", "task", "deadline"],
      additionalProperties: false,
    },
  );
  console.log(`   ${JSON.stringify(value)}\n`);

  console.log("both calls passed.");
} catch (err) {
  console.error("\nfailed:", err);
  process.exit(1);
}
