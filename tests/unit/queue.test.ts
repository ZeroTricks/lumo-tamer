/**
 * Unit tests for RequestQueue
 *
 * Tests the p-queue wrapper that serializes API requests.
 */

import { describe, it, expect } from 'vitest';
import { RequestQueue } from '../../src/api/queue.js';

describe('RequestQueue', () => {
  it('processes one request at a time', async () => {
    const queue = new RequestQueue(1);
    const order: number[] = [];

    const p1 = queue.add(async () => {
      order.push(1);
      await new Promise(r => setTimeout(r, 50));
      order.push(2);
      return 'first';
    });

    const p2 = queue.add(async () => {
      order.push(3);
      return 'second';
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe('first');
    expect(r2).toBe('second');
    // Second task should not start until first completes
    expect(order).toEqual([1, 2, 3]);
  });

  it('reports correct size and pending', async () => {
    const queue = new RequestQueue(1);

    // Add a blocking task
    let resolve!: () => void;
    const blocker = new Promise<void>(r => { resolve = r; });

    queue.add(() => blocker);
    queue.add(async () => {});

    // Give the queue a moment to start processing
    await new Promise(r => setTimeout(r, 10));

    expect(queue.getPending()).toBe(1);   // blocker is running
    expect(queue.getSize()).toBe(1);      // second task is queued

    resolve();
    await queue.waitForIdle();

    expect(queue.getPending()).toBe(0);
    expect(queue.getSize()).toBe(0);
  });

  it('waitForIdle resolves when queue is empty', async () => {
    const queue = new RequestQueue(1);

    await queue.add(async () => 'done');
    await queue.waitForIdle();

    expect(queue.getSize()).toBe(0);
    expect(queue.getPending()).toBe(0);
  });
});
