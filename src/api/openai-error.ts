import type { Response } from 'express';

interface OpenAIErrorBody {
  error: {
    message: string;
    type: 'invalid_request_error' | 'server_error';
    param: string | null;
    code: string | null;
  };
}

export function sendInvalidRequest(
  res: Response,
  message: string,
  param: string | null = null,
  code: string | null = 'invalid_request'
): Response<OpenAIErrorBody> {
  return res.status(400).json({
    error: {
      message,
      type: 'invalid_request_error',
      param,
      code,
    },
  });
}

export function sendServerError(
  res: Response,
  message = 'The server encountered an error while processing your request.'
): Response<OpenAIErrorBody> {
  return res.status(500).json({
    error: {
      message,
      type: 'server_error',
      param: null,
      code: null,
    },
  });
}
