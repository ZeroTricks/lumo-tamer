import { Router, Request, Response } from 'express';
import { EndpointDependencies, OpenAIResponseRequest, FunctionCallOutput } from '../../types.js';
import { logger } from '../../../logger.js';
import { handleStreamingRequest, handleNonStreamingRequest } from './handlers.js';
import { createEmptyResponse } from './response-factory.js';
import { convertResponseInputToTurns } from '../../message-converter.js';
import { isCommand, executeCommand } from '../../commands.js';
import type { Turn } from '../../../lumo-client/index.js';

export function createResponsesRouter(deps: EndpointDependencies): Router {
  const router = Router();

  // Track last processed user message to avoid duplicate processing
  let lastProcessedUserMessage: string | null = null;

  // Track function call outputs and call_ids we created
  let lastProcessedFunctionOutputCallId: string | null = null;
  const createdCallIds = new Set<string>();

  router.post('/v1/responses', async (req: Request, res: Response) => {
    try {
      const request: OpenAIResponseRequest = req.body;

      // Check for function_call_output in input array
      // Note: Tool calls are not supported in API mode, but we keep the deduplication logic
      // in case tool calls are added later
      if (Array.isArray(request.input)) {
        const functionOutputs = request.input
          .filter((item): item is FunctionCallOutput =>
            typeof item === 'object' && 'type' in item && item.type === 'function_call_output'
          )
          .filter((item) => createdCallIds.has(item.call_id));

        // Get the last function output if any
        const lastFunctionOutput = functionOutputs[functionOutputs.length - 1];

        if (lastFunctionOutput) {
          // Check if this call_id is different from last processed
          if (lastFunctionOutput.call_id !== lastProcessedFunctionOutputCallId) {
            lastProcessedFunctionOutputCallId = lastFunctionOutput.call_id;

            logger.debug(`[Server] Processing function_call_output for call_id: ${lastFunctionOutput.call_id}`);

            // Convert function output to a turn
            const outputString = JSON.stringify(lastFunctionOutput);
            const turns: Turn[] = [{ role: 'user', content: outputString }];

            if (request.stream) {
              await handleStreamingRequest(req, res, deps, request, turns, createdCallIds);
            } else {
              await handleNonStreamingRequest(req, res, deps, request, turns, createdCallIds);
            }
            return; // Early return after processing
          }
          // If duplicate function_call_output, continue to check user message
          logger.debug('[Server] Skipping duplicate function_call_output, checking for user message');
        }
      }

      // Extract input text for command checking and deduplication
      let inputText: string;
      if (typeof request.input === 'string') {
        inputText = request.input;
      } else if (Array.isArray(request.input)) {
        // Get the last user message from array
        const lastUserMessage = [...request.input].reverse().find((m): m is { role: string; content: string } =>
          typeof m === 'object' && 'role' in m && m.role === 'user'
        );
        if (!lastUserMessage) {
          return res.status(400).json({ error: 'No user message found in input array' });
        }
        inputText = lastUserMessage.content;
      } else {
        return res.status(400).json({ error: 'Input is required (string or message array)' });
      }

      // Check if this message has already been processed
      if (inputText === lastProcessedUserMessage) {
        logger.debug('[Server] Skipping duplicate user message');
        return res.json(createEmptyResponse(request));
      }

      // Update last processed message
      lastProcessedUserMessage = inputText;

      // Check for commands - return error for commands in API mode
      if (isCommand(inputText)) {
        const result = executeCommand(inputText);
        logger.info(`Command received: ${inputText}, response: ${result.text}`);
        return res.status(400).json({
          error: {
            message: result.text,
            type: 'invalid_request_error',
          }
        });
      }

      // Convert input to turns (includes instructions injection)
      const turns = convertResponseInputToTurns(request.input, request.instructions);

      // Add to queue and process
      if (request.stream) {
        await handleStreamingRequest(req, res, deps, request, turns, createdCallIds);
      } else {
        await handleNonStreamingRequest(req, res, deps, request, turns, createdCallIds);
      }
    } catch (error) {
      logger.error('Error processing response:');
      logger.error(error);
      res.status(500).json({ error: String(error) });
    }
  });

  return router;
}
