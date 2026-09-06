import type { Ajv } from 'ajv';
import { invalidRequest } from './errors.js';
import type { Tool, ToolChoice } from './mapping.js';
import type { ToolCall } from '../../shared/types.js';
import type { OllamaMessage, OllamaToolCall } from './ollama.js';
import { splitThink } from './thinking.js';
import { newToolCallId } from '../util/ids.js';

// ---------------------------------------------------------------------------
// Schema slimming: what the model reads vs. what we validate against
// ---------------------------------------------------------------------------

/** Keywords that constrain validation but give the model nothing useful to read. */
const PROMPT_NOISE_KEYS = new Set([
  'additionalProperties',
  'unevaluatedProperties',
  'strict',
  '$schema',
  '$id',
  '$comment',
  'title',
  'examples',
]);
/** Keywords whose values are maps of name -> schema (the map keys must be preserved verbatim). */
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

/**
 * Returns a copy of a JSON schema with keywords the model does not need
 * removed at every level. Tool definitions are rendered into the prompt, so
 * every keyword costs context tokens on every request; validation still
 * uses the full schema.
 */
export function slimSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(slimSchema);
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (PROMPT_NOISE_KEYS.has(key)) continue;
    if (SCHEMA_MAP_KEYS.has(key) && isRecord(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, slimSchema(sub)]));
    } else {
      out[key] = slimSchema(value);
    }
  }
  return out;
}

export function slimTools(tools: Tool[]): Tool[] {
  return tools.map((t) => ({
    ...t,
    function: {
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      ...(t.function.parameters ? { parameters: slimSchema(t.function.parameters) as Record<string, unknown> } : {}),
    },
  }));
}

// ---------------------------------------------------------------------------
// Prompt injection (Hermes format, exactly what Qwen is trained on)
// ---------------------------------------------------------------------------

export function renderToolsBlock(tools: Tool[]): string {
  const signatures = tools
    .map((t) =>
      JSON.stringify({
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description ?? '',
          parameters: t.function.parameters ?? { type: 'object', properties: {} },
        },
      }),
    )
    .join('\n');
  return [
    '# Tools',
    'You may call one or more functions to assist with the user query.',
    'You are provided with function signatures within <tools></tools> XML tags:',
    '<tools>',
    signatures,
    '</tools>',
    'For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:',
    '<tool_call>',
    '{"name": <function-name>, "arguments": <args-json-object>}',
    '</tool_call>',
  ].join('\n');
}

/** Prepends the tools block to the first system message, or creates one. */
export function injectTools(messages: OllamaMessage[], tools: Tool[]): OllamaMessage[] {
  const block = renderToolsBlock(tools);
  const index = messages.findIndex((m) => m.role === 'system');
  if (index === -1) return [{ role: 'system', content: block }, ...messages];
  return messages.map((m, i) => (i === index ? { ...m, content: `${block}\n\n${m.content}` } : m));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParseResult {
  /** Text before the first tool call, or null when the output starts with one. */
  content: string | null;
  calls: ParsedToolCall[];
  /** Blocks that were found but could not be turned into a call. */
  errors: string[];
}

const BLOCK_RE = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;

/**
 * Extracts `<tool_call>` blocks from model output. Tolerates prose around the
 * blocks, several blocks, a missing closing tag at end of output, and JSON
 * that needs one lenient repair. Anything inside `<think>` is ignored.
 */
export function parseToolCalls(text: string): ParseResult {
  const visible = splitThink(text).content;
  const result: ParseResult = { content: null, calls: [], errors: [] };
  const first = visible.indexOf('<tool_call>');
  if (first === -1) {
    result.content = visible.trim() || null;
    return result;
  }
  result.content = visible.slice(0, first).trim() || null;

  for (const match of visible.slice(first).matchAll(BLOCK_RE)) {
    const raw = (match[1] ?? '').trim();
    if (!raw) continue;
    try {
      result.calls.push(toParsedCall(parseJsonLenient(raw)));
    } catch (err) {
      result.errors.push(`${err instanceof Error ? err.message : String(err)} in: ${raw}`);
    }
  }
  return result;
}

function toParsedCall(value: unknown): ParsedToolCall {
  if (!isRecord(value) || typeof value['name'] !== 'string') {
    throw new Error('tool call must be an object with a string "name"');
  }
  const args = value['arguments'] ?? value['parameters'] ?? {};
  if (!isRecord(args)) throw new Error('"arguments" must be a JSON object');
  return { name: value['name'], arguments: args };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return repairJson(text);
  }
}

