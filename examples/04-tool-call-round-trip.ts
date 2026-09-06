/**
 * Tool calling with `qwen.runTools()`: define tools and a handler per tool.
 * The client sends the request, runs the handlers the model asks for, feeds
 * the results back as `tool` messages, and repeats until the model answers.
 * Arguments are guaranteed to match each tool's JSON schema.
 *
 *   bun examples/04-tool-call-round-trip.ts
 */
import type { Tool } from '../src/client/index.js';
import { line, qwen } from './lib.js';

const tools: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search past meeting notes and decisions.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
        required: ['query'],
      },
    },
  },
];

const { completion, messages, hops } = await qwen.runTools(
  [
    { role: 'system', content: 'Use tools when the answer depends on past meetings. Be concise.' },
    { role: 'user', content: 'What did we decide about pricing, and when?' },
  ],
  tools,
  {
    // Your real implementation would query a database or vector store.
    search_memory: ({ query }) => [
      { date: '2026-08-28', text: 'Agreed: Pro tier at $49/month. Decision final.' },
      { date: '2026-09-02', text: `Launch moved to March 10 after QA found two blockers. (query: ${query})` },
    ],
  },
  {
    onToolCall: (call, result) =>
      line('tool', `${call.function.name}(${call.function.arguments}) -> ${JSON.stringify(result)}`),
  },
);

line('hops', hops);
line('tool_parse', completion.meetiq.tool_parse);
line('transcript', `${messages.length} messages`);
console.log('\n' + completion.choices[0]!.message.content);
