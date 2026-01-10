import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { EndpointDependencies, OpenAIChatRequest, OpenAIStreamChunk, OpenAIChatResponse } from '../types.js';
import { serverConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { ChatboxInteractor } from '../../browser/chatbox.js';
import { handleInstructions } from '../instructions.js';

export function createChatCompletionsRouter(deps: EndpointDependencies): Router {
  const router = Router();

  router.post('/v1/chat/completions', async (req: Request, res: Response) => {
    try {
      const request: OpenAIChatRequest = req.body;

      // Validate request
      if (!request.messages || request.messages.length === 0) {
        return res.status(400).json({ error: 'Messages array is required' });
      }

      // Handle developer message if present
      await handleInstructions(request, deps);

      // Get the last user message
      const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
      if (!lastUserMessage) {
        return res.status(400).json({ error: 'No user message found' });
      }

      const chatbox = await deps.getChatbox();

      // Add to queue and process
      if (request.stream) {
        await handleStreamingRequest(req, res, deps, request, lastUserMessage.content, chatbox);
      } else {
        await handleNonStreamingRequest(req, res, deps, request, lastUserMessage.content, chatbox);
      }
    } catch (error) {
      logger.error('Error processing chat completion:');
      logger.error(error);
      res.status(500).json({ error: String(error) });
    }
  });

  return router;
}

async function handleStreamingRequest(
  req: Request,
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIChatRequest,
  message: string,
  chatbox: ChatboxInteractor
) {
  // Streaming response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  await deps.queue.add(async () => {
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    try {
      // Get response (handles both commands and regular messages)
      await chatbox.getResponse(message, (delta: string) => {
        logger.debug(`[Server] Sending delta (${delta.length} chars)`);
        const chunk: OpenAIStreamChunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: request.model || 'lumo',
          choices: [
            {
              index: 0,
              delta: { content: delta },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      });
      logger.debug('[Server] Stream completed');

      // Send final chunk
      const finalChunk: OpenAIStreamChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: request.model || 'lumo',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      const errorChunk = {
        error: {
          message: String(error),
          type: 'server_error',
        },
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.end();
    }
  });
}

async function handleNonStreamingRequest(
  req: Request,
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIChatRequest,
  message: string,
  chatbox: ChatboxInteractor
) {
  // Non-streaming response
  const result = await deps.queue.add(async () => {
    return await chatbox.getResponse(message);
  });

  const response: OpenAIChatResponse = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: request.model || serverConfig.apiModelName,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result,
        },
        finish_reason: 'stop',
      },
    ],
  };

  res.json(response);
}
