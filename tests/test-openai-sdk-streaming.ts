/**
 * OpenAI JS SDK streaming event validation test
 *
 * Validates that our /v1/responses endpoint produces SSE events
 * that the official OpenAI SDK can parse without errors.
 *
 * Prerequisites: lumo-tamer must be running (npm start)
 * Run with: npx tsx tests/test-openai-sdk-streaming.ts
 */

import OpenAI from 'openai';

const BASE_URL = process.env.LUMO_BASE_URL || 'http://localhost:3003/v1';
const API_KEY = process.env.LUMO_API_KEY || 'test-key';

const client = new OpenAI({
  baseURL: BASE_URL,
  apiKey: API_KEY,
});

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, passed: false, error: String(e) });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e}`);
  }
}

// Expected event sequence for a text-only streaming response
const EXPECTED_TEXT_ONLY_SEQUENCE = [
  'response.created',
  'response.in_progress',
  'response.output_item.added',
  'response.content_part.added',
  // ... zero or more response.output_text.delta ...
  'response.output_text.done',
  'response.content_part.done',
  'response.output_item.done',
  'response.completed',
];

async function testStreamingTextOnly() {
  console.log('\n--- Streaming text-only response ---');

  const eventTypes: string[] = [];
  let fullText = '';

  const stream = await client.responses.create({
    model: 'lumo',
    input: 'Say hello in one short sentence.',
    stream: true,
  });

  for await (const event of stream) {
    eventTypes.push(event.type);

    if (event.type === 'response.output_text.delta') {
      fullText += event.delta;
    }
  }

  console.log(`  Events received: ${eventTypes.length}`);
  console.log(`  Event types: ${eventTypes.join(', ')}`);
  console.log(`  Full text: "${fullText}"`);

  await test('receives response.created first', async () => {
    assert(eventTypes[0] === 'response.created', `expected response.created, got ${eventTypes[0]}`);
  });

  await test('receives response.in_progress second', async () => {
    assert(eventTypes[1] === 'response.in_progress', `expected response.in_progress, got ${eventTypes[1]}`);
  });

  await test('receives response.output_item.added', async () => {
    assert(eventTypes.includes('response.output_item.added'), 'missing response.output_item.added');
  });

  await test('receives response.content_part.added', async () => {
    assert(eventTypes.includes('response.content_part.added'), 'missing response.content_part.added');
  });

  await test('receives response.output_text.done', async () => {
    assert(eventTypes.includes('response.output_text.done'), 'missing response.output_text.done');
  });

  await test('receives response.content_part.done', async () => {
    assert(eventTypes.includes('response.content_part.done'), 'missing response.content_part.done');
  });

  await test('receives response.output_item.done for message', async () => {
    assert(eventTypes.includes('response.output_item.done'), 'missing response.output_item.done');
  });

  await test('receives response.completed last', async () => {
    assert(eventTypes[eventTypes.length - 1] === 'response.completed', `expected response.completed last, got ${eventTypes[eventTypes.length - 1]}`);
  });

  await test('event order matches spec', async () => {
    // Filter to non-delta events for order check
    const structural = eventTypes.filter(t => t !== 'response.output_text.delta');
    for (let i = 0; i < EXPECTED_TEXT_ONLY_SEQUENCE.length; i++) {
      assert(
        structural[i] === EXPECTED_TEXT_ONLY_SEQUENCE[i],
        `position ${i}: expected ${EXPECTED_TEXT_ONLY_SEQUENCE[i]}, got ${structural[i]}`
      );
    }
  });

  await test('has non-empty text', async () => {
    assert(fullText.length > 0, 'response text is empty');
  });

  await test('at least one text delta received', async () => {
    const deltaCount = eventTypes.filter(t => t === 'response.output_text.delta').length;
    assert(deltaCount > 0, 'no text deltas received');
  });
}

async function testNonStreaming() {
  console.log('\n--- Non-streaming response ---');

  const response = await client.responses.create({
    model: 'lumo',
    input: 'Say hello in one short sentence.',
  });

  await test('non-streaming returns completed response', async () => {
    assert(response.status === 'completed', `expected completed, got ${response.status}`);
  });

  await test('non-streaming has output', async () => {
    assert(response.output.length > 0, 'no output items');
  });

  await test('non-streaming has text', async () => {
    assert(response.output_text.length > 0, 'output_text is empty');
  });

  console.log(`  Text: "${response.output_text}"`);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`API key: ${API_KEY.slice(0, 4)}...`);

  try {
    await testStreamingTextOnly();
  } catch (e) {
    console.log(`\n  FATAL  Streaming test failed to run: ${e}`);
    results.push({ name: 'streaming test execution', passed: false, error: String(e) });
  }

  try {
    await testNonStreaming();
  } catch (e) {
    console.log(`\n  FATAL  Non-streaming test failed to run: ${e}`);
    results.push({ name: 'non-streaming test execution', passed: false, error: String(e) });
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
