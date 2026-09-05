/**
 * Adaptive routing. `POST /v1/route` returns the decision without generating,
 * so you can see which rule fires for a prompt. The same decision is applied
 * on real requests and reported in the `x-meetiq-mode` / `x-meetiq-rule`
 * headers and `meetiq.router`.
 *
 *   bun examples/03-adaptive-router.ts
 */
import { MODEL, post } from './lib.js';

const cases: Array<Record<string, unknown>> = [
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
  { messages: [{ role: 'user', content: 'Why did it fail?' }], reasoning_effort: 'none' },
  { messages: [{ role: 'user', content: 'Here is a long transcript. '.repeat(20) + 'Draft the follow-up email.' }] },
];

for (const c of cases) {
  const { body } = await post('/v1/route', { model: MODEL, ...c });
  const prompt = String((c.messages as any)[0].content).slice(0, 48);
  console.log(`${body.mode.padEnd(9)} ${body.rule.padEnd(18)} ${(body.detail ?? '').padEnd(10)} ${prompt}`);
}
