/**
 * Streaming with `qwen.stream()`. Thinking tokens arrive as
 * `delta.reasoning_content`, answer tokens as `delta.content`; the final
 * chunk carries usage and meetiq. With `tools` or `response_format` the proxy
 * buffers and sends one chunk.
 *
 *   bun examples/05-streaming.ts
 */
import { qwen } from './lib.js';

let phase = '';
for await (const chunk of qwen.stream({
  messages: [{ role: 'user', content: 'Explain in two sentences why a small model benefits from a thinking budget.' }],
})) {
  const choice = chunk.choices[0]!;
  if (choice.delta.reasoning_content) {
    if (phase !== 'reasoning') process.stdout.write('\n[reasoning] ');
    phase = 'reasoning';
    process.stdout.write(choice.delta.reasoning_content);
  }
  if (choice.delta.content) {
    if (phase !== 'answer') process.stdout.write('\n\n[answer] ');
    phase = 'answer';
    process.stdout.write(choice.delta.content);
  }
  if (choice.finish_reason) {
    console.log(
      `\n\nfinish=${choice.finish_reason} tokens=${chunk.usage?.completion_tokens} speed=${chunk.meetiq?.timing.eval_tps} tok/s`,
    );
  }
}
