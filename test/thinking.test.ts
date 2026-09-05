import { describe, expect, it } from 'vitest';
import { FORCED_CLOSE, runTurn, splitThink, ThinkSplitter } from '../src/core/thinking.js';
import { FakeOllama, testConfig } from './helpers.js';

describe('splitThink', () => {
  it('separates thinking from content', () => {
    expect(splitThink('<think>hmm</think>answer')).toEqual({ content: 'answer', thinking: 'hmm' });
  });

  it('treats an unclosed <think> as all thinking', () => {
    expect(splitThink('<think>still going')).toEqual({ content: '', thinking: 'still going' });
  });

  it('handles tags split across chunks', () => {
    const s = new ThinkSplitter();
    const parts = ['<th', 'ink>deep', ' thought</thi', 'nk>the ans', 'wer'];
    const acc = { content: '', thinking: '' };
    for (const p of parts) {
      const r = s.push(p);
      acc.content += r.content;
      acc.thinking += r.thinking;
    }
    const tail = s.flush();
    acc.content += tail.content;
    acc.thinking += tail.thinking;
    expect(acc).toEqual({ content: 'the answer', thinking: 'deep thought' });
  });
});

describe('runTurn thinking budget', () => {
  const config = testConfig({ THINK_BUDGET_TOKENS: '100' });

  it('continues with a forced close when the budget is spent without an answer', async () => {
    const fake = new FakeOllama().reply(
      { thinking: 'Let me think about this at length', content: '', done_reason: 'length', eval_count: 100 },
      { content: 'Forty-two.', eval_count: 3 },
    );
    const result = await runTurn(fake, config, {
      messages: [{ role: 'user', content: 'What is the answer?' }],
      mode: 'thinking',
      maxTokens: 50,
      options: {},
    });

    expect(result.budgetHit).toBe(true);
    expect(result.content).toBe('Forty-two.');
    expect(result.thinking).toBe('Let me think about this at length');
    expect(result.completionTokens).toBe(103);
    expect(result.upstreamCalls).toBe(2);

    const [first, second] = fake.requests;
    expect(first?.think).toBe(true);
    expect(first?.options?.num_predict).toBe(150);
    expect(second?.think).toBe(false);
    expect(second?.options?.num_predict).toBe(50);
    const prefix = second?.messages.at(-1);
    expect(prefix?.role).toBe('assistant');
    expect(prefix?.content).toBe(`<think>\nLet me think about this at length\n</think>${FORCED_CLOSE}`);
  });

  it('does not continue when the model answered', async () => {
    const fake = new FakeOllama().reply({ thinking: 'brief', content: 'Done.' });
    const result = await runTurn(fake, config, {
      messages: [{ role: 'user', content: 'x' }],
      mode: 'thinking',
      maxTokens: 50,
      options: {},
    });
    expect(result.budgetHit).toBe(false);
    expect(fake.requests).toHaveLength(1);
  });

  it('strips <think> that leaks into content in fast mode', async () => {
    const fake = new FakeOllama().reply({ content: '<think>leak</think>clean' });
    const result = await runTurn(fake, config, {
      messages: [{ role: 'user', content: 'x' }],
      mode: 'fast',
      maxTokens: 50,
      options: {},
    });
    expect(result.content).toBe('clean');
    expect(result.thinking).toBe('leak');
    expect(fake.requests[0]?.think).toBe(false);
  });
});

describe('runTurn thinking budget with a truncated answer', () => {
  const config = testConfig({ THINK_BUDGET_TOKENS: '100' });

  it('continues a partial answer that was cut off by the budget', async () => {
    const fake = new FakeOllama().reply(
      { thinking: 'long thoughts', content: 'The answer is', done_reason: 'length', eval_count: 150 },
      { content: ' forty-two.', eval_count: 4 },
    );
    const result = await runTurn(fake, config, {
      messages: [{ role: 'user', content: 'What is the answer?' }],
      mode: 'thinking',
      maxTokens: 50,
      options: {},
    });
    expect(result.budgetHit).toBe(true);
    expect(result.content).toBe('The answer is forty-two.');
    const prefix = fake.requests[1]?.messages.at(-1);
    expect(prefix?.content).toBe('<think>\nlong thoughts\n</think>The answer is');
    expect(fake.requests[1]?.think).toBe(false);
  });

  it('does not continue when the answer itself used the whole max_tokens', async () => {
    const fake = new FakeOllama().reply({ thinking: 'brief', content: 'x'.repeat(400), done_reason: 'length' });
    const result = await runTurn(fake, config, {
      messages: [{ role: 'user', content: 'x' }],
      mode: 'thinking',
      maxTokens: 50,
      options: {},
    });
    expect(result.budgetHit).toBe(false);
    expect(fake.requests).toHaveLength(1);
  });
});
