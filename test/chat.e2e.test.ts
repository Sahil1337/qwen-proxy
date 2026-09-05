import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeOllama,
  postJson,
  readSse,
  startServer,
  thinkClassifier,
  WEATHER_TOOL,
  type TestServer,
} from './helpers.js';

let server: TestServer;
afterEach(async () => {
  await server?.close();
});

const CHAT = '/v1/chat/completions';
const user = (content: string) => [{ role: 'user', content }];
const schema = {
  type: 'object',
  properties: { propositions: { type: 'array', items: { type: 'string' } } },
  required: ['propositions'],
  additionalProperties: false,
};

describe('structured output', () => {
  it('routes json_schema to fast, passes the schema as format and validates', async () => {
    server = await startServer({ fake: new FakeOllama().reply({ content: '{"propositions":["a","b"]}' }) });
    const res = await postJson(server.url + CHAT, {
      messages: user('Extract propositions. Why? Because.'),
      response_format: { type: 'json_schema', json_schema: { name: 'props', schema } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-meetiq-mode')).toBe('fast');
    expect(res.body.meetiq.router).toEqual({ mode: 'fast', rule: 'structured_output' });
    expect(JSON.parse(res.body.choices[0].message.content)).toEqual({ propositions: ['a', 'b'] });
    expect(res.body.choices[0].finish_reason).toBe('stop');
    expect(res.body.usage.prompt_tokens).toBe(10);

    const upstream = server.fake.requests[0]!;
    expect(upstream.format).toEqual(schema);
    expect(upstream.think).toBe(false);
    expect(upstream.options?.num_ctx).toBe(8192);
    expect(upstream.options?.num_gpu).toBe(34);
  });

  it('retries once with the validation error, then succeeds', async () => {
    server = await startServer({
      fake: new FakeOllama().reply({ content: '{"propositions":"not an array"}' }, { content: '{"propositions":[]}' }),
    });
    const res = await postJson(server.url + CHAT, {
      messages: user('go'),
      response_format: { type: 'json_schema', json_schema: { schema } },
    });
    expect(res.status).toBe(200);
    expect(res.body.meetiq.retries).toBe(1);
    const retry = server.fake.requests[1]!;
    expect(retry.messages.at(-1)?.content).toMatch(/did not match the required JSON schema/);
    expect(retry.messages.at(-2)?.content).toBe('{"propositions":"not an array"}');
  });

  it('returns 502 structured_output_invalid after the retry fails', async () => {
    server = await startServer({ fake: new FakeOllama().reply({ content: 'nope' }) });
    const res = await postJson(server.url + CHAT, { messages: user('go'), response_format: { type: 'json_object' } });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('structured_output_invalid');
    expect(server.fake.requests).toHaveLength(2);
  });
});

describe('tool calling', () => {
  const toolRequest = (extra: Record<string, unknown> = {}) => ({
    messages: user('Weather in Oslo?'),
    tools: [WEATHER_TOOL],
    ...extra,
  });

  it('parses a Hermes <tool_call> from content (fallback path)', async () => {
    server = await startServer({
      fake: new FakeOllama().reply({
        thinking: 'need the tool',
        content: 'Sure.\n<tool_call>\n{"name":"get_weather","arguments":{"city":"Oslo"}}\n</tool_call>',
      }),
    });
    const res = await postJson(server.url + CHAT, toolRequest());
    expect(res.status).toBe(200);
    const msg = res.body.choices[0].message;
    expect(res.body.choices[0].finish_reason).toBe('tool_calls');
    expect(msg.content).toBe('Sure.');
    expect(msg.reasoning_content).toBe('need the tool');
    expect(msg.tool_calls[0].id).toMatch(/^call_/);
    expect(msg.tool_calls[0].function).toEqual({ name: 'get_weather', arguments: '{"city":"Oslo"}' });
    expect(res.body.meetiq.tool_parse).toBe('fallback');
    expect(res.body.meetiq.router.rule).toBe('tools');
    expect(server.fake.requests[0]?.think).toBe(true);
    // The model sees a slimmed schema; validation used the full one.
    const sent = server.fake.requests[0]?.tools?.[0] as typeof WEATHER_TOOL;
    expect(sent.function.parameters).not.toHaveProperty('additionalProperties');
    expect(sent.function.parameters.properties).toEqual(WEATHER_TOOL.function.parameters.properties);
  });

  it('sends full schemas when TOOL_SCHEMA_SLIM=false', async () => {
    server = await startServer({ env: { TOOL_SCHEMA_SLIM: 'false' }, fake: new FakeOllama().reply({ content: 'ok' }) });
    await postJson(server.url + CHAT, toolRequest());
    expect(server.fake.requests[0]?.tools).toEqual([WEATHER_TOOL]);
  });

  it('exposes the exact upstream payloads with debug:true', async () => {
    server = await startServer({
      fake: new FakeOllama().reply({ content: 'nope' }, { content: '{"propositions":[]}' }),
    });
    const res = await postJson(server.url + CHAT, {
      messages: user('go'),
      response_format: { type: 'json_schema', json_schema: { schema } },
      debug: true,
    });
    expect(res.status).toBe(200);
    const sent = res.body.meetiq.upstream_requests;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      model: 'qwen3.5:4b',
      think: false,
      format: schema,
      options: { num_ctx: 8192, num_gpu: 34, num_predict: 2048 },
    });
    expect(sent[1].messages.at(-1).content).toMatch(/did not match/);
    expect(res.body.meetiq.timing).toMatchObject({ load_ms: 0, eval_tps: 0 });
  });

  it('uses native tool_calls when Ollama returns them', async () => {
    server = await startServer({
      fake: new FakeOllama().reply({
        content: '',
        tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Oslo' } } }],
      }),
    });
    const res = await postJson(server.url + CHAT, toolRequest());
    expect(res.body.meetiq.tool_parse).toBe('native');
    expect(res.body.choices[0].message.content).toBeNull();
    expect(res.body.choices[0].message.tool_calls[0].function.arguments).toBe('{"city":"Oslo"}');
  });

  it('injects the tools block instead when TOOL_INJECTION=prompt', async () => {
    server = await startServer({
      env: { TOOL_INJECTION: 'prompt' },
      fake: new FakeOllama().reply({ content: 'No tool needed.' }),
    });
    const res = await postJson(server.url + CHAT, toolRequest());
    expect(res.body.meetiq.tool_parse).toBe('none');
    expect(res.body.choices[0].message.content).toBe('No tool needed.');
    const upstream = server.fake.requests[0]!;
    expect(upstream.tools).toBeUndefined();
    expect(upstream.messages[0]?.role).toBe('system');
    expect(upstream.messages[0]?.content).toContain('<tools>');
  });

  it('retries an invalid call once, then returns 502 tool_call_invalid', async () => {
    server = await startServer({
      fake: new FakeOllama().reply({
        content: '<tool_call>{"name":"get_weather","arguments":{"unit":"k"}}</tool_call>',
      }),
    });
    const res = await postJson(server.url + CHAT, toolRequest());
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('tool_call_invalid');
    expect(res.body.error.details.raw).toContain('<tool_call>');
    expect(server.fake.requests).toHaveLength(2);
    const retry = server.fake.requests[1]!;
    expect(retry.messages.at(-1)?.content).toMatch(
      /^Your previous tool call was invalid: .*Emit a corrected <tool_call>\.$/,
    );
  });

  it('recovers when the retry produces a valid call', async () => {
    server = await startServer({
      fake: new FakeOllama().reply(
        { content: '<tool_call>{"name":"get_weather","arguments":{}}</tool_call>' },
        { content: '<tool_call>{"name":"get_weather","arguments":{"city":"Oslo"}}</tool_call>' },
      ),
    });
    const res = await postJson(server.url + CHAT, toolRequest());
    expect(res.status).toBe(200);
    expect(res.body.meetiq.retries).toBe(1);
    expect(res.body.choices[0].message.tool_calls).toHaveLength(1);
  });

  it('forces a tool with constrained decoding for tool_choice', async () => {
    server = await startServer({
      fake: new FakeOllama().reply({ content: '{"name":"get_weather","arguments":{"city":"Oslo","unit":"c"}}' }),
    });
    const res = await postJson(
      server.url + CHAT,
      toolRequest({ tool_choice: { type: 'function', function: { name: 'get_weather' } }, mode: 'thinking' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.meetiq.tool_parse).toBe('forced');
    expect(res.body.meetiq.mode_used).toBe('fast');
    expect(res.body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
    const upstream = server.fake.requests[0]!;
    expect(upstream.think).toBe(false);
    expect(upstream.tools).toBeUndefined();
    expect((upstream.format as any).properties.name).toEqual({ const: 'get_weather' });
  });

  it('strips tools for tool_choice none and never parses', async () => {
    server = await startServer({
      fake: new FakeOllama().reply({
        content: '<tool_call>{"name":"get_weather","arguments":{"city":"Oslo"}}</tool_call>',
      }),
    });
    const res = await postJson(server.url + CHAT, toolRequest({ tool_choice: 'none' }));
    expect(res.body.choices[0].message.tool_calls).toBeUndefined();
    expect(res.body.meetiq.tool_parse).toBe('none');
    expect(server.fake.requests[0]?.tools).toBeUndefined();
  });

  it('round-trips a tool result as <tool_response>', async () => {
    server = await startServer({ fake: new FakeOllama().reply({ content: 'It is 4°C in Oslo.' }) });
    const res = await postJson(server.url + CHAT, {
      messages: [
        ...user('Weather in Oslo?'),
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp_c":4}' },
      ],
      tools: [WEATHER_TOOL],
    });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('It is 4°C in Oslo.');
    const upstream = server.fake.requests[0]!.messages;
    expect(upstream[1]?.content).toContain('<tool_call>');
    expect(upstream[2]).toEqual({ role: 'user', content: '<tool_response>\n{"temp_c":4}\n</tool_response>' });
  });
});

describe('thinking', () => {
  it('returns reasoning_content separately and reports a budget hit', async () => {
    server = await startServer({
      env: { THINK_BUDGET_TOKENS: '10' },
      fake: new FakeOllama().reply(
        { thinking: 'long thoughts', content: '', done_reason: 'length' },
        { content: 'The answer.' },
      ),
    });
    const res = await postJson(server.url + CHAT, { messages: user('Why did the deploy fail?'), max_tokens: 20 });
    expect(res.headers.get('x-meetiq-mode')).toBe('thinking');
    expect(res.body.meetiq.router.rule).toBe('reasoning_cue');
    expect(res.body.meetiq.think_budget_hit).toBe(true);
    expect(res.body.choices[0].message.content).toBe('The answer.');
    expect(res.body.choices[0].message.reasoning_content).toBe('long thoughts');
    expect(server.fake.requests[0]?.options?.num_predict).toBe(30);
  });

  it('adaptive "why" question sets x-meetiq-mode: thinking', async () => {
    server = await startServer();
    const res = await postJson(server.url + CHAT, { messages: user('Why does the sky look blue at noon?') });
    expect(res.headers.get('x-meetiq-mode')).toBe('thinking');
    expect(res.headers.get('x-meetiq-rule')).toBe('reasoning_cue');
  });
});

describe('streaming', () => {
  it('streams reasoning then content chunks and ends with [DONE]', async () => {
    server = await startServer({
      fake: new FakeOllama().reply({ thinking: 'pondering', content: 'Hello there, world.' }),
    });
    const events = await readSse(server.url + CHAT, { messages: user('hi'), stream: true, mode: 'thinking' });
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant' });
    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    const reasoning = chunks.map((c) => c.choices[0].delta.reasoning_content ?? '').join('');
    const content = chunks.map((c) => c.choices[0].delta.content ?? '').join('');
    expect(reasoning).toBe('pondering');
    expect(content).toBe('Hello there, world.');
    expect(content.length).toBeGreaterThan(0);
    expect(chunks.filter((c) => c.choices[0].delta.content).length).toBeGreaterThan(1);
    const last = chunks.at(-1);
    expect(last.choices[0].finish_reason).toBe('stop');
    expect(last.usage.total_tokens).toBe(15);
    expect(last.meetiq.mode_used).toBe('thinking');
  });

  it('buffers tool calls and emits one tool_calls chunk', async () => {
    server = await startServer({
      fake: new FakeOllama().reply({
        content: '<tool_call>{"name":"get_weather","arguments":{"city":"Oslo"}}</tool_call>',
      }),
    });
    const events = await readSse(server.url + CHAT, {
      messages: user('Weather?'),
      tools: [WEATHER_TOOL],
      stream: true,
    });
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks).toHaveLength(3);
    expect(chunks[1].choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      type: 'function',
      function: { name: 'get_weather' },
    });
    expect(chunks[2].choices[0].finish_reason).toBe('tool_calls');
    expect(events.at(-1)).toBe('[DONE]');
  });
});

describe('limits, auth and errors', () => {
  it('rejects oversized prompts with 400 context_length_exceeded', async () => {
    server = await startServer({ env: { MAX_PROMPT_TOKENS: '50' } });
    const res = await postJson(server.url + CHAT, { messages: user('x'.repeat(1000)) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('context_length_exceeded');
    expect(server.fake.requests).toHaveLength(0);
  });

  it('returns OpenAI error envelopes for invalid bodies', async () => {
    server = await startServer();
    const res = await postJson(server.url + CHAT, { messages: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('requires a bearer token when API_KEY is set', async () => {
    server = await startServer({ env: { API_KEY: 'secret' } });
    expect((await postJson(server.url + CHAT, { messages: user('hi') })).status).toBe(401);
    expect(
      (await postJson(server.url + CHAT, { messages: user('hi') }, { authorization: 'Bearer secret' })).status,
    ).toBe(200);
    expect((await fetch(server.url + '/health')).status).toBe(200);
  });

  it('echoes x-request-id', async () => {
    server = await startServer();
    const res = await postJson(server.url + CHAT, { messages: user('hi') }, { 'x-request-id': 'abc-123' });
    expect(res.headers.get('x-request-id')).toBe('abc-123');
  });

  it('times out in the queue with 503 and Retry-After', async () => {
    const slow = new FakeOllama();
    const realChat = slow.chat.bind(slow);
    slow.chat = async (req) => {
      await new Promise((r) => setTimeout(r, 300));
      return realChat(req);
    };
    server = await startServer({ env: { MAX_PARALLEL: '1', QUEUE_TIMEOUT_MS: '100' }, fake: slow });
    const first = postJson(server.url + CHAT, { messages: user('hi') });
    await new Promise((r) => setTimeout(r, 20));
    const second = await postJson(server.url + CHAT, { messages: user('hi') });
    expect(second.status).toBe(503);
    expect(second.body.error.code).toBe('queue_timeout');
    expect(second.headers.get('retry-after')).toBe('10');
    expect((await first).status).toBe(200);
  });
});

describe('other endpoints', () => {
  it('GET /v1/models lists the configured model', async () => {
    server = await startServer({ env: { MODEL: 'qwen3.5:4b' } });
    const body = (await (await fetch(server.url + '/v1/models')).json()) as any;
    expect(body.data[0].id).toBe('qwen3.5:4b');
  });

  it('GET /health reports ollama, model and queue', async () => {
    server = await startServer();
    const res = await fetch(server.url + '/health');
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      ollama: { reachable: true, managed: false },
      model: { loaded: true },
      queue: { concurrency: 2 },
    });
  });

  it('POST /v1/inspect returns the first upstream payload without generating', async () => {
    server = await startServer();
    const res = await postJson(server.url + '/v1/inspect', {
      messages: user('Weather in Oslo?'),
      tools: [WEATHER_TOOL],
      max_tokens: 100,
    });
    expect(res.status).toBe(200);
    expect(res.body.router).toEqual({ mode: 'thinking', rule: 'tools' });
    expect(res.body.tool_path).toBe('native');
    expect(res.body.buffered_streaming).toBe(true);
    expect(res.body.upstream_request).toMatchObject({ think: true, options: { num_predict: 1124 } });
    expect(res.body.upstream_request.tools[0].function.parameters).not.toHaveProperty('additionalProperties');
    expect(server.fake.requests).toHaveLength(0);
  });

  it('POST /v1/route returns the decision without generating', async () => {
    server = await startServer({ classify: thinkClassifier });
    const res = await postJson(server.url + '/v1/route', {
      messages: user('Compare the two vendor proposals from last week.'),
    });
    expect(res.body).toMatchObject({
      mode: 'thinking',
      rule: 'reasoning_cue',
      detail: 'compare',
      mode_requested: null,
    });
    expect(server.fake.requests).toHaveLength(0);
  });
});
