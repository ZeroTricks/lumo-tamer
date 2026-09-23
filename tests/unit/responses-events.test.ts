import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { ResponseEventEmitter } from '../../src/api/routes/responses/events.js';
import { parseSSEEvents } from '../helpers/test-server.js';

function createEmitter() {
  let output = '';
  const response = {
    write: vi.fn((chunk: string) => {
      output += chunk;
      return true;
    }),
  } as unknown as Response;

  return {
    emitter: new ResponseEventEmitter(response),
    events: () => parseSSEEvents(output).map((event) => event.data as any),
  };
}

describe('ResponseEventEmitter reasoning events', () => {
  it('emits the reasoning start events in order', () => {
    const { emitter, events } = createEmitter();

    emitter.emitReasoningItemAdded('item-reasoning', 1);
    emitter.emitReasoningPartAdded('item-reasoning', 1, 0);

    expect(events()).toEqual([
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          id: 'item-reasoning',
          type: 'reasoning',
          status: 'in_progress',
          summary: [],
          content: [],
        },
        sequence_number: 0,
      },
      {
        type: 'response.content_part.added',
        item_id: 'item-reasoning',
        output_index: 1,
        content_index: 0,
        part: { type: 'reasoning_text', text: '' },
        sequence_number: 1,
      },
    ]);
  });

  it('emits a reasoning delta with its array indexes', () => {
    const { emitter, events } = createEmitter();

    emitter.emitReasoningTextDelta('item-reasoning', 1, 0, 'Think');

    expect(events()).toEqual([
      {
        type: 'response.reasoning_text.delta',
        item_id: 'item-reasoning',
        output_index: 1,
        content_index: 0,
        delta: 'Think',
        sequence_number: 0,
      },
    ]);
  });

  it('emits the reasoning completion events in order with the full text', () => {
    const { emitter, events } = createEmitter();

    emitter.emitReasoningTextDone('item-reasoning', 1, 0, 'Think carefully.');
    emitter.emitReasoningPartDone('item-reasoning', 1, 0, 'Think carefully.');
    emitter.emitReasoningItemDone('item-reasoning', 1, 'Think carefully.');

    expect(events()).toEqual([
      {
        type: 'response.reasoning_text.done',
        item_id: 'item-reasoning',
        output_index: 1,
        content_index: 0,
        text: 'Think carefully.',
        sequence_number: 0,
      },
      {
        type: 'response.content_part.done',
        item_id: 'item-reasoning',
        output_index: 1,
        content_index: 0,
        part: { type: 'reasoning_text', text: 'Think carefully.' },
        sequence_number: 1,
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          id: 'item-reasoning',
          type: 'reasoning',
          status: 'completed',
          summary: [],
          content: [{ type: 'reasoning_text', text: 'Think carefully.' }],
        },
        sequence_number: 2,
      },
    ]);
  });
});
