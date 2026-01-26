import { randomUUID } from 'crypto';
import { OutputItem, MessageOutputItem, FunctionCallOutputItem } from '../../types.js';

export interface ToolCall {
  name: string;
  arguments: string | object;
}

export interface BuildOutputOptions {
  text: string;
  toolCalls?: ToolCall[] | null;
  itemId?: string;
  generatedCallIds?: Set<string>;
}

export function buildOutputItems(options: BuildOutputOptions): OutputItem[] {
  const { text, toolCalls, itemId, generatedCallIds } = options;

  const messageItem = buildMessageItem(itemId || `item-${randomUUID()}`, text);
  const output: OutputItem[] = [messageItem];

  if (toolCalls && toolCalls.length > 0) {
    const functionCallItems = buildFunctionCallItems(toolCalls, generatedCallIds);
    output.push(...functionCallItems);
  }

  return output;
}

export function buildMessageItem(itemId: string, text: string): MessageOutputItem {
  return {
    type: 'message',
    id: itemId,
    status: 'completed',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text,
        annotations: [],
      },
    ],
  };
}

export function buildFunctionCallItems(
  toolCalls: ToolCall[],
  generatedCallIds?: Set<string>
): FunctionCallOutputItem[] {
  return toolCalls.map(toolCall => {
    const callId = `call-${randomUUID()}`;

    // Track this call_id if Set was provided
    if (generatedCallIds) {
      generatedCallIds.add(callId);
    }

    // Ensure arguments are JSON-encoded string
    const argumentsJson = typeof toolCall.arguments === 'string'
      ? toolCall.arguments
      : JSON.stringify(toolCall.arguments);

    return {
      type: 'function_call',
      id: `fc-${randomUUID()}`,
      call_id: callId,
      status: 'completed',
      name: toolCall.name,
      arguments: argumentsJson,
    };
  });
}
