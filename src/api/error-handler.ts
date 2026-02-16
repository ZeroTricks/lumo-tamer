import type { ErrorRequestHandler } from 'express';
import { logger } from '../app/logger.js';

function isPayloadTooLarge(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { status?: number; statusCode?: number; type?: string };
  return candidate.status === 413 || candidate.statusCode === 413 || candidate.type === 'entity.too.large';
}

function isInvalidJsonBody(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { status?: number; type?: string; body?: unknown };
  return candidate.status === 400 && candidate.type === 'entity.parse.failed' && candidate.body !== undefined;
}

export const setupApiErrorHandler = (): ErrorRequestHandler => {
  return (err, _req, res, next) => {
    if (isPayloadTooLarge(err)) {
      logger.warn({ err }, 'Request body exceeds parser limit');
      return res.status(413).json({
        error: {
          message: 'Request body too large for this server. Reduce payload size or increase server.bodyLimit',
          type: 'invalid_request_error',
          param: null,
          code: 'request_too_large',
        },
      });
    }

    if (isInvalidJsonBody(err)) {
      logger.warn({ err }, 'Malformed JSON request body');
      return res.status(400).json({
        error: {
          message: 'Malformed JSON in request body.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_json',
        },
      });
    }

    return next(err);
  };
};
