/**
 * Error handling and health. Every proxy error is thrown as `QwenProxyError`
 * with the proxy's status and code, so a backend can branch on it: retry on
 * `queue_timeout` after `retryAfterSeconds`, chunk the input on
 * `context_length_exceeded`, and so on.
 *
 *   bun examples/08-errors-and-health.ts
 */
import { QwenProxyError } from '../src/client/index.js';
import { line, qwen } from './lib.js';

const health = await qwen.health();
line(
  'proxy',
  `${health.status}, model loaded=${health.model.loaded}, queue ${health.queue.running}/${health.queue.concurrency} running`,
);

try {
  await qwen.chat({ messages: [{ role: 'user', content: 'x'.repeat(40_000) }] });
} catch (err) {
  if (err instanceof QwenProxyError) {
    line('status', err.status);
    line('code', err.code); // context_length_exceeded -> split the input and retry
    line('message', err.message);
    if (err.retryAfterSeconds) line('retry after', `${err.retryAfterSeconds}s`);
  } else {
    throw err;
  }
}
