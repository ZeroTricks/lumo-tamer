/**
 * Unit tests for CLI CodeBlockDetector
 *
 * Tests the streaming code block detector that identifies
 * triple-backtick code blocks with optional language tags.
 *
 * Ported from tests/code-block-detector.test.ts (ad-hoc harness)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initConfig } from '../../src/app/config.js';
import { CodeBlockDetector, type CodeBlock } from '../../src/cli/local-actions/code-block-detector.js';

// CLI tests need CLI mode config
beforeAll(() => {
  initConfig('cli');
});

/** Feed chunks through detector and return accumulated text + blocks */
function processAll(detector: CodeBlockDetector, chunks: string[]) {
  let text = '';
  const blocks: CodeBlock[] = [];

  for (const chunk of chunks) {
    const result = detector.processChunk(chunk);
    text += result.text;
    blocks.push(...result.blocks);
  }

  const final = detector.finalize();
  text += final.text;
  blocks.push(...final.blocks);

  return { text, blocks };
}

describe('CodeBlockDetector', () => {
  describe('basic detection', () => {
    it('detects bash code block', () => {
      const detector = new CodeBlockDetector();
      const { text, blocks } = processAll(detector, [
        'Here is a command:\n```bash\nls -la\n```\nDone!',
      ]);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].language).toBe('bash');
      expect(blocks[0].content).toBe('ls -la');
      expect(text).toContain('Here is a command:');
      expect(text).toContain('Done!');
      expect(text).not.toContain('```');
    });

    it('detects python code block', () => {
      const detector = new CodeBlockDetector();
      const { blocks } = processAll(detector, [
        '```python\nprint("hello")\n```',
      ]);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].language).toBe('python');
      expect(blocks[0].content).toBe('print("hello")');
    });

    it('detects untagged code block', () => {
      const detector = new CodeBlockDetector();
      const { blocks } = processAll(detector, [
        '```\necho "no language"\n```',
      ]);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].language).toBeNull();
      expect(blocks[0].content).toBe('echo "no language"');
    });
  });

  describe('streaming', () => {
    it('handles code block split across chunks', () => {
      const detector = new CodeBlockDetector();
      const { blocks } = processAll(detector, [
        'Here:\n```', 'bash\nls', ' -la\n``', '`\nDone',
      ]);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].language).toBe('bash');
      expect(blocks[0].content).toBe('ls -la');
    });

    it('handles multiple code blocks', () => {
      const detector = new CodeBlockDetector();
      const { blocks } = processAll(detector, [
        'First:\n```bash\nls\n```\nSecond:\n```python\nprint("hi")\n```',
      ]);

      expect(blocks).toHaveLength(2);
      expect(blocks[0].language).toBe('bash');
      expect(blocks[1].language).toBe('python');
    });

    it('streams text before block detection', () => {
      const detector = new CodeBlockDetector();

      const r1 = detector.processChunk('Hello ');
      const r2 = detector.processChunk('world! ');
      const r3 = detector.processChunk('```bash\nls\n```');
      const final = detector.finalize();

      const allText = r1.text + r2.text + r3.text + final.text;
      const allBlocks = [...r1.blocks, ...r2.blocks, ...r3.blocks, ...final.blocks];

      expect(allBlocks).toHaveLength(1);
      expect(allText).toContain('Hello');
      expect(allText).toContain('world');
    });
  });

  describe('edge cases', () => {
    it('handles incomplete block at end (no closing fence)', () => {
      const detector = new CodeBlockDetector();
      const { text, blocks } = processAll(detector, [
        '```bash\nls -la',
      ]);

      expect(blocks).toHaveLength(0);
      expect(text).toContain('```bash');
      expect(text).toContain('ls -la');
    });

    it('handles empty code block', () => {
      const detector = new CodeBlockDetector();
      const { blocks } = processAll(detector, ['```\n```']);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toBe('');
    });

    it('handles code block with only whitespace', () => {
      const detector = new CodeBlockDetector();
      const { blocks } = processAll(detector, ['```\n   \n```']);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toBe('');
    });

    it('handles backticks inside code block', () => {
      const detector = new CodeBlockDetector();
      const { blocks } = processAll(detector, [
        '```bash\necho "``not a fence``"\n```',
      ]);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toContain('``not a fence``');
    });
  });
});
