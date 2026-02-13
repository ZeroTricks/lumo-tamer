import { describe, it, expect, vi } from 'vitest';
import { sendInvalidRequest, sendServerError } from '../../src/api/openai-error.js';

function createMockResponse() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('openai-error helpers', () => {
  it('sendInvalidRequest returns 400 with OpenAI error shape', () => {
    const res = createMockResponse();

    sendInvalidRequest(res, 'messages must be a non-empty array', 'messages', 'missing_messages');

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: 'messages must be a non-empty array',
        type: 'invalid_request_error',
        param: 'messages',
        code: 'missing_messages',
      },
    });
  });

  it('sendServerError returns 500 with OpenAI server_error shape', () => {
    const res = createMockResponse();

    sendServerError(res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: 'The server encountered an error while processing your request.',
        type: 'server_error',
        param: null,
        code: null,
      },
    });
  });
});
