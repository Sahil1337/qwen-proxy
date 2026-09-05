import { describe, expect, it } from 'vitest';
import { estimatePromptTokens, parseChatRequest, toOllamaMessages } from '../src/core/mapping.js';

describe('toOllamaMessages', () => {
  it('converts tool results into <tool_response> user messages, preserving order', () => {
    const out = toOllamaMessages([
      { role: 'user', content: 'Weather in Oslo?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp_c": 4}' },
      { role: 'user', content: 'And Bergen?' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(out[1]?.content).toBe('<tool_call>\n{"name":"get_weather","arguments":{"city":"Oslo"}}\n</tool_call>');
    expect(out[2]?.content).toBe('<tool_response>\n{"temp_c": 4}\n</tool_response>');
  });

  it('keeps assistant text ahead of re-rendered tool calls', () => {
    const [m] = toOllamaMessages([
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [{ function: { name: 'a', arguments: '{}' } }, { function: { name: 'b', arguments: 'not-json' } }],
      },
    ]);
    expect(m?.content).toBe(
      'Checking.\n<tool_call>\n{"name":"a","arguments":{}}\n</tool_call>\n<tool_call>\n{"name":"b","arguments":"not-json"}\n</tool_call>',
    );
  });

  it('maps developer to system and joins text parts', () => {
    const out = toOllamaMessages([
      { role: 'developer', content: 'Be terse.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    ]);
    expect(out).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'a\nb' },
    ]);
  });

  it('rejects non-text content parts', () => {
    expect(() =>
      toOllamaMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }]),
    ).toThrow(/only text/);
  });
});

describe('parseChatRequest', () => {
  it('accepts unknown fields and rejects bad shapes', () => {
    const ok = parseChatRequest({
      messages: [{ role: 'user', content: 'hi' }],
      user: 'sdk-extra',
      stream_options: { include_usage: true },
    });
    expect(ok.messages).toHaveLength(1);
    expect(() => parseChatRequest({ messages: [] })).toThrow(/Invalid request/);
    expect(() => parseChatRequest({ messages: [{ role: 'robot', content: 'x' }] })).toThrow(/role/);
  });
});

describe('estimatePromptTokens', () => {
  it('counts messages, tool calls and tool definitions', () => {
    const tokens = estimatePromptTokens({
      messages: [{ role: 'user', content: 'x'.repeat(400) }],
      tools: [{ type: 'function', function: { name: 'n'.repeat(40) } }],
    });
    expect(tokens).toBeGreaterThan(100);
    expect(tokens).toBeLessThan(140);
  });
});
