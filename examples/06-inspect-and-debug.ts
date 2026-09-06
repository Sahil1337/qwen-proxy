/**
 * See exactly what reaches the model. `qwen.inspect()` returns the first
 * upstream payload without generating (note the slimmed tool schema); adding
 * `debug: true` to a real request returns every payload that was sent,
 * including retries and the thinking continuation.
 *
 *   bun examples/06-inspect-and-debug.ts
 */
import type { ChatRequest } from '../src/client/index.js';
import { qwen } from './lib.js';

const request: ChatRequest = {
  messages: [{ role: 'user', content: 'What is the weather in Oslo?' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Current weather for a city',
        parameters: {
          type: 'object',
          title: 'WeatherArgs',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
      },
    },
  ],
};

console.log('--- inspect (nothing generated)');
console.log(JSON.stringify(await qwen.inspect(request), null, 2));

const completion = await qwen.chat({ ...request, debug: true });
console.log('\n--- meetiq.upstream_requests (what was actually sent)');
console.log(JSON.stringify(completion.meetiq.upstream_requests, null, 2));