/** One best-effort repair pass: code fences, trailing commas, Python literals, single quotes. */
export function repairJson(text: string): unknown {
  let t = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  t = t.replace(/,\s*([}\]])/g, '$1');
  t = t.replace(/\b(True|False|None)\b/g, (m) => ({ True: 'true', False: 'false', None: 'null' })[m] ?? m);
  try {
    return JSON.parse(t);
  } catch {
    // Fall through to quote repair.
  }
  const requoted = t.includes('"')
    ? t.replace(/'((?:[^'\\]|\\.)*)'/g, (_, s: string) => `"${s.replace(/"/g, '\\"')}"`)
    : t.replace(/'/g, '"');
  return JSON.parse(requoted);
}

export function fromNativeToolCalls(native: OllamaToolCall[]): ParseResult {
  const result: ParseResult = { content: null, calls: [], errors: [] };
  for (const call of native) {
    try {
      const args =
        typeof call.function.arguments === 'string'
          ? parseJsonLenient(call.function.arguments)
          : call.function.arguments;
      result.calls.push(toParsedCall({ name: call.function.name, arguments: args }));
    } catch (err) {
      result.errors.push(`${err instanceof Error ? err.message : String(err)} in native call ${call.function.name}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const EMPTY_OBJECT_SCHEMA = { type: 'object' };

export function validateToolCalls(calls: ParsedToolCall[], tools: Tool[], ajv: Ajv): string[] {
  const errors: string[] = [];
  for (const call of calls) {
    const tool = tools.find((t) => t.function.name === call.name);
    if (!tool) {
      errors.push(`unknown tool "${call.name}"; available: ${tools.map((t) => t.function.name).join(', ')}`);
      continue;
    }
    const validate = ajv.compile(tool.function.parameters ?? EMPTY_OBJECT_SCHEMA);
    if (!validate(call.arguments)) errors.push(`${call.name}: ${ajv.errorsText(validate.errors)}`);
  }
  return errors;
}

export function toOpenAIToolCalls(calls: ParsedToolCall[]): ToolCall[] {
  return calls.map((c) => ({
    id: newToolCallId(),
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.arguments) },
  }));
}

// ---------------------------------------------------------------------------
// Forced mode (constrained decoding)
// ---------------------------------------------------------------------------

export const isForcedChoice = (choice: ToolChoice | undefined): boolean =>
  choice === 'required' || (typeof choice === 'object' && choice.type === 'function');

function schemaForTool(tool: Tool): Record<string, unknown> {
  return {
    type: 'object',
    properties: { name: { const: tool.function.name }, arguments: tool.function.parameters ?? EMPTY_OBJECT_SCHEMA },
    required: ['name', 'arguments'],
    additionalProperties: false,
  };
}

/** JSON schema handed to Ollama's `format` so the model can only emit a valid call. */
export function forcedToolFormat(tools: Tool[], choice: ToolChoice): Record<string, unknown> {
  if (typeof choice === 'object') {
    const tool = tools.find((t) => t.function.name === choice.function.name);
    if (!tool) throw invalidRequest(`tool_choice names unknown tool "${choice.function.name}"`);
    return schemaForTool(tool);
  }
  const first = tools[0];
  if (tools.length === 1 && first) return schemaForTool(first);
  return { oneOf: tools.map(schemaForTool) };
}

export function parseForcedOutput(content: string): ParseResult {
  try {
    return { content: null, calls: [toParsedCall(parseJsonLenient(content))], errors: [] };
  } catch (err) {
    return { content: null, calls: [], errors: [`${err instanceof Error ? err.message : String(err)} in: ${content}`] };
  }
}
