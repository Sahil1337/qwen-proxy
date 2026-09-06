import { ProxyError, isProxyError } from './errors.js';

/** Subset of Ollama's native `/api/chat` types that the proxy uses. */
export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaOptions {
  num_ctx?: number;
  num_gpu?: number;
  num_predict?: number;
  temperature?: number;
  top_p?: number;
  seed?: number;
  stop?: string[];
}

export type OllamaFormat = 'json' | Record<string, unknown>;

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  think?: boolean;
  format?: OllamaFormat;
  tools?: unknown[];
  options?: OllamaOptions;
  keep_alive?: string;
}

export interface OllamaChatChunk {
  model: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  /** Nanoseconds, as reported by Ollama. */
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

export interface OllamaRunningModel {
  name: string;
  model: string;
  size?: number;
  size_vram?: number;
  context_length?: number;
}

export interface OllamaClient {
  chat(req: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatChunk>;
  chatStream(req: OllamaChatRequest, signal?: AbortSignal): AsyncIterable<OllamaChatChunk>;
  version(signal?: AbortSignal): Promise<string>;
  ps(signal?: AbortSignal): Promise<OllamaRunningModel[]>;
  /** Load a model into memory without generating. */
  preload(model: string, options: OllamaOptions, keepAlive: string, signal?: AbortSignal): Promise<void>;
}

export class HttpOllamaClient implements OllamaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async chat(req: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatChunk> {
    const { res } = await this.request('POST', '/api/chat', { ...req, stream: false }, signal);
    return (await res.json()) as OllamaChatChunk;
  }

  async *chatStream(req: OllamaChatRequest, signal?: AbortSignal): AsyncIterable<OllamaChatChunk> {
    const { res, timeout } = await this.request('POST', '/api/chat', { ...req, stream: true }, signal);
    if (!res.body) throw new ProxyError(502, 'upstream_error', 'Ollama returned an empty stream');
    try {
      for await (const line of ndjsonLines(res.body)) {
        const chunk = JSON.parse(line) as OllamaChatChunk & { error?: string };
        if (chunk.error) throw new ProxyError(502, 'upstream_error', chunk.error);
        yield chunk;
      }
    } catch (err) {
      throw isProxyError(err) ? err : mapFetchError(err, timeout);
    }
  }

  async version(signal?: AbortSignal): Promise<string> {
    const { res } = await this.request('GET', '/api/version', undefined, signal);
    const body = (await res.json()) as { version: string };
    return body.version;
  }

  async ps(signal?: AbortSignal): Promise<OllamaRunningModel[]> {
    const { res } = await this.request('GET', '/api/ps', undefined, signal);
    const body = (await res.json()) as { models?: OllamaRunningModel[] };
    return body.models ?? [];
  }

  async preload(model: string, options: OllamaOptions, keepAlive: string, signal?: AbortSignal): Promise<void> {
    await this.request('POST', '/api/generate', { model, options, keep_alive: keepAlive }, signal);
  }

  /** Performs the request; the returned `timeout` signal also governs reading a streamed body. */
  private async request(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ res: Response; timeout: AbortSignal }> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined,
      });
    } catch (err) {
      throw mapFetchError(err, timeout);
    }
    if (!res.ok) throw await mapHttpError(res);
    return { res, timeout };
  }
}

function mapFetchError(err: unknown, timeout: AbortSignal): ProxyError {
  if (timeout.aborted) return new ProxyError(504, 'upstream_timeout', 'Ollama did not respond in time');
  if (err instanceof Error && err.name === 'AbortError') {
    return new ProxyError(499, 'client_closed_request', 'Client closed the request');
  }
  if (err instanceof SyntaxError)
    return new ProxyError(502, 'upstream_error', `Ollama sent a malformed stream: ${err.message}`);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
  return new ProxyError(503, 'upstream_unavailable', `Ollama is unreachable: ${cause}`);
}

async function mapHttpError(res: Response): Promise<ProxyError> {
  let message = `Ollama responded with HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // Non-JSON body: keep the generic message.
  }
  return new ProxyError(502, 'upstream_error', message);
}

async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest) yield rest;
}
