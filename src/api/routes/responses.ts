import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { EndpointDependencies, OpenAIResponseRequest, OpenAIResponse, ResponseStreamEvent } from '../types.js';
import { serverConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { ChatboxInteractor } from '../../browser/chatbox.js';

export function createResponsesRouter(deps: EndpointDependencies): Router {
  const router = Router();

  router.post('/v1/responses', async (req: Request, res: Response) => {
    try {
      const request: OpenAIResponseRequest = req.body;

      // Extract input text
      let inputText: string;
      if (typeof request.input === 'string') {
        inputText = request.input;
      } else if (Array.isArray(request.input)) {
        // Get the last user message from array
        const lastUserMessage = [...request.input].reverse().find(m => m.role === 'user');
        if (!lastUserMessage) {
          return res.status(400).json({ error: 'No user message found in input array' });
        }
        inputText = lastUserMessage.content;
      } else {
        return res.status(400).json({ error: 'Input is required (string or message array)' });
      }

      const chatbox = await deps.getChatbox();

      // Add to queue and process
      if (request.stream) {
        await handleStreamingRequest(req, res, deps, request, inputText, chatbox);
      } else {
        await handleNonStreamingRequest(req, res, deps, request, inputText, chatbox);
      }
    } catch (error) {
      logger.error('Error processing response:');
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
  request: OpenAIResponseRequest,
  inputText: string,
  chatbox: ChatboxInteractor
) {
  // Streaming response with event-based format
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  await deps.queue.add(async () => {
    const id = `resp-${randomUUID()}`;
    const itemId = `item-${randomUUID()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    let sequenceNumber = 0;
    let accumulatedText = '';

    const emitEvent = (event: ResponseStreamEvent) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      // Event 1: response.created
      emitEvent({
        type: 'response.created',
        response: {
          id,
          object: 'response',
          status: 'in_progress',
          created_at: createdAt,
          model: request.model || serverConfig.modelName,
        },
        sequence_number: sequenceNumber++,
      });

      // Event 2: response.in_progress
      emitEvent({
        type: 'response.in_progress',
        response: {
          id,
          object: 'response',
          status: 'in_progress',
          created_at: createdAt,
        },
        sequence_number: sequenceNumber++,
      });

      // Event 3: response.output_item.added
      emitEvent({
        type: 'response.output_item.added',
        item: {
          id: itemId,
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
        output_index: 0,
        sequence_number: sequenceNumber++,
      });

      // Event 4: response.content_part.added
      emitEvent({
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: {
          type: 'output_text',
          text: '',
        },
        sequence_number: sequenceNumber++,
      });

      // Get response (handles both commands and regular messages)
      await chatbox.getResponse(inputText, (delta: string) => {
        logger.debug(`[Server] Sending delta ( ${delta.length} chars)`);
        accumulatedText += delta;

        // Event 5+: response.output_text.delta (multiple)
        emitEvent({
          type: 'response.output_text.delta',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta,
          sequence_number: sequenceNumber++,
        });
      });
      logger.debug('[Server] Stream completed');

      // Event N-4: response.output_text.done
      emitEvent({
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text: accumulatedText,
        sequence_number: sequenceNumber++,
      });

      // Event N-1: response.completed
      const completedResponse: OpenAIResponse = {
        id,
        object: 'response',
        created_at: createdAt,
        status: 'completed',
        completed_at: Math.floor(Date.now() / 1000),
        error: null,
        incomplete_details: null,
        instructions: request.instructions || null,
        max_output_tokens: request.max_output_tokens || null,
        model: request.model || serverConfig.modelName,
        output: [
          {
            type: 'message',
            id: itemId,
            status: 'completed',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: accumulatedText,
                annotations: [],
              },
            ],
          },
        ],
        parallel_tool_calls: false,
        previous_response_id: null,
        reasoning: {
          effort: null,
          summary: null,
        },
        store: request.store || false,
        temperature: request.temperature || 1.0,
        text: {
          format: {
            type: 'text',
          },
        },
        tool_choice: 'none',
        tools: [],
        top_p: 1.0,
        truncation: 'auto',
        usage: null,
        user: null,
        metadata: request.metadata || {},
      };

      emitEvent({
        type: 'response.completed',
        response: completedResponse,
        sequence_number: sequenceNumber++,
      });

      res.end();
    } catch (error) {
      emitEvent({
        type: 'error',
        code: 'server_error',
        message: String(error),
        param: null,
        sequence_number: sequenceNumber++,
      });
      res.end();
    }
  });
}

async function handleNonStreamingRequest(
  req: Request,
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIResponseRequest,
  inputText: string,
  chatbox: ChatboxInteractor
) {
  // Non-streaming response
  const result = await deps.queue.add(async () => {
    return await chatbox.getResponse(inputText);
  });

  const id = `resp-${randomUUID()}`;
  const itemId = `item-${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);

  const response: OpenAIResponse = {
    id,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    completed_at: Math.floor(Date.now() / 1000),
    error: null,
    incomplete_details: null,
    instructions: request.instructions || null,
    max_output_tokens: request.max_output_tokens || null,
    model: request.model || serverConfig.modelName,
    output: [
      {
        type: 'message',
        id: itemId,
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: result,
            annotations: [],
          },
        ],
      },
    ],
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: {
      effort: null,
      summary: null,
    },
    store: request.store || false,
    temperature: request.temperature || 1.0,
    text: {
      format: {
        type: 'text',
      },
    },
    tool_choice: 'none',
    tools: [],
    top_p: 1.0,
    truncation: 'auto',
    usage: null,
    user: null,
    metadata: request.metadata || {},
  };

  res.json(response);
}
