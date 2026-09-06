/**
 * qwen-proxy client — no dependencies, import it from any Bun/Node backend on
 * the LAN. The wire types come from ../shared/types.ts, the same contract the
 * server is checked against.
 *
 *   import { QwenProxyClient } from 'qwen-proxy/client';   // or a relative path
 *   const qwen = new QwenProxyClient({ baseUrl: 'http://proxy-host:8000', apiKey: '...' });
 *
 * It speaks the OpenAI chat-completions shape plus the proxy's extensions
 * (`mode`, `debug`, `meetiq`, `reasoning_content`) and adds two helpers that
 * cover the common workloads: `extract()` for schema-validated JSON and
 * `runTools()` for a tool-calling loop.
 */

import type {
  ChatChunk,
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  ErrorEnvelope,
  Health,
  RouteDecision,
  Tool,
  ToolCall,
} from '../shared/types.js';

export type * from '../shared/types.js';

export class QwenProxyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'QwenProxyError';
  }
}

/** All optional, and `undefined` is accepted so `process.env.X` can be passed straight through. */
export interface ClientOptions {
  /** Default: http://127.0.0.1:8000 */
  baseUrl?: string | undefined;
  /** Sent as `Authorization: Bearer` when the proxy has API_KEY set. */
  apiKey?: string | undefined;
  /** Model id echoed in requests; the proxy serves one model regardless. Default: qwen3.5:4b */
  model?: string | undefined;
  /** Per-request timeout. Default: 10 minutes, matching the proxy's upstream timeout. */
  timeoutMs?: number | undefined;
  /** Sent as `x-request-id` when provided; useful for correlating with proxy logs. */
  requestId?: (() => string) | undefined;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class QwenProxyClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly requestId: (() => string) | undefined;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'qwen3.5:4b';
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.requestId = options.requestId;
  }

  /** One chat completion. */
  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatCompletion> {
    const res = await this.send('/v1/chat/completions', { model: this.model, ...request, stream: false }, signal);
    return (await res.json()) as ChatCompletion;
  }

  /** Streaming chat completion; yields each SSE chunk until `[DONE]`. */
  async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk, void, undefined> {
    const res = await this.send('/v1/chat/completions', { model: this.model, ...request, stream: true }, signal);
    if (!res.body) throw new QwenProxyError(502, 'empty_stream', 'Proxy returned an empty stream');
    for await (const data of sseData(res.body)) {
      const chunk = JSON.parse(data) as ChatChunk & Partial<ErrorEnvelope>;
      if (chunk.error) throw new QwenProxyError(502, chunk.error.code, chunk.error.message, chunk.error.details);
      yield chunk;
    }
  }

  /** Router decision for a request, without generating. */
  async route(request: ChatRequest, signal?: AbortSignal): Promise<RouteDecision> {
    const res = await this.send('/v1/route', { model: this.model, ...request }, signal);
    return (await res.json()) as RouteDecision;
  }

  /** Router decision plus the exact first payload the proxy would send to Ollama. */
  async inspect(request: ChatRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await this.send('/v1/inspect', { model: this.model, ...request }, signal);
    return (await res.json()) as Record<string, unknown>;
  }

  async health(signal?: AbortSignal): Promise<Health> {
    const res = await this.send('/health', undefined, signal, 'GET');
    return (await res.json()) as Health;
  }

  // ------------------------------------------------------------------------
  // Helpers for the two common workloads
  // ------------------------------------------------------------------------

  /**
   * Schema-validated JSON extraction. The proxy constrains decoding to the
   * schema and validates the result, so the returned value matches `schema`.
   */
  async extract<T = unknown>(
    messages: ChatMessage[],
    schema: Record<string, unknown>,
    options: Omit<ChatRequest, 'messages' | 'response_format'> = {},
  ): Promise<{ value: T; completion: ChatCompletion }> {
    const completion = await this.chat({
      temperature: 0,
      ...options,
      messages,
      response_format: { type: 'json_schema', json_schema: { name: 'extraction', schema } },
    });
    const content = completion.choices[0]?.message.content ?? '';
    return { value: JSON.parse(content) as T, completion };
  }

  /**
   * Tool-calling loop: sends `messages` with `tools`, runs each requested
   * tool through `handlers`, appends the results, and repeats until the model
   * answers or `maxHops` is reached. Returns the final completion and the full
   * transcript so you can persist it.
   */
  async runTools(
    messages: ChatMessage[],
    tools: Tool[],
    handlers: Record<string, (args: Record<string, unknown>, call: ToolCall) => Promise<unknown> | unknown>,
    options: Omit<ChatRequest, 'messages' | 'tools'> & {
      maxHops?: number;
      onToolCall?: (call: ToolCall, result: unknown) => void;
    } = {},
  ): Promise<{ completion: ChatCompletion; messages: ChatMessage[]; hops: number }> {
    const { maxHops = 5, onToolCall, ...chatOptions } = options;
    const transcript = [...messages];
    let hops = 0;
    for (;;) {
      const completion = await this.chat({ ...chatOptions, messages: transcript, tools });
      const choice = completion.choices[0]!;
      const calls = choice.message.tool_calls ?? [];
      if (choice.finish_reason !== 'tool_calls' || calls.length === 0 || hops >= maxHops) {
        return { completion, messages: transcript, hops };
      }
      hops++;
      transcript.push({ role: 'assistant', content: choice.message.content, tool_calls: calls });
      for (const call of calls) {
        const handler = handlers[call.function.name];
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        const result = handler ? await handler(args, call) : { error: `no handler for tool "${call.function.name}"` };
        onToolCall?.(call, result);
        transcript.push({
          role: 'tool',
          tool_call_id: call.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
    }
  }

  // ------------------------------------------------------------------------

  private async send(path: string, body: unknown, signal?: AbortSignal, method = 'POST'): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
    if (this.requestId) headers['x-request-id'] = this.requestId();

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (timeout.aborted)
        throw new QwenProxyError(504, 'client_timeout', `No response from ${this.baseUrl} within ${this.timeoutMs} ms`);
      if (signal?.aborted) throw err;
      throw new QwenProxyError(
        503,
        'proxy_unreachable',
        `Cannot reach qwen-proxy at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.ok) return res;

    let envelope: Partial<ErrorEnvelope> = {};
    try {
      envelope = (await res.json()) as typeof envelope;
    } catch {
      // Non-JSON error body; fall back to the status line.
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new QwenProxyError(
      res.status,
      envelope.error?.code ?? `http_${res.status}`,
      envelope.error?.message ?? `qwen-proxy responded with HTTP ${res.status}`,
      envelope.error?.details,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
}

/** Splits an SSE body into the `data:` payloads, stopping at `[DONE]`. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 2);
      if (!event.startsWith('data: ')) continue;
      const data = event.slice('data: '.length);
      if (data === '[DONE]') return;
      yield data;
    }
  }
}
