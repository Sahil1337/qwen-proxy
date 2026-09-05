import type { Express } from 'express';
import type { AddressInfo } from 'node:net';
import { createApp, type AppDeps } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import type {
  OllamaChatChunk,
  OllamaChatRequest,
  OllamaClient,
  OllamaOptions,
  OllamaRunningModel,
} from '../src/core/ollama.js';
import type { Classifier } from '../src/core/router.js';
import { silentLogger } from '../src/util/logger.js';

export type Scripted = Partial<OllamaChatChunk['message']> & {
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

/**
 * Scripted stand-in for Ollama. `reply()` queues responses; each chat call
 * consumes one (the last one repeats). Every request is recorded.
 */
export class FakeOllama implements OllamaClient {
  readonly requests: OllamaChatRequest[] = [];
  private readonly queue: Scripted[] = [];

  reply(...responses: Scripted[]): this {
    this.queue.push(...responses);
    return this;
  }

  async chat(req: OllamaChatRequest): Promise<OllamaChatChunk> {
    this.requests.push(req);
    return this.complete(req, this.next());
  }

  async *chatStream(req: OllamaChatRequest): AsyncIterable<OllamaChatChunk> {
    this.requests.push(req);
    const scripted = this.next();
    const piece = (content: string, thinking: string): OllamaChatChunk => ({
      model: req.model,
      message: { role: 'assistant', content, ...(thinking ? { thinking } : {}) },
      done: false,
    });
    for (const part of chunks(scripted.thinking ?? '')) yield piece('', part);
    for (const part of chunks(scripted.content ?? '')) yield piece(part, '');
    yield this.complete(req, { ...scripted, content: '', thinking: '' });
  }

  async version(): Promise<string> {
    return '0.0.0-fake';
  }

  async ps(): Promise<OllamaRunningModel[]> {
    return [{ name: 'qwen3.5:4b', model: 'qwen3.5:4b', size_vram: 1, context_length: 8192 }];
  }

  async preload(_model: string, _options: OllamaOptions): Promise<void> {}

  private next(): Scripted {
    if (this.queue.length > 1) return this.queue.shift()!;
    return this.queue[0] ?? { content: 'ok' };
  }

  private complete(req: OllamaChatRequest, s: Scripted): OllamaChatChunk {
    return {
      model: req.model,
      message: {
        role: 'assistant',
        content: s.content ?? '',
        ...(s.thinking ? { thinking: s.thinking } : {}),
        ...(s.tool_calls ? { tool_calls: s.tool_calls } : {}),
      },
      done: true,
      done_reason: s.done_reason ?? 'stop',
      prompt_eval_count: s.prompt_eval_count ?? 10,
      eval_count: s.eval_count ?? 5,
    };
  }
}

function chunks(text: string, size = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ OLLAMA_MANAGED: 'false', OLLAMA_PRELOAD: 'false', ...overrides });
}

export const fastClassifier: Classifier = async () => 'FAST';
export const thinkClassifier: Classifier = async () => 'THINK';

export interface TestServer {
  url: string;
  fake: FakeOllama;
  close(): Promise<void>;
}

export async function startServer(
  opts: { env?: Record<string, string>; classify?: Classifier; fake?: FakeOllama } = {},
): Promise<TestServer> {
  const fake = opts.fake ?? new FakeOllama();
  const deps: AppDeps = {
    config: testConfig(opts.env),
    client: fake,
    log: silentLogger,
    classify: opts.classify ?? fastClassifier,
  };
  const { app } = createApp(deps);
  const server = await listen(app);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    fake,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function listen(app: Express) {
  return new Promise<ReturnType<Express['listen']>>((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

export async function readSse(url: string, body: unknown): Promise<string[]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return text
    .split('\n\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice('data: '.length));
}

export const WEATHER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Get the weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['c', 'f'] } },
      required: ['city'],
      additionalProperties: false,
    },
  },
};
