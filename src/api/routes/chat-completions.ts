import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { EndpointDependencies, OpenAIChatRequest, OpenAIStreamChunk, OpenAIChatResponse } from '../types.js';
import { serverConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { convertMessagesToTurns } from '../message-converter.js';
import { isCommand, executeCommand } from '../commands.js';
import type { Turn } from '../../lumo-client/index.js';

export function createChatCompletionsRouter(deps: EndpointDependencies): Router {
  const router = Router();

  router.post('/v1/chat/completions', async (req: Request, res: Response) => {
    try {
      const request: OpenAIChatRequest = req.body;

      // Validate request
      if (!request.messages || request.messages.length === 0) {
        return res.status(400).json({ error: 'Messages array is required' });
      }

      // Get the last user message
      const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
      if (!lastUserMessage) {
        return res.status(400).json({ error: 'No user message found' });
      }

      // Check for commands
      if (isCommand(lastUserMessage.content)) {
        const result = executeCommand(lastUserMessage.content);
        if (request.stream) {
          return handleCommandStreamingResponse(res, request, result.text);
        } else {
          return handleCommandNonStreamingResponse(res, request, result.text);
        }
      }

      // Convert messages to Lumo turns (includes system message injection)
      const turns = convertMessagesToTurns(request.messages);

      // Add to queue and process
      if (request.stream) {
        await handleStreamingRequest(res, deps, request, turns);
      } else {
        await handleNonStreamingRequest(res, deps, request, turns);
      }
    } catch (error) {
      logger.error('Error processing chat completion:');
      logger.error(error);
      res.status(500).json({ error: String(error) });
    }
  });

  return router;
}

function handleCommandStreamingResponse(
  res: Response,
  request: OpenAIChatRequest,
  text: string
): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // Send the text as a single chunk
  const chunk: OpenAIStreamChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: request.model || serverConfig.apiModelName,
    choices: [
      {
        index: 0,
        delta: { content: text },
        finish_reason: null,
      },
    ],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);

  // Send final chunk
  const finalChunk: OpenAIStreamChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: request.model || serverConfig.apiModelName,
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
}

function handleCommandNonStreamingResponse(
  res: Response,
  request: OpenAIChatRequest,
  text: string
): void {
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
          content: text,
        },
        finish_reason: 'stop',
      },
    ],
  };
  res.json(response);
}

async function handleStreamingRequest(
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIChatRequest,
  turns: Turn[]
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  await deps.queue.add(async () => {
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const client = deps.getLumoClient();

    try {
      await client.chatWithHistory(
        turns,
        (chunk: string) => {
          // logger.debug(`[Server] Sending delta (${chunk.length} chars)`);
          const sseChunk: OpenAIStreamChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: request.model || serverConfig.apiModelName,
            choices: [
              {
                index: 0,
                delta: { content: chunk },
                finish_reason: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
        },
        { enableEncryption: true, enableExternalTools: false }
      );
      logger.debug('[Server] Stream completed');

      // Send final chunk
      const finalChunk: OpenAIStreamChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: request.model || serverConfig.apiModelName,
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
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIChatRequest,
  turns: Turn[]
): Promise<void> {
  const result = await deps.queue.add(async () => {
    const client = deps.getLumoClient();
    return await client.chatWithHistory(
      turns,
      undefined,
      { enableEncryption: true, enableExternalTools: false }
    );
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
