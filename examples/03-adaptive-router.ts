/**
 * Adaptive routing. `qwen.route()` returns the decision without generating,
 * so you can see which rule fires for a prompt. The same decision is applied
 * on real requests and reported in `meetiq.router`.
 *
 *   bun examples/03-adaptive-router.ts
 */
import type { ChatRequest } from '../src/client/index.js';
import { qwen } from './lib.js';

const cases: ChatRequest[] = [
  { messages: [{ role: 'user', content: 'Summarise this in one line: launch moved to March.' }] },
  { messages: [{ role: 'user', content: 'Why did the launch move?' }] },
  { messages: [{ role: 'user', content: 'Extract dates.' }], response_format: { type: 'json_object' } },
  {
    messages: [{ role: 'user', content: 'Book a room' }],
    tools: [
      {
        type: 'function',
        function: { name: 'book_room', parameters: { type: 'object', properties: { name: { type: 'string' } } } },
      },
    ],
  },
  { messages: [{ role: 'user', content: 'Why did it fail?' }], mode: 'fast' },
  { messages: [{ role: 'user', content: 'Here is a long transcript. '.repeat(20) + 'Draft the follow-up email.' }] },
];

for (const c of cases) {
  const d = await qwen.route(c);
  const prompt = String(c.messages[0]!.content).slice(0, 48);
  console.log(`${d.mode.padEnd(9)} ${d.rule.padEnd(18)} ${(d.detail ?? '').padEnd(10)} ${prompt}`);
}
