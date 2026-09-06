/** OpenAI-style error envelope: `{ error: { message, type, code } }`. */
export type ErrorType =
  'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'upstream_error' | 'server_error';

export class ProxyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly type: ErrorType = defaultType(status),
    public readonly details?: unknown,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ProxyError';
  }

  toBody(): { error: { message: string; type: ErrorType; code: string; details?: unknown } } {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

function defaultType(status: number): ErrorType {
  if (status === 401) return 'authentication_error';
  if (status === 429 || status === 503) return 'rate_limit_error';
  if (status === 400 || status === 404 || status === 413) return 'invalid_request_error';
  if (status === 502 || status === 504) return 'upstream_error';
  return 'server_error';
}

export const invalidRequest = (message: string, details?: unknown): ProxyError =>
  new ProxyError(400, 'invalid_request_error', message, 'invalid_request_error', details);

export const isProxyError = (e: unknown): e is ProxyError => e instanceof ProxyError;
