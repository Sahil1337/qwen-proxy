/**
 * See exactly what reaches the model. `POST /v1/inspect` returns the first
 * upstream payload without generating (note the slimmed tool schema); adding
 * `debug: true` to a real request returns every payload that was sent,
 * including retries and the thinking continuation.
 *
 *   bun examples/06-inspect-and-debug.ts
 */
import { MODEL, post } from './lib.js';

const request = {
  model: MODEL,
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

const inspect = await post('/v1/inspect', request);
console.log('--- /v1/inspect');
console.log(JSON.stringify(inspect.body, null, 2));

const real = await post('/v1/chat/completions', { ...request, debug: true });
console.log('\n--- meetiq.upstream_requests (what was actually sent)');
console.log(JSON.stringify(real.body.meetiq.upstream_requests, null, 2));
