import { Response } from 'express';
import { randomUUID } from 'crypto';
import { ResponseStreamEvent, OpenAIResponse } from '../../types.js';

export class ResponseEventEmitter {
  private res: Response;
  private sequenceNumber: number = 0;

  constructor(res: Response) {
    this.res = res;
  }

  private emit(event: ResponseStreamEvent): void {
    this.res.write(`event: ${event.type}\n`);
    this.res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  emitResponseCreated(responseId: string, createdAt: number, model: string): void {
    this.emit({
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        status: 'in_progress',
        created_at: createdAt,
        model,
      },
      sequence_number: this.sequenceNumber++,
    });
  }

  emitResponseInProgress(responseId: string, createdAt: number): void {
    this.emit({
      type: 'response.in_progress',
      response: {
        id: responseId,
        object: 'response',
        status: 'in_progress',
        created_at: createdAt,
      },
      sequence_number: this.sequenceNumber++,
    });
  }

  emitOutputItemAdded(item: any, outputIndex: number): void {
    this.emit({
      type: 'response.output_item.added',
      item,
      output_index: outputIndex,
      sequence_number: this.sequenceNumber++,
    });
  }

  emitContentPartAdded(itemId: string, outputIndex: number, contentIndex: number): void {
    this.emit({
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      part: {
        type: 'output_text',
        text: '',
      },
      sequence_number: this.sequenceNumber++,
    });
  }

  emitOutputTextDelta(itemId: string, outputIndex: number, contentIndex: number, delta: string): void {
    this.emit({
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      delta,
      sequence_number: this.sequenceNumber++,
    });
  }

  emitOutputTextDone(itemId: string, outputIndex: number, contentIndex: number, text: string): void {
    this.emit({
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      text,
      sequence_number: this.sequenceNumber++,
    });
  }

  emitFunctionCallEvents(fcId: string, callId: string, name: string, args: string, outputIndex: number): void {
    // Event: response.output_item.added (for function call)
    this.emit({
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        id: fcId,
        call_id: callId,
        status: 'in_progress',
        name,
        arguments: '',
      },
      output_index: outputIndex,
      sequence_number: this.sequenceNumber++,
    });

    // Event: response.function_call_arguments.delta
    this.emit({
      type: 'response.function_call_arguments.delta',
      item_id: fcId,
      output_index: outputIndex,
      delta: args,
      sequence_number: this.sequenceNumber++,
    });

    // Event: response.function_call_arguments.done
    this.emit({
      type: 'response.function_call_arguments.done',
      item_id: fcId,
      output_index: outputIndex,
      arguments: args,
      sequence_number: this.sequenceNumber++,
    });

    // Event: response.output_item.done
    this.emit({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        id: fcId,
        call_id: callId,
        status: 'completed',
        name,
        arguments: args,
      },
      output_index: outputIndex,
      sequence_number: this.sequenceNumber++,
    });
  }

  emitResponseCompleted(response: OpenAIResponse): void {
    this.emit({
      type: 'response.completed',
      response,
      sequence_number: this.sequenceNumber++,
    });
  }

  emitError(error: Error): void {
    this.emit({
      type: 'error',
      code: 'server_error',
      message: String(error),
      param: null,
      sequence_number: this.sequenceNumber++,
    });
  }
}
