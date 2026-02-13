import { Response } from 'express';
import { OpenAIStreamChunk, OpenAIToolCall } from '../../types.js';

export class ChatCompletionEventEmitter {
  private res: Response;
  private id: string;
  private created: number;
  private model: string;
  private toolCallIndex = 0;

  constructor(res: Response, id: string, created: number, model: string) {
    this.res = res;
    this.id = id;
    this.created = created;
    this.model = model;
  }

  emitContentDelta(content: string): void {
    if (!content) return;
    const chunk: OpenAIStreamChunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
    this.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  emitToolCallDelta(callId: string, name: string, args: Record<string, unknown>): void {
    const chunk: OpenAIStreamChunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: this.toolCallIndex++,
            id: callId,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: null,
      }],
    };
    this.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  emitDone(toolCalls: OpenAIToolCall[] | undefined): void {
    const finalChunk: OpenAIStreamChunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
    };
    this.res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    this.res.write('data: [DONE]\n\n');
    this.res.end();
  }

  emitError(error: Error): void {
    const errorChunk = { error: { message: String(error), type: 'server_error' } };
    this.res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    this.res.end();
  }
}
