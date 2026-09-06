import PQueue from 'p-queue';
import { ProxyError } from './errors.js';

/** Seconds a caller should wait before retrying after a queue timeout. */
const RETRY_AFTER_SECONDS = 10;

/**
 * Bounded concurrency in front of Ollama. A task that waits longer than
 * `waitTimeoutMs` for a slot is rejected with 503; once running it is never
 * interrupted by the queue.
 */
export class RequestQueue {
  private readonly queue: PQueue;

  constructor(
    concurrency: number,
    private readonly waitTimeoutMs: number,
  ) {
    this.queue = new PQueue({ concurrency });
  }

  /** Tasks waiting for a slot. */
  get waiting(): number {
    return this.queue.size;
  }

  /** Tasks currently running. */
  get running(): number {
    return this.queue.pending;
  }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const giveUp = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const timer = setTimeout(
        () =>
          giveUp(
            new ProxyError(503, 'queue_timeout', 'Server is busy; try again later', 'rate_limit_error', undefined, {
              'retry-after': String(RETRY_AFTER_SECONDS),
            }),
          ),
        this.waitTimeoutMs,
      );
      const onAbort = () => giveUp(new ProxyError(499, 'client_closed_request', 'Client closed the request'));
      signal?.addEventListener('abort', onAbort, { once: true });

      void this.queue.add(async () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        try {
          resolve(await task());
        } catch (err) {
          reject(err);
        }
      });
    });
  }
}
