/**
 * Explicit thinking mode. Reasoning comes back in `reasoning_content`, never
 * in `content`. If the model overruns THINK_BUDGET_TOKENS the proxy forces an
 * answer and reports `think_budget_hit: true`.
 *
 *   bun examples/02-thinking.ts
 */
import { line, qwen } from './lib.js';

const completion = await qwen.chat({
  mode: 'thinking',
  max_tokens: 300,
  messages: [
    {
      role: 'user',
      content:
        'Two meeting notes disagree: one says the launch is March 3, the other March 10. The March 10 note is newer and mentions QA blockers. Which date is more likely correct, and what should we verify?',
    },
  ],
});

const msg = completion.choices[0]!.message;
line('budget hit', completion.meetiq.think_budget_hit);
line(
  'tokens',
  `${completion.usage.completion_tokens} total, ~${completion.usage.completion_tokens_details.reasoning_tokens} reasoning`,
);
console.log('\n--- reasoning\n' + msg.reasoning_content);
console.log('\n--- answer\n' + msg.content);
