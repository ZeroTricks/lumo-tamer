/**
 * Unit tests for StreamingToolDetector
 *
 * Tests the state machine that detects JSON tool calls in streaming text,
 * supporting both code fence (```json) and raw JSON formats.
 *
 * Run with: npx tsx tests/streaming-tool-detector.test.ts
 */

import { StreamingToolDetector } from '../src/api/streaming-tool-detector.js';
import { initLogger } from '../src/app/logger.js';

initLogger({ level: 'warn', target: 'stdout', filePath: '', messageContent: false }, { consoleShim: false });

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, passed: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, passed: false, error: String(e) });
    console.log(`✗ ${name}`);
    console.log(`  ${e}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`);
  }
}

// Test 1: Code fence detection
test('detects tool call in code fence format', () => {
  const detector = new StreamingToolDetector();

  const chunks = [
    'Here is the result: ',
    '```json\n{"name":"get_weather",',
    '"arguments":{"city":"Paris"}}',
    '```',
    ' Done!',
  ];

  let allText = '';
  const allToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  for (const chunk of chunks) {
    const result = detector.processChunk(chunk);
    allText += result.textToEmit;
    allToolCalls.push(...result.completedToolCalls);
  }

  const final = detector.finalize();
  allText += final.textToEmit;
  allToolCalls.push(...final.completedToolCalls);

  assert(allToolCalls.length === 1, `Expected 1 tool call, got ${allToolCalls.length}`);
  assertEqual(allToolCalls[0].name, 'get_weather', 'Tool name mismatch');
  assertEqual(allToolCalls[0].arguments, { city: 'Paris' }, 'Tool arguments mismatch');
  assert(allText.includes('Here is the result:'), 'Missing prefix text');
  assert(allText.includes('Done!'), 'Missing suffix text');
  assert(!allText.includes('get_weather'), 'Tool JSON should be stripped from text');
});

// Test 2: Raw JSON detection
test('detects tool call in raw JSON format', () => {
  const detector = new StreamingToolDetector();

  const chunks = [
    'I will call the function:\n',
    '{"name":"search",',
    '"arguments":{"query":"test"}}',
    '\nDone',
  ];

  let allText = '';
  const allToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  for (const chunk of chunks) {
    const result = detector.processChunk(chunk);
    allText += result.textToEmit;
    allToolCalls.push(...result.completedToolCalls);
  }

  const final = detector.finalize();
  allText += final.textToEmit;
  allToolCalls.push(...final.completedToolCalls);

  assert(allToolCalls.length === 1, `Expected 1 tool call, got ${allToolCalls.length}`);
  assertEqual(allToolCalls[0].name, 'search', 'Tool name mismatch');
  assertEqual(allToolCalls[0].arguments, { query: 'test' }, 'Tool arguments mismatch');
});

// Test 3: Non-tool JSON passes through as text
test('non-tool JSON passes through as text', () => {
  const detector = new StreamingToolDetector();

  const chunks = [
    'Here is some config:\n',
    '{"foo":"bar","baz":123}',
    '\nEnd',
  ];

  let allText = '';
  const allToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  for (const chunk of chunks) {
    const result = detector.processChunk(chunk);
    allText += result.textToEmit;
    allToolCalls.push(...result.completedToolCalls);
  }

  const final = detector.finalize();
  allText += final.textToEmit;
  allToolCalls.push(...final.completedToolCalls);

  assert(allToolCalls.length === 0, `Expected 0 tool calls, got ${allToolCalls.length}`);
  assert(allText.includes('foo'), 'Non-tool JSON should be in text output');
  assert(allText.includes('bar'), 'Non-tool JSON should be in text output');
});

// Test 4: Multiple tool calls
test('detects multiple tool calls', () => {
  const detector = new StreamingToolDetector();

  const input = `First tool:
\`\`\`json
{"name":"tool1","arguments":{"a":1}}
\`\`\`
Second tool:
\`\`\`json
{"name":"tool2","arguments":{"b":2}}
\`\`\`
Done`;

  const result = detector.processChunk(input);
  const final = detector.finalize();

  const allToolCalls = [...result.completedToolCalls, ...final.completedToolCalls];

  assert(allToolCalls.length === 2, `Expected 2 tool calls, got ${allToolCalls.length}`);
  assertEqual(allToolCalls[0].name, 'tool1', 'First tool name mismatch');
  assertEqual(allToolCalls[1].name, 'tool2', 'Second tool name mismatch');
});

// Test 5: Nested braces in arguments
test('handles nested braces in arguments', () => {
  const detector = new StreamingToolDetector();

  const input = `{"name":"complex","arguments":{"nested":{"deep":{"value":42}}}}`;

  // Simulate streaming with newline prefix for raw JSON detection
  const result = detector.processChunk('\n' + input);
  const final = detector.finalize();

  const allToolCalls = [...result.completedToolCalls, ...final.completedToolCalls];

  assert(allToolCalls.length === 1, `Expected 1 tool call, got ${allToolCalls.length}`);
  assertEqual(allToolCalls[0].name, 'complex', 'Tool name mismatch');
  assertEqual(
    allToolCalls[0].arguments,
    { nested: { deep: { value: 42 } } },
    'Nested arguments mismatch'
  );
});

