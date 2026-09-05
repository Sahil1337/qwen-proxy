import type { Response } from 'express';

/**
 * Server-sent events writer in the shape the OpenAI SDK expects. Writes after
 * the client has gone are dropped silently; the request's abort signal is how
 * the pipeline learns about the disconnect.
 */
export class SseWriter {
  private closed = false;

  constructor(private readonly res: Response) {
    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.on('error', () => undefined);
    res.flushHeaders();
  }

  data(payload: unknown): void {
    this.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  done(): void {
    if (this.closed) return;
    this.write('data: [DONE]\n\n');
    this.closed = true;
    if (!this.res.writableEnded) this.res.end();
  }

  private write(text: string): void {
    if (this.closed || this.res.destroyed || this.res.writableEnded) return;
    this.res.write(text);
  }
}
