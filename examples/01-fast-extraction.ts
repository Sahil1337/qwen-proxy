/**
 * Structured extraction with a JSON schema. The router picks `fast` (rule 2:
 * response_format without tools); the schema becomes a decoding grammar in
 * Ollama and the output is validated with ajv before it reaches you.
 *
 *   bun examples/01-fast-extraction.ts
 */
import { line, MODEL, post } from './lib.js';

const schema = {
  type: 'object',
  properties: {
    propositions: { type: 'array', items: { type: 'string' } },
    people: { type: 'array', items: { type: 'string' } },
  },
  required: ['propositions', 'people'],
};

const text =
  'Priya said the launch moves to March 10 because QA found two blockers. Sahil agreed and will update the roadmap.';

const { body, headers } = await post('/v1/chat/completions', {
  model: MODEL,
  messages: [
    { role: 'system', content: 'Extract atomic propositions and the people mentioned. Output JSON only.' },
    { role: 'user', content: text },
  ],
  response_format: { type: 'json_schema', json_schema: { name: 'extraction', schema } },
  temperature: 0,
});

line('mode', headers.get('x-meetiq-mode'));
line('rule', headers.get('x-meetiq-rule'));
line('retries', body.meetiq.retries);
line('speed', `${body.meetiq.timing.eval_tps} tok/s`);
console.log(JSON.stringify(JSON.parse(body.choices[0].message.content), null, 2));
