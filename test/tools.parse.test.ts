import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  forcedToolFormat,
  injectTools,
  parseToolCalls,
  renderToolsBlock,
  repairJson,
  slimSchema,
  slimTools,
  validateToolCalls,
} from '../src/core/tools.js';
import { WEATHER_TOOL } from './helpers.js';

const ajv = new Ajv({ allErrors: true, strict: false });

describe('parseToolCalls', () => {
  it('parses a single call and yields null content', () => {
    const r = parseToolCalls('<tool_call>\n{"name":"get_weather","arguments":{"city":"Paris"}}\n</tool_call>');
    expect(r.content).toBeNull();
    expect(r.errors).toEqual([]);
    expect(r.calls).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }]);
  });

  it('parses two calls in order', () => {
    const r = parseToolCalls(
      '<tool_call>{"name":"a","arguments":{"x":1}}</tool_call>\n<tool_call>{"name":"b","arguments":{"y":2}}</tool_call>',
    );
    expect(r.calls.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('keeps prose before the first block as content and tolerates prose after', () => {
    const r = parseToolCalls('Let me check that.\n<tool_call>{"name":"a","arguments":{}}</tool_call>\nDone.');
    expect(r.content).toBe('Let me check that.');
    expect(r.calls).toEqual([{ name: 'a', arguments: {} }]);
  });

  it('tolerates a missing closing tag at end of output', () => {
    const r = parseToolCalls('<tool_call>{"name":"a","arguments":{"q":"z"}}');
    expect(r.calls).toEqual([{ name: 'a', arguments: { q: 'z' } }]);
    expect(r.errors).toEqual([]);
  });

  it('ignores tool_call blocks inside <think>', () => {
    const r = parseToolCalls(
      '<think>maybe <tool_call>{"name":"wrong","arguments":{}}</tool_call></think>\n<tool_call>{"name":"right","arguments":{}}</tool_call>',
    );
    expect(r.calls.map((c) => c.name)).toEqual(['right']);
  });

  it('ignores everything after an unclosed <think>', () => {
    const r = parseToolCalls('<think>still thinking <tool_call>{"name":"wrong","arguments":{}}</tool_call>');
    expect(r.calls).toEqual([]);
    expect(r.content).toBeNull();
  });

  it('repairs single quotes and trailing commas once', () => {
    const r = parseToolCalls("<tool_call>{'name': 'a', 'arguments': {'city': 'Paris',},}</tool_call>");
    expect(r.errors).toEqual([]);
    expect(r.calls).toEqual([{ name: 'a', arguments: { city: 'Paris' } }]);
  });

  it('reports blocks that cannot be repaired', () => {
    const r = parseToolCalls('<tool_call>{name: not json at all</tool_call>');
    expect(r.calls).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });

  it('returns plain content when there is no tool call', () => {
    const r = parseToolCalls('Just an answer.');
    expect(r).toEqual({ content: 'Just an answer.', calls: [], errors: [] });
  });
});

describe('repairJson', () => {
  it('handles code fences and Python literals', () => {
    expect(repairJson('```json\n{"a": True, "b": None}\n```')).toEqual({ a: true, b: null });
  });
});

describe('validateToolCalls', () => {
  it('accepts valid arguments', () => {
    expect(validateToolCalls([{ name: 'get_weather', arguments: { city: 'Oslo' } }], [WEATHER_TOOL], ajv)).toEqual([]);
  });

  it('reports schema violations and unknown tools', () => {
    const errors = validateToolCalls(
      [
        { name: 'get_weather', arguments: { unit: 'k' } },
        { name: 'nope', arguments: {} },
      ],
      [WEATHER_TOOL],
      ajv,
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/get_weather:/);
    expect(errors[1]).toMatch(/unknown tool "nope"/);
  });
});

describe('forcedToolFormat', () => {
  it('pins the name with const for a named tool', () => {
    const schema = forcedToolFormat([WEATHER_TOOL], { type: 'function', function: { name: 'get_weather' } }) as any;
    expect(schema.properties.name).toEqual({ const: 'get_weather' });
    expect(schema.properties.arguments).toBe(WEATHER_TOOL.function.parameters);
  });

  it('uses oneOf across tools for required', () => {
    const other = { type: 'function' as const, function: { name: 'other' } };
    const schema = forcedToolFormat([WEATHER_TOOL, other], 'required') as any;
    expect(schema.oneOf).toHaveLength(2);
  });
});

describe('injectTools', () => {
  it('prepends the block to an existing system message', () => {
    const out = injectTools(
      [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
      [WEATHER_TOOL],
    );
    expect(out[0]?.content.startsWith('# Tools')).toBe(true);
    expect(out[0]?.content.endsWith('Be brief.')).toBe(true);
    expect(out).toHaveLength(2);
  });

  it('creates a system message when none exists', () => {
    const out = injectTools([{ role: 'user', content: 'hi' }], [WEATHER_TOOL]);
    expect(out[0]?.role).toBe('system');
    expect(out[0]?.content).toBe(renderToolsBlock([WEATHER_TOOL]));
  });

  it('renders one JSON signature per line inside <tools>', () => {
    const block = renderToolsBlock([WEATHER_TOOL]);
    expect(block).toContain('<tools>\n{"type":"function","function":{"name":"get_weather"');
    expect(block).toContain('{"name": <function-name>, "arguments": <args-json-object>}');
  });
});

describe('slimSchema', () => {
  it('drops validation-only keywords at every level but keeps property names verbatim', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Args',
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'A property literally named title', examples: ['x'] },
        items: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer', minimum: 1 } } },
        },
      },
      required: ['title'],
    };
    expect(slimSchema(schema)).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A property literally named title' },
        items: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } },
      },
      required: ['title'],
    });
  });

  it('slimTools keeps name and description and drops strict', () => {
    const [t] = slimTools([
      {
        type: 'function',
        function: {
          name: 'f',
          description: 'd',
          strict: true,
          parameters: { type: 'object', additionalProperties: false },
        },
      },
    ]);
    expect(t).toEqual({ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } });
  });
});
