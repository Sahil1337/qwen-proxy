import { z } from 'zod';
import type { Config } from '../config.js';
import { invalidRequest } from './errors.js';
import type { OllamaMessage, OllamaOptions } from './ollama.js';
import { estimateJsonTokens, estimateTokens } from '../util/tokens.js';

// ---------------------------------------------------------------------------
// OpenAI request schema (unknown fields are kept so SDK extras never 400)
// ---------------------------------------------------------------------------

const contentPartSchema = z.looseObject({ type: z.string(), text: z.string().optional() });

const messageToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const messageSchema = z.looseObject({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(messageToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});

export const toolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
]);

const responseFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string().optional(),
      schema: z.record(z.string(), z.unknown()),
      strict: z.boolean().optional(),
    }),
  }),
]);

export const MODES = ['thinking', 'fast', 'adaptive'] as const;

export const chatRequestSchema = z.looseObject({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  tools: z.array(toolSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  response_format: responseFormatSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  stream: z.boolean().optional(),
  seed: z.number().int().optional(),
  /** Proxy extension. */
  mode: z.enum(MODES).optional(),
  /** OpenAI field, accepted as an alias: 'none' -> fast, anything else -> thinking. */
  reasoning_effort: z.string().optional(),
  /** Proxy extension: include the exact upstream Ollama payloads in `meetiq.upstream_requests`. */
  debug: z.boolean().optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type Tool = z.infer<typeof toolSchema>;
export type ToolChoice = z.infer<typeof toolChoiceSchema>;
export type ResponseFormat = z.infer<typeof responseFormatSchema>;
export type RequestedMode = (typeof MODES)[number];

export function parseChatRequest(body: unknown): ChatRequest {
  const result = chatRequestSchema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    throw invalidRequest(`Invalid request: ${issues.join('; ')}`, issues);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function messageText(content: ChatMessage['content']): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      if (part.type !== 'text' || typeof part.text !== 'string') {
        throw invalidRequest(`Unsupported content part type "${part.type}"; only text is supported`);
      }
      return part.text;
    })
    .join('\n');
}

export function renderToolCallBlock(name: string, args: unknown): string {
  return `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;
}

function parseArgsForRender(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * OpenAI transcript -> Ollama transcript.
 *  - `developer` becomes `system`.
 *  - assistant `tool_calls` are re-rendered as `<tool_call>` text.
 *  - `tool` results become user messages wrapped in `<tool_response>`.
 * Order is preserved so the model sees one consistent Hermes-style history.
 */
export function toOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  return messages.map((m): OllamaMessage => {
    const text = messageText(m.content);
    switch (m.role) {
      case 'system':
      case 'developer':
        return { role: 'system', content: text };
      case 'user':
        return { role: 'user', content: text };
      case 'tool':
        return { role: 'user', content: `<tool_response>\n${text}\n</tool_response>` };
      case 'assistant': {
        if (!m.tool_calls?.length) return { role: 'assistant', content: text };
        const blocks = m.tool_calls.map((c) =>
          renderToolCallBlock(c.function.name, parseArgsForRender(c.function.arguments)),
        );
        const content = text ? `${text}\n${blocks.join('\n')}` : blocks.join('\n');
        return { role: 'assistant', content };
      }
    }
  });
}

export function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') return messageText(m.content);
  }
  return '';
}

export function estimatePromptTokens(req: ChatRequest): number {
  const messageTokens = req.messages.reduce((sum, m) => {
    const callText = m.tool_calls ? JSON.stringify(m.tool_calls) : '';
    return sum + estimateTokens(messageText(m.content) + callText);
  }, 0);
  return messageTokens + estimateJsonTokens(req.tools) + estimateJsonTokens(req.response_format);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options that must be identical on every call (including the router's
 * classifier), otherwise Ollama reloads the model between requests.
 */
export function baseOptions(config: Config): OllamaOptions {
  return { num_ctx: config.NUM_CTX, ...(config.NUM_GPU >= 0 ? { num_gpu: config.NUM_GPU } : {}) };
}

export function requestOptions(req: ChatRequest, config: Config): OllamaOptions {
  const options: OllamaOptions = baseOptions(config);
  if (req.temperature !== undefined) options.temperature = req.temperature;
  if (req.top_p !== undefined) options.top_p = req.top_p;
  if (req.seed !== undefined) options.seed = req.seed;
  if (req.stop !== undefined) options.stop = Array.isArray(req.stop) ? req.stop : [req.stop];
  return options;
}

export function resolveMaxTokens(req: ChatRequest, config: Config): number {
  return req.max_tokens ?? req.max_completion_tokens ?? config.DEFAULT_MAX_TOKENS;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type FinishReason = 'stop' | 'length' | 'tool_calls';
export type ToolParse = 'native' | 'fallback' | 'forced' | 'none';

export interface ToolCallOut {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details: { reasoning_tokens: number };
}

/** Proxy-specific metadata, exposed under the `meetiq` key the OpenAI SDK ignores. */
export interface ProxyMeta {
  router: { mode: 'fast' | 'thinking'; rule: string; detail?: string };
  mode_requested: RequestedMode | null;
  mode_used: 'fast' | 'thinking';
  tool_parse: ToolParse;
  think_budget_hit: boolean;
  retries: number;
  upstream_calls: number;
  upstream_ms: number;
  /** From Ollama's own counters. `load_ms > 0` means the model was (re)loaded for this request. */
  timing: { load_ms: number; prompt_eval_ms: number; eval_ms: number; eval_tps: number };
  /** Present only when the request had `debug: true`: the exact payloads sent to Ollama. */
  upstream_requests?: unknown[];
}

export interface CompletionParts {
  id: string;
  created: number;
  model: string;
  content: string | null;
  reasoning: string | null;
  toolCalls: ToolCallOut[];
  finishReason: FinishReason;
  usage: Usage;
  meta: ProxyMeta;
}

export function buildCompletion(p: CompletionParts) {
  return {
    id: p.id,
    object: 'chat.completion' as const,
    created: p.created,
    model: p.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant' as const,
          content: p.content,
          ...(p.reasoning ? { reasoning_content: p.reasoning } : {}),
          ...(p.toolCalls.length ? { tool_calls: p.toolCalls } : {}),
        },
        finish_reason: p.finishReason,
        logprobs: null,
      },
    ],
    usage: p.usage,
    meetiq: p.meta,
  };
}

export interface ChunkDelta {
  role?: 'assistant';
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<ToolCallOut & { index: number }>;
}

export function buildChunk(p: {
  id: string;
  created: number;
  model: string;
  delta: ChunkDelta;
  finishReason?: FinishReason | null;
  usage?: Usage;
  meta?: ProxyMeta;
}) {
  return {
    id: p.id,
    object: 'chat.completion.chunk' as const,
    created: p.created,
    model: p.model,
    choices: [{ index: 0, delta: p.delta, finish_reason: p.finishReason ?? null, logprobs: null }],
    ...(p.usage ? { usage: p.usage } : {}),
    ...(p.meta ? { meetiq: p.meta } : {}),
  };
}
