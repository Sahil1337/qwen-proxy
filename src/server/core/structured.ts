import type { Ajv } from 'ajv';
import type { ResponseFormat } from './mapping.js';
import type { OllamaFormat } from './ollama.js';
import { parseJsonLenient } from './tools.js';

export function resolveFormat(rf: ResponseFormat | undefined): OllamaFormat | undefined {
  if (!rf || rf.type === 'text') return undefined;
  if (rf.type === 'json_object') return 'json';
  return rf.json_schema.schema;
}

export type StructuredCheck = { ok: true; value: unknown } | { ok: false; error: string };

export function validateStructuredOutput(content: string, rf: ResponseFormat, ajv: Ajv): StructuredCheck {
  let value: unknown;
  try {
    value = parseJsonLenient(content);
  } catch (err) {
    return { ok: false, error: `output is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (rf.type !== 'json_schema') return { ok: true, value };
  const validate = ajv.compile(rf.json_schema.schema);
  if (validate(value)) return { ok: true, value };
  return { ok: false, error: ajv.errorsText(validate.errors) };
}
