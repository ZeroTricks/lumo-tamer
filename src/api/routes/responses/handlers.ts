import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { EndpointDependencies, OpenAIResponseRequest } from '../../types.js';
import { serverConfig } from '../../../config.js';
import { logger } from '../../../logger.js';
import { ChatboxInteractor } from '../../../browser/chatbox.js';
import { ResponseEventEmitter } from './events.js';
import { buildOutputItems, ToolCall } from './output-builder.js';
import { createCompletedResponse } from './response-factory.js';

export async function handleStreamingRequest(
  req: Request,
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIResponseRequest,
  inputText: string,
  chatbox: ChatboxInteractor,
  createdCallIds: Set<string>
): Promise<void> {
  // Streaming response with event-based format
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  await deps.queue.add(async () => {
    const id = `resp-${randomUUID()}`;
    const itemId = `item-${randomUUID()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    let accumulatedText = '';

    const emitter = new ResponseEventEmitter(res);

    try {
      // Event 1: response.created
      emitter.emitResponseCreated(id, createdAt, request.model || serverConfig.apiModelName);

      // Event 2: response.in_progress
      emitter.emitResponseInProgress(id, createdAt);

      // Event 3: response.output_item.added
      emitter.emitOutputItemAdded(
        {
          id: itemId,
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
        0
      );

      // Event 4: response.content_part.added
      emitter.emitContentPartAdded(itemId, 0, 0);

      // Get response (handles both commands and regular messages)
      const result = await chatbox.getResponse(inputText, (delta: string) => {
        logger.debug(`[Server] Sending delta ( ${delta.length} chars)`);
        accumulatedText += delta;

        // Event 5+: response.output_text.delta (multiple)
        emitter.emitOutputTextDelta(itemId, 0, 0, delta);
      });
      logger.debug('[Server] Stream completed');

      // Update accumulated text from result (in case of discrepancy)
      accumulatedText = result.text;

      // Event N-4: response.output_text.done
      emitter.emitOutputTextDone(itemId, 0, 0, accumulatedText);

      // Emit function call events if tool calls are present
      if (result.toolCalls) {
        for (let i = 0; i < result.toolCalls.length; i++) {
          const toolCall = result.toolCalls[i];
          const fcId = `fc-${randomUUID()}`;
          const callId = `call-${randomUUID()}`;

          // Track this call_id as one we created
          createdCallIds.add(callId);

          // Ensure arguments are JSON-encoded string
          const argumentsJson = typeof toolCall.arguments === 'string'
            ? toolCall.arguments
            : JSON.stringify(toolCall.arguments);

          emitter.emitFunctionCallEvents(fcId, callId, toolCall.name, argumentsJson, 1 + i);
        }
      }

      // Build output array with message and function_call items
      const output = buildOutputItems({
        text: accumulatedText,
        toolCalls: result.toolCalls,
        itemId,
        createdCallIds,
      });

      // Event N-1: response.completed
      const completedResponse = createCompletedResponse(id, createdAt, request, output);
      emitter.emitResponseCompleted(completedResponse);

      res.end();
    } catch (error) {
      emitter.emitError(error as Error);
      res.end();
    }
  });
}

export async function handleNonStreamingRequest(
  req: Request,
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIResponseRequest,
  inputText: string,
  chatbox: ChatboxInteractor,
  createdCallIds: Set<string>
): Promise<void> {
  // Non-streaming response
  const result = await deps.queue.add(async () => {
    return await chatbox.getResponse(inputText);
  });

  const id = `resp-${randomUUID()}`;
  const itemId = `item-${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);

  // Build output array with message and function_call items
  const output = buildOutputItems({
    text: result.text,
    toolCalls: result.toolCalls,
    itemId,
    createdCallIds,
  });

  const response = createCompletedResponse(id, createdAt, request, output);

  res.json(response);
}
