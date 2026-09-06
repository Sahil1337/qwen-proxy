/**
 * The same workloads through the importable client (client/index.ts):
 * schema extraction, a tool-calling loop, and streaming.
 *
 *   bun examples/08-client.ts
 */
import { QwenProxyClient } from '../client/index.js';

const qwen = new QwenProxyClient({ baseUrl: process.env.PROXY_URL, apiKey: process.env.API_KEY });

// 1. Schema-validated extraction: `value` is guaranteed to match the schema.
const { value, completion } = await qwen.extract<{ decisions: string[] }>(
  [{ role: 'user', content: 'Extract decisions: We agreed on a $49 Pro tier and moved the launch to March 10.' }],
  { type: 'object', properties: { decisions: { type: 'array', items: { type: 'string' } } }, required: ['decisions'] },
);
console.log('decisions:', value.decisions, `(${completion.meetiq.timing.eval_tps} tok/s)`);

// 2. Tool loop: the client runs your handlers and feeds results back until the model answers.
const { completion: answer, hops } = await qwen.runTools(
  [{ role: 'user', content: 'What did we decide about pricing?' }],
  [
    {
      type: 'function',
      function: {
        name: 'search_memory',
        description: 'Search past meeting notes.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    },
  ],
  {
    search_memory: ({ query }) => [{ date: '2026-08-28', text: `Agreed: Pro tier at $49/month. (for "${query}")` }],
  },
  { onToolCall: (call, result) => console.log(`tool ${call.function.name} ->`, JSON.stringify(result)) },
);
console.log(`answer after ${hops} hop(s):`, answer.choices[0]?.message.content);

// 3. Streaming: reasoning and answer tokens as they arrive.
process.stdout.write('\nstream: ');
for await (const chunk of qwen.stream({
  messages: [{ role: 'user', content: 'One sentence: why cache?' }],
  mode: 'fast',
})) {
  const delta = chunk.choices[0]?.delta;
  if (delta?.content) process.stdout.write(delta.content);
}
console.log();
