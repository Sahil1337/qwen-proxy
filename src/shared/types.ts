/**
 * Wire contract between qwen-proxy and its clients: the OpenAI chat-completions
 * shape the server implements, plus the proxy's extensions. Types only, no
 * runtime code. The server's validators and response builders are checked
 * against these types; the client is written in terms of them.
 *
 * Request-side shapes are type aliases (not interfaces) so they stay
 * assignable to the server's permissive zod input types.
 */

export type Role = 'system' | 'developer' | 'user' | 'assistant' | 'tool';
export type Mode = 'fast' | 'thinking' | 'adaptive';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ContentPart = { type: 'text'; text: string };

export type ChatMessage = {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type Tool = {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
};

export type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name?: string; schema: Record<string, unknown>; strict?: boolean } };

export type ChatRequest = {
  /** Ignored: the proxy serves one model. Kept for OpenAI SDK compatibility. */
  model?: string;
  messages: ChatMessage[];
  tools?: Tool[];
  tool_choice?: ToolChoice;
  response_format?: ResponseFormat;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  seed?: number;
  stream?: boolean;
  /** Proxy extension: overrides the server's DEFAULT_MODE. */
  mode?: Mode;
  /** OpenAI field accepted as an alias: 'none' -> fast, anything else -> thinking. */
  reasoning_effort?: string;
  /** Proxy extension: include the exact upstream payloads in `meetiq.upstream_requests`. */
  debug?: boolean;
};

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type FinishReason = 'stop' | 'length' | 'tool_calls';
export type ToolParse = 'native' | 'fallback' | 'forced' | 'none';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details: { reasoning_tokens: number };
}

/** Proxy-specific metadata, under the `meetiq` key the OpenAI SDK ignores. */
export interface ProxyMeta {
  router: { mode: 'fast' | 'thinking'; rule: string; detail?: string };
  mode_requested: Mode | null;
  mode_used: 'fast' | 'thinking';
  tool_parse: ToolParse;
  think_budget_hit: boolean;
  retries: number;
  upstream_calls: number;
  upstream_ms: number;
  /** Ollama's own counters. `load_ms > 0` means the model was (re)loaded for this request. */
  timing: { load_ms: number; prompt_eval_ms: number; eval_ms: number; eval_tps: number };
  /** Present only when the request had `debug: true`. */
  upstream_requests?: unknown[];
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: number; message: AssistantMessage; finish_reason: FinishReason; logprobs: null }>;
  usage: Usage;
  meetiq: ProxyMeta;
}

export interface ChunkDelta {
  role?: 'assistant';
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<ToolCall & { index: number }>;
}

export interface ChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{ index: number; delta: ChunkDelta; finish_reason: FinishReason | null; logprobs: null }>;
  usage?: Usage;
  meetiq?: ProxyMeta;
}

export interface RouteDecision {
  mode: 'fast' | 'thinking';
  rule: string;
  detail?: string;
  mode_requested: Mode | null;
  default_mode: Mode;
  estimated_prompt_tokens: number;
  last_user_tokens: number;
}

export interface Health {
  status: 'ok' | 'degraded';
  ollama: { reachable: boolean; version: string | null; managed: boolean; pid: number | null };
  model: { name: string; loaded: boolean; size_vram: number | null; context_length: number | null };
  queue: { waiting: number; running: number; concurrency: number };
}

export interface ErrorEnvelope {
  error: { message: string; type: string; code: string; details?: unknown };
}
