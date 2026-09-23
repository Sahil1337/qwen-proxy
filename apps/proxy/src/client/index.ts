/**
 * qwen-proxy client — no dependencies, import it from any Bun/Node backend on
 * the LAN. The wire types come from ../shared/types.ts, the same contract the
 * server is checked against.
 *
 *   import { QwenProxyClient } from 'qwen-proxy/client';   // or a relative path
 *   const qwen = new QwenProxyClient({ baseUrl: 'http://proxy-host:8000', apiKey: '...' });
 *
 * It speaks the OpenAI chat-completions shape plus the proxy's extensions
 * (`mode`, `debug`, `meetiq`, `reasoning_content`) and adds four helpers that
 * cover the common workloads: `extract()`/`extractStream()` for schema-validated
 * JSON, `runTools()` for a tool-calling loop that ends in plain text, and
 * `runToolsUntil()` for a loop that ends by calling a designated "final" tool
 * (for when the answer itself must be schema-shaped but the model also needs
 * other tools along the way — response_format can't be combined with tools).
 */

import type {
  ChatChunk,
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  ErrorEnvelope,
  FinishReason,
  Health,
  ProxyMeta,
  RouteDecision,
  Tool,
  ToolCall,
  ToolChoice,
  Usage,
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
  /**
   * The host to call, minus the `/v1`. The proxy, or any other
   * OpenAI-compatible endpoint: `https://api.groq.com/openai`,
   * `https://openrouter.ai/api`, `https://api.openai.com`.
   * Default: http://127.0.0.1:8000
   */
  baseUrl?: string | undefined;
  /** Sent as `Authorization: Bearer` when the proxy has API_KEY set, or always against a hosted provider. */
  apiKey?: string | undefined;
  /**
   * Model id sent with every request. The proxy serves one model and ignores
   * it; a hosted provider needs the real name. Default: qwen3.5:4b
   */
  model?: string | undefined;
  /** Per-request timeout. Default: 10 minutes, matching the proxy's upstream timeout. */
  timeoutMs?: number | undefined;
  /** Sent as `x-request-id` when provided; useful for correlating with proxy logs. */
  requestId?: (() => string) | undefined;
}

/**
 * `meetiq` is this proxy's own extension and `usage` is optional on streamed
 * chunks, so neither is guaranteed when `baseUrl` points at another
 * OpenAI-compatible endpoint (Groq, OpenRouter, OpenAI itself). Both are filled
 * in with these rather than left undefined, so callers can read
 * `completion.usage` and `completion.meetiq` without branching on the host.
 * `router.rule` is `'upstream'` to mark a completion the proxy did not produce.
 */
const EMPTY_USAGE: Usage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  completion_tokens_details: { reasoning_tokens: 0 },
};

