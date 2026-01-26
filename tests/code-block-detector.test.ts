/**
 * Unit tests for CLI CodeBlockDetector
 *
 * Tests the streaming code block detector that identifies
 * triple-backtick code blocks with optional language tags.
 *
 * Run with: npx tsx tests/code-block-detector.test.ts
 */

import { CodeBlockDetector, type CodeBlock } from '../src/cli/code-block-detector.js';

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
    console.log(`\u2713 ${name}`);
  } catch (e) {
    results.push({ name, passed: false, error: String(e) });
    console.log(`\u2717 ${name}`);
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

// ============================================================================
// Basic Detection Tests
// ============================================================================

test('detects bash code block', () => {
  const detector = new CodeBlockDetector();

  const chunks = ['Here is a command:\n```bash\nls -la\n```\nDone!'];

  let text = '';
  let blocks: CodeBlock[] = [];

  for (const chunk of chunks) {
    const result = detector.processChunk(chunk);
    text += result.text;
    blocks.push(...result.blocks);
  }

  const final = detector.finalize();
  text += final.text;
  blocks.push(...final.blocks);

  assert(blocks.length === 1, `Expected 1 block, got ${blocks.length}`);
  assertEqual(blocks[0].language, 'bash', 'Language should be bash');
  assertEqual(blocks[0].content, 'ls -la', 'Content should be "ls -la"');
  assert(text.includes('Here is a command:'), 'Should include text before block');
  assert(text.includes('Done!'), 'Should include text after block');
  assert(!text.includes('```'), 'Should not include fence markers');
});

test('detects python code block', () => {
  const detector = new CodeBlockDetector();

  const result = detector.processChunk('```python\nprint("hello")\n```');
  const final = detector.finalize();

  const blocks = [...result.blocks, ...final.blocks];
  assert(blocks.length === 1, `Expected 1 block, got ${blocks.length}`);
  assertEqual(blocks[0].language, 'python', 'Language should be python');
  assertEqual(blocks[0].content, 'print("hello")', 'Content mismatch');
});

test('detects untagged code block', () => {
  const detector = new CodeBlockDetector();

  const result = detector.processChunk('```\necho "no language"\n```');
  const final = detector.finalize();

  const blocks = [...result.blocks, ...final.blocks];
  assert(blocks.length === 1, `Expected 1 block, got ${blocks.length}`);
  assertEqual(blocks[0].language, null, 'Language should be null');
  assertEqual(blocks[0].content, 'echo "no language"', 'Content mismatch');
});

// ============================================================================
// Streaming Tests
// ============================================================================

test('handles code block split across chunks', () => {
  const detector = new CodeBlockDetector();

  const chunks = ['Here:\n```', 'bash\nls', ' -la\n``', '`\nDone'];

  let text = '';
  let blocks: CodeBlock[] = [];

  for (const chunk of chunks) {
    const result = detector.processChunk(chunk);
    text += result.text;
    blocks.push(...result.blocks);
  }

  const final = detector.finalize();
  text += final.text;
  blocks.push(...final.blocks);

  assert(blocks.length === 1, `Expected 1 block, got ${blocks.length}`);
  assertEqual(blocks[0].language, 'bash', 'Language should be bash');
  assertEqual(blocks[0].content, 'ls -la', 'Content should be "ls -la"');
});

test('handles multiple code blocks', () => {
  const detector = new CodeBlockDetector();

  const input = `First:
\`\`\`bash
ls
\`\`\`
Second:
\`\`\`python
print("hi")
\`\`\``;

  const result = detector.processChunk(input);
  const final = detector.finalize();

  const blocks = [...result.blocks, ...final.blocks];
  assert(blocks.length === 2, `Expected 2 blocks, got ${blocks.length}`);
  assertEqual(blocks[0].language, 'bash', 'First block should be bash');
  assertEqual(blocks[1].language, 'python', 'Second block should be python');
});

test('streams text before block detection', () => {
  const detector = new CodeBlockDetector();

  // First chunk: just text
  const r1 = detector.processChunk('Hello ');
  assert(r1.text.length > 0 || r1.blocks.length === 0, 'Should emit text or wait');

  // Second chunk: more text
  const r2 = detector.processChunk('world! ');
  // Text should be streaming out (minus buffer for partial match detection)

  // Third chunk: code block
  const r3 = detector.processChunk('```bash\nls\n```');

  const final = detector.finalize();
  const allText = r1.text + r2.text + r3.text + final.text;
  const allBlocks = [...r1.blocks, ...r2.blocks, ...r3.blocks, ...final.blocks];

  assert(allBlocks.length === 1, `Expected 1 block, got ${allBlocks.length}`);
  assert(allText.includes('Hello'), 'Should contain "Hello"');
  assert(allText.includes('world'), 'Should contain "world"');
});

// ============================================================================
// Edge Cases
// ============================================================================

test('handles incomplete block at end (no closing fence)', () => {
  const detector = new CodeBlockDetector();

  const result = detector.processChunk('```bash\nls -la');
  const final = detector.finalize();

  // Should emit the incomplete block as text
  const text = result.text + final.text;
  assert(text.includes('```bash'), 'Should include opening fence');
  assert(text.includes('ls -la'), 'Should include content');
  assertEqual(result.blocks.length + final.blocks.length, 0, 'No complete blocks');
});

test('handles empty code block', () => {
  const detector = new CodeBlockDetector();

  const result = detector.processChunk('```\n```');
  const final = detector.finalize();

  const blocks = [...result.blocks, ...final.blocks];
  assert(blocks.length === 1, `Expected 1 block, got ${blocks.length}`);
  assertEqual(blocks[0].content, '', 'Content should be empty');
});

test('handles code block with only whitespace', () => {
  const detector = new CodeBlockDetector();

  const result = detector.processChunk('```\n   \n```');
  const final = detector.finalize();

  const blocks = [...result.blocks, ...final.blocks];
  assert(blocks.length === 1, `Expected 1 block, got ${blocks.length}`);
  assertEqual(blocks[0].content, '', 'Content should be trimmed to empty');
});

test('handles backticks inside code block', () => {
  const detector = new CodeBlockDetector();

  const input = '```bash\necho "``not a fence``"\n```';
  const result = detector.processChunk(input);
  const final = detector.finalize();

  const blocks = [...result.blocks, ...final.blocks];
  assert(blocks.length === 1, `Expected 1 block, got ${blocks.length}`);
  assert(blocks[0].content.includes('``not a fence``'), 'Should preserve inner backticks');
});

// ============================================================================
// Summary
// ============================================================================

console.log('\n---');
const passed = results.filter((r) => r.passed).length;
const total = results.length;
console.log(`${passed}/${total} tests passed`);

if (passed < total) {
  process.exit(1);
}
