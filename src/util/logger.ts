import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({ level, base: { service: 'qwen-proxy' } });
}

/** A logger that discards everything; used in tests. */
export const silentLogger: Logger = pino({ level: 'silent' });
