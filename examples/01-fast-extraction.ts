/**
 * Structured extraction with a JSON schema via `qwen.extract()`. The router
 * picks `fast` (rule 2: response_format without tools); the schema becomes a
 * decoding grammar in Ollama and the output is validated before it reaches
 * you, so `value` always matches the schema.
 *
 *   bun examples/01-fast-extraction.ts
 */
import { line, qwen } from './lib.js';

interface Extraction {
  propositions: string[];
  people: string[];
}

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

const { value, completion } = await qwen.extract<Extraction>(
  [
    { role: 'system', content: 'Extract atomic propositions and the people mentioned. Output JSON only.' },
    { role: 'user', content: text },
  ],
  schema,
);

line('route', `${completion.meetiq.router.mode} (${completion.meetiq.router.rule})`);
line('retries', completion.meetiq.retries);
line('speed', `${completion.meetiq.timing.eval_tps} tok/s`);
console.log(JSON.stringify(value, null, 2));
