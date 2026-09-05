import { describe, expect, it } from 'vitest';
import { formatPretty } from '../src/util/logger.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const line = (fields: Record<string, unknown>) =>
  JSON.stringify({ level: 30, time: 0, service: 'qwen-proxy', ...fields });

describe('formatPretty', () => {
  it('renders level, message and key=value fields on one line', () => {
    const out = strip(formatPretty(line({ msg: 'chat.completion', mode_used: 'fast', eval_tps: 39.2 })));
    expect(out).toMatch(/^\d\d:\d\d:\d\d\.\d{3} INFO {1,2}chat\.completion mode_used=fast eval_tps=39\.2$/);
  });

  it('renders prompt, reasoning, tool calls and answer as blocks', () => {
    const out = strip(
      formatPretty(
        line({
          level: 20,
          msg: 'model.io',
          prompt: 'Why?',
          reasoning: 'step one\nstep two',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
          content: 'Because.',
        }),
      ),
    );
    expect(out).toContain('DEBUG model.io');
    expect(out).toContain('┌ prompt\n  │ Why?');
    expect(out).toContain('┌ reasoning\n  │ step one\n  │ step two');
    expect(out).toContain('┌ tool calls\n  │ search({"q":"x"})');
    expect(out).toContain('┌ answer\n  │ Because.');
  });

  it('keeps forwarded Ollama output on one line and passes non-JSON through', () => {
    expect(strip(formatPretty(line({ level: 10, msg: 'ollama', ollama: 'llama-server: loaded' })))).toMatch(
      /TRACE ollama llama-server: loaded$/,
    );
    expect(formatPretty('not json')).toBe('not json');
  });
});