const UPSTREAM_META: ProxyMeta = {
  router: { mode: 'fast', rule: 'upstream' },
  mode_requested: null,
  mode_used: 'fast',
  tool_parse: 'native',
  retries: 0,
  upstream_calls: 1,
  upstream_ms: 0,
  timing: { load_ms: 0, prompt_eval_ms: 0, eval_ms: 0, eval_tps: 0 },
};

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

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatCompletion> {
    const res = await this.send('/v1/chat/completions', { model: this.model, ...request, stream: false }, signal);
    const completion = (await res.json()) as ChatCompletion;
    return { ...completion, usage: completion.usage ?? EMPTY_USAGE, meetiq: completion.meetiq ?? UPSTREAM_META };
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

  // Helpers for the two common workloads

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
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'extraction', schema },
      },
    });
    const content = completion.choices[0]?.message.content ?? '';
    return { value: JSON.parse(content) as T, completion };
  }

  /**
   * Same contract as `extract()`, over the streaming endpoint. `onChunk` fires
   * for every SSE chunk as it arrives; the returned `completion` is assembled
   * from the accumulated deltas plus the `usage`/`meetiq` carried on the final
   * chunk, so it has the identical shape `extract()` returns.
   */
  async extractStream<T = unknown>(
    messages: ChatMessage[],
    schema: Record<string, unknown>,
    options: Omit<ChatRequest, 'messages' | 'response_format' | 'stream'> = {},
    onChunk?: (chunk: ChatChunk) => void,
  ): Promise<{ value: T; completion: ChatCompletion }> {
    const completion = await this.collectStream(
      {
        temperature: 0,
        ...options,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'extraction', schema },
        },
      },
      onChunk,
    );
    const content = completion.choices[0]?.message.content ?? '';
    return { value: JSON.parse(content) as T, completion };
  }

  /**
   * Runs the streaming endpoint to completion and assembles a `ChatCompletion`
   * from the accumulated deltas plus the `usage`/`meetiq` carried on the final
   * chunk — the shape `chat()` returns, so callers don't need to branch on
   * whether a request streamed. `request.stream` is ignored; `stream()` always
   * sets it. Per the proxy, `tool_calls` arrive as a single complete delta, so
   * the last one seen is taken as-is rather than merged fragment by fragment.
   */
  private async collectStream(
    request: ChatRequest,
    onChunk?: (chunk: ChatChunk) => void,
    signal?: AbortSignal,
  ): Promise<ChatCompletion> {
    let id = '';
    let created = 0;
    let model = '';
    let content = '';
    let reasoning = '';
    let tool_calls: ToolCall[] | undefined;
    let finish_reason: FinishReason = 'stop';
    let usage: Usage | undefined;
    let meetiq: ProxyMeta | undefined;

    for await (const chunk of this.stream(request, signal)) {
      onChunk?.(chunk);
      id = chunk.id;
      created = chunk.created;
      model = chunk.model;
      const choice = chunk.choices[0];
      if (choice?.delta.content) content += choice.delta.content;
      if (choice?.delta.reasoning_content) reasoning += choice.delta.reasoning_content;
      if (choice?.delta.tool_calls) {
        tool_calls = choice.delta.tool_calls.map(({ index, ...call }) => call);
      }
      if (choice?.finish_reason) finish_reason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.meetiq) meetiq = chunk.meetiq;
    }

    if (!id && !content && !tool_calls) {
      throw new QwenProxyError(502, 'incomplete_stream', 'Stream ended without any content or tool calls');
    }

    return {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: content || null,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(tool_calls ? { tool_calls } : {}),
          },
          finish_reason,
          logprobs: null,
        },
      ],
      usage: usage ?? EMPTY_USAGE,
      meetiq: meetiq ?? UPSTREAM_META,
    };
  }

  /**
   * Agent loop for when the final answer must itself be schema-constrained
   * *and* the model needs other tools along the way — `response_format`
   * can't be combined with `tools` on this proxy, so the answer's schema is
   * modeled as one more tool instead of a separate constrained-decoding call.
   * Loops until the model calls `finalTool`; every other call is run through
   * `handlers` and its result appended before the next turn. `finalTool`'s
   * arguments (parsed as JSON, never passed to `handlers`) are the return
   * value.
   *
   * `toolChoice` defaults to `'required'`, which forces a grammar-constrained
   * (guaranteed-valid-JSON) tool call every turn, but the proxy also forces
   * `think:false` on that path regardless of the requested mode — thinking
   * never runs. `'auto'` lets the requested mode's reasoning actually happen,
   * at the cost of tool-call parsing falling back to text extraction instead
   * of a grammar guarantee, and the model may reply without calling any tool.
   */
  async runToolsUntil<T = unknown>(
    messages: ChatMessage[],
    tools: Tool[],
    finalTool: string,
    handlers: Record<string, (args: Record<string, unknown>, call: ToolCall) => Promise<unknown> | unknown>,
    options: Omit<ChatRequest, 'messages' | 'tools' | 'tool_choice' | 'stream'> & {
      maxHops?: number;
      stream?: boolean;
      toolChoice?: ToolChoice;
      onChunk?: (chunk: ChatChunk) => void;
      onToolCall?: (call: ToolCall, result: unknown) => void;
    } = {},
  ): Promise<{
    value: T;
    completion: ChatCompletion;
    messages: ChatMessage[];
    hops: number;
  }> {
    const { maxHops = 8, stream, toolChoice = 'required', onChunk, onToolCall, ...chatOptions } = options;
    const transcript = [...messages];

    for (let hops = 1; ; hops++) {
      if (hops > maxHops) {
        throw new QwenProxyError(500, 'max_hops_exceeded', `"${finalTool}" was not called within ${maxHops} hops`);
      }

      const request: ChatRequest = {
        ...chatOptions,
        messages: transcript,
        tools,
        tool_choice: toolChoice,
      };
      const completion = stream ? await this.collectStream(request, onChunk) : await this.chat(request);

      const choice = completion.choices[0]!;
      const calls = choice.message.tool_calls ?? [];
      if (choice.finish_reason !== 'tool_calls' || calls.length === 0) {
        throw new QwenProxyError(
          502,
          'no_tool_call',
          `Expected a tool call (tool_choice: ${JSON.stringify(toolChoice)}) but got finish_reason "${choice.finish_reason}" with no tool calls`,
        );
      }
      transcript.push({
        role: 'assistant',
        content: choice.message.content,
        tool_calls: calls,
      });

      for (const call of calls) {
        if (call.function.name === finalTool) {
          const value = JSON.parse(call.function.arguments) as T;
          return { value, completion, messages: transcript, hops };
        }
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
  ): Promise<{
    completion: ChatCompletion;
    messages: ChatMessage[];
    hops: number;
  }> {
    const { maxHops = 5, onToolCall, ...chatOptions } = options;
    const transcript = [...messages];
    let hops = 0;
    for (;;) {
      const completion = await this.chat({
        ...chatOptions,
        messages: transcript,
        tools,
      });
      const choice = completion.choices[0]!;
      const calls = choice.message.tool_calls ?? [];
      if (choice.finish_reason !== 'tool_calls' || calls.length === 0 || hops >= maxHops) {
        return { completion, messages: transcript, hops };
      }
      hops++;
      transcript.push({
        role: 'assistant',
        content: choice.message.content,
        tool_calls: calls,
      });
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

  private async send(path: string, body: unknown, signal?: AbortSignal, method = 'POST'): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
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
async function* sseData(
  // Whatever `fetch` hands back, after the caller's null check — naming the
  // concrete ReadableStream<Uint8Array> instead makes this fail to typecheck
  // under Bun's lib, where `Response['body']` is ReadableStream<any> and the
  // stream type is invariant in its chunk parameter.
  body: NonNullable<Response['body']>,
): AsyncGenerator<string, void, undefined> {
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
