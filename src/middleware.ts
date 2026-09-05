import { timingSafeEqual } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ProxyError, isProxyError } from './core/errors.js';
import { newRequestId } from './util/ids.js';
import type { Logger } from './util/logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export const asyncHandler =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Accepts a caller-supplied `x-request-id` or mints one; always echoes it. */
export const requestId = (): RequestHandler => (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.id = incoming && REQUEST_ID_RE.test(incoming) ? incoming : newRequestId();
  res.setHeader('x-request-id', req.id);
  next();
};

export const bearerAuth = (apiKey: string | undefined): RequestHandler => {
  if (!apiKey) return (_req, _res, next) => next();
  const expected = Buffer.from(apiKey);
  return (req, _res, next) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const supplied = Buffer.from(token);
    const ok = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    next(ok ? undefined : new ProxyError(401, 'invalid_api_key', 'Missing or invalid API key'));
  };
};

export const notFound: RequestHandler = (req, _res, next) => {
  next(new ProxyError(404, 'not_found', `No route for ${req.method} ${req.path}`));
};

export function toProxyError(err: unknown): ProxyError {
  if (isProxyError(err)) return err;
  const e = err as { type?: string; status?: number; message?: string };
  if (e.type === 'entity.too.large') return new ProxyError(413, 'request_too_large', 'Request body exceeds 2 MB');
  if (e.type === 'entity.parse.failed') return new ProxyError(400, 'invalid_json', 'Request body is not valid JSON');
  return new ProxyError(500, 'internal_error', 'Internal server error');
}

export const errorHandler =
  (log: Logger): ErrorRequestHandler =>
  (err, req, res, _next) => {
    const proxyError = toProxyError(err);
    if (proxyError.status >= 500 && proxyError.code === 'internal_error') {
      log.error({ err, request_id: req.id }, 'unhandled error');
    }
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    for (const [name, value] of Object.entries(proxyError.headers)) res.setHeader(name, value);
    res.status(proxyError.status).json(proxyError.toBody());
  };
