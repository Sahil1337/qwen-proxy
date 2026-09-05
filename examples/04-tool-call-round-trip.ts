/**
 * Tool calling, end to end: define tools, get a validated `tool_calls` array,
 * run the tool yourself, send the result back as a `tool` message, and get the
 * final answer. Arguments are guaranteed to match the tool's JSON schema.
 *
 *   bun examples/04-tool-call-round-trip.ts
 */
import { line, MODEL, post } from './lib.js';

const tools = [
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

// Your real implementation would query a database or vector store.
const searchMemory = (args: { query: string; limit?: number }) => [
  { date: '2026-08-28', text: 'Agreed: Pro tier at $49/month. Decision final.' },
  { date: '2026-09-02', text: `Launch moved to March 10 after QA found two blockers. (query: ${args.query})` },
];

const messages: any[] = [
  { role: 'system', content: 'Use tools when the answer depends on past meetings. Be concise.' },
  { role: 'user', content: 'What did we decide about pricing, and when?' },
];

const first = await post('/v1/chat/completions', { model: MODEL, messages, tools });
const reply = first.body.choices[0].message;
line('finish', first.body.choices[0].finish_reason);
line('tool_parse', first.body.meetiq.tool_parse);

if (first.body.choices[0].finish_reason !== 'tool_calls') {
  console.log('answered without tools:', reply.content);
  process.exit(0);
}

messages.push(reply); // the assistant turn with tool_calls, as returned
for (const call of reply.tool_calls) {
  const args = JSON.parse(call.function.arguments);
  line('tool call', `${call.function.name}(${call.function.arguments})`);
  const result = searchMemory(args);
  messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
}

const second = await post('/v1/chat/completions', { model: MODEL, messages, tools });
console.log('\n' + second.body.choices[0].message.content);
