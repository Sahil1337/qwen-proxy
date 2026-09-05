import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../src/core/mapping.js';
import { decideMode, findReasoningCue, requestedMode } from '../src/core/router.js';
import { fastClassifier, testConfig, thinkClassifier, WEATHER_TOOL } from './helpers.js';

const cfg = testConfig();
const req = (overrides: Partial<ChatRequest> = {}, user = 'Summarise this meeting in two lines.'): ChatRequest => ({
  messages: [{ role: 'user', content: user }],
  ...overrides,
});
const longQuestion =
  'Here is the transcript of the meeting: '.padEnd(400, 'x') + ' Tell me what the team decided about the launch.';

describe('decideMode', () => {
  it('rule 1: explicit mode wins over everything', async () => {
    const d = await decideMode(
      req({ mode: 'fast', tools: [WEATHER_TOOL] }, 'Why did this fail?'),
      cfg,
      thinkClassifier,
    );
    expect(d).toEqual({ mode: 'fast', rule: 'explicit' });
  });

  it('rule 1: reasoning_effort is an alias', async () => {
    expect(requestedMode(req({ reasoning_effort: 'none' }))).toBe('fast');
    expect(requestedMode(req({ reasoning_effort: 'high' }))).toBe('thinking');
    expect((await decideMode(req({ reasoning_effort: 'low' }), cfg, fastClassifier)).mode).toBe('thinking');
  });

  it('rule 1b: non-adaptive DEFAULT_MODE short-circuits', async () => {
    const d = await decideMode(req({}, 'Why?'), testConfig({ DEFAULT_MODE: 'fast' }), thinkClassifier);
    expect(d).toEqual({ mode: 'fast', rule: 'default' });
  });

  it('rule 2: response_format without tools -> fast', async () => {
    const d = await decideMode(
      req({ response_format: { type: 'json_object' } }, 'Why did revenue drop? Explain.'),
      cfg,
      thinkClassifier,
    );
    expect(d).toEqual({ mode: 'fast', rule: 'structured_output' });
  });

  it('rule 3: tools -> thinking', async () => {
    const d = await decideMode(req({ tools: [WEATHER_TOOL] }, 'hi'), cfg, fastClassifier);
    expect(d).toEqual({ mode: 'thinking', rule: 'tools' });
  });

  it('rule 3: disabled via ADAPTIVE_TOOLS_THINK=false', async () => {
    const d = await decideMode(
      req({ tools: [WEATHER_TOOL] }, 'hi'),
      testConfig({ ADAPTIVE_TOOLS_THINK: 'false' }),
      fastClassifier,
    );
    expect(d.rule).toBe('short_prompt');
  });

  it('rule 4: reasoning cue -> thinking', async () => {
    const d = await decideMode(req({}, 'What is the ROOT CAUSE of the outage?'), cfg, fastClassifier);
    expect(d).toEqual({ mode: 'thinking', rule: 'reasoning_cue', detail: 'root cause' });
    expect(findReasoningCue('We should prioritise the API')).toBe('prioriti');
    expect(findReasoningCue('a nice day')).toBeUndefined();
  });

  it('rule 5: short message without cue -> fast', async () => {
    const d = await decideMode(req({}, 'Summarise this in one line.'), cfg, thinkClassifier);
    expect(d).toEqual({ mode: 'fast', rule: 'short_prompt' });
  });

  it('rule 6: classifier decides for long messages', async () => {
    expect(await decideMode(req({}, longQuestion), cfg, thinkClassifier)).toEqual({
      mode: 'thinking',
      rule: 'classifier',
      detail: 'think',
    });
    expect(await decideMode(req({}, longQuestion), cfg, fastClassifier)).toEqual({
      mode: 'fast',
      rule: 'classifier',
      detail: 'fast',
    });
  });

  it('rule 6: timeout or error falls back to fast', async () => {
    const d = await decideMode(req({}, longQuestion), cfg, async () => 'TIMEOUT');
    expect(d).toEqual({ mode: 'fast', rule: 'classifier', detail: 'timeout' });
  });
});