// Test 6: Incomplete JSON at stream end emits as text
test('incomplete JSON at stream end emits as text', () => {
  const detector = new StreamingToolDetector();

  const chunks = ['```json\n{"name":"incomplete",', '"arguments":{'];

  let allText = '';
  const allToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  for (const chunk of chunks) {
    const result = detector.processChunk(chunk);
    allText += result.textToEmit;
    allToolCalls.push(...result.completedToolCalls);
  }

  const final = detector.finalize();
  allText += final.textToEmit;
  allToolCalls.push(...final.completedToolCalls);

  assert(allToolCalls.length === 0, 'Incomplete JSON should not be a tool call');
  assert(allText.includes('incomplete'), 'Incomplete JSON should be emitted as text');
});

// Test 7: Code fence without json tag
test('detects tool call in code fence without json tag', () => {
  const detector = new StreamingToolDetector();

  const input = '```\n{"name":"notag","arguments":{}}\n```';

  const result = detector.processChunk(input);
  const final = detector.finalize();

  const allToolCalls = [...result.completedToolCalls, ...final.completedToolCalls];

  assert(allToolCalls.length === 1, `Expected 1 tool call, got ${allToolCalls.length}`);
  assertEqual(allToolCalls[0].name, 'notag', 'Tool name mismatch');
});

// Test 8: Escaped quotes in string arguments
test('handles escaped quotes in arguments', () => {
  const detector = new StreamingToolDetector();

  const input = '\n{"name":"quote_test","arguments":{"text":"say \\"hello\\" world"}}';

  const result = detector.processChunk(input);
  const final = detector.finalize();

  const allToolCalls = [...result.completedToolCalls, ...final.completedToolCalls];

  assert(allToolCalls.length === 1, `Expected 1 tool call, got ${allToolCalls.length}`);
  assertEqual(allToolCalls[0].arguments, { text: 'say "hello" world' }, 'Escaped quotes not handled');
});

// Test 9: Raw JSON with character-by-character streaming (Lumo-like)
test('detects raw JSON tool call with character-by-character streaming', () => {
  const detector = new StreamingToolDetector();
  const json = '{\n  "name": "HassTurnOff",\n  "arguments": {\n    "name": "office"\n  }\n}';

  let allText = '';
  const allToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  for (let i = 0; i < json.length; i++) {
    const result = detector.processChunk(json[i]);
    allText += result.textToEmit;
    allToolCalls.push(...result.completedToolCalls);
  }

  const final = detector.finalize();
  allText += final.textToEmit;
  allToolCalls.push(...final.completedToolCalls);

  assert(allToolCalls.length === 1, `Expected 1 tool call, got ${allToolCalls.length}`);
  assertEqual(allToolCalls[0].name, 'HassTurnOff', 'Tool name mismatch');
  assertEqual(allToolCalls[0].arguments, { name: 'office' }, 'Tool arguments mismatch');
});

// Test 10: Raw JSON with small chunks that split strings mid-value
test('detects raw JSON tool call with chunks splitting strings', () => {
  const detector = new StreamingToolDetector();
  // Simulate chunks that split mid-string (like encrypted Lumo streaming)
  const chunks = [
    '{\n  "na',
    'me": "Has',
    'sTurnOff",\n  "argu',
    'ments": {\n    "na',
    'me": "off',
    'ice"\n  }\n}',
  ];

  let allText = '';
  const allToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  for (const chunk of chunks) {
    const result = detector.processChunk(chunk);
    allText += result.textToEmit;
    allToolCalls.push(...result.completedToolCalls);
  }

  const final = detector.finalize();
  allText += final.textToEmit;
  allToolCalls.push(...final.completedToolCalls);

  assert(allToolCalls.length === 1, `Expected 1 tool call, got ${allToolCalls.length}`);
  assertEqual(allToolCalls[0].name, 'HassTurnOff', 'Tool name mismatch');
  assertEqual(allToolCalls[0].arguments, { name: 'office' }, 'Tool arguments mismatch');
});

// Test 11: Raw JSON with string containing braces (regression)
test('raw JSON handles strings containing brace characters', () => {
  const detector = new StreamingToolDetector();
  const chunks = [
    '{\n  "name": "test",\n  "argu',
    'ments": {\n    "text": "hello {wor',
    'ld} bye"\n  }\n}',
  ];

  let allText = '';
  const allToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  for (const chunk of chunks) {
    const result = detector.processChunk(chunk);
    allText += result.textToEmit;
    allToolCalls.push(...result.completedToolCalls);
  }

  const final = detector.finalize();
  allText += final.textToEmit;
  allToolCalls.push(...final.completedToolCalls);

  assert(allToolCalls.length === 1, `Expected 1 tool call, got ${allToolCalls.length}`);
  assertEqual(allToolCalls[0].name, 'test', 'Tool name mismatch');
  assertEqual(allToolCalls[0].arguments, { text: 'hello {world} bye' }, 'Arguments mismatch');
});

// Summary
console.log('\n' + '='.repeat(50));
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
