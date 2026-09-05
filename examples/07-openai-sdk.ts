/**
 * The official OpenAI SDK works unchanged; proxy extensions are extra fields
 * the SDK passes through. Install it first:
 *
 *   bun add openai
 *   bun examples/07-openai-sdk.ts
 */
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: `${process.env.PROXY_URL ?? 'http://127.0.0.1:8000'}/v1`,
  apiKey: process.env.API_KEY ?? 'unused',
});

const completion = await client.chat.completions.create({
  model: 'qwen3.5:4b',
  messages: [{ role: 'user', content: 'Why do meetings overrun? Two sentences.' }],
  // Proxy extension; the SDK forwards unknown fields.
  ...({ mode: 'adaptive' } as object),
});
const message = completion.choices[0]!.message as { content: string | null; reasoning_content?: string };
console.log('reasoning:', message.reasoning_content?.slice(0, 200) ?? '(none)');
console.log('answer:', message.content);

const stream = await client.chat.completions.create({
  model: 'qwen3.5:4b',
  messages: [{ role: 'user', content: 'Name three risks of shipping on a Friday.' }],
  stream: true,
});
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta as { content?: string; reasoning_content?: string };
  if (delta.content) process.stdout.write(delta.content);
}
console.log();
