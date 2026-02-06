/**
 * Unit tests for CLI file-reader
 *
 * Tests file reading, size guards, and binary detection.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyReadBlock, isBinaryFile, getFileSizeKB } from '../../src/cli/file-reader.js';
import { initConfig, getLocalActionsConfig } from '../../src/app/config.js';
import type { CodeBlock } from '../../src/cli/block-handlers.js';

// CLI tests need CLI mode config
beforeAll(() => {
  initConfig('cli');
});

function readBlock(content: string): CodeBlock {
  return { language: 'read', content };
}

let tmpDir: string;
let textFile: string;
let binaryFile: string;
let largeFile: string;
let emptyFile: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'file-reader-test-'));

  textFile = join(tmpDir, 'hello.txt');
  writeFileSync(textFile, 'Hello, world!\n');

  binaryFile = join(tmpDir, 'binary.bin');
  writeFileSync(binaryFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]));

  // 2 KB file (over 1 KB limit used in size guard tests)
  largeFile = join(tmpDir, 'large.txt');
  writeFileSync(largeFile, 'x'.repeat(2048));

  emptyFile = join(tmpDir, 'empty.txt');
  writeFileSync(emptyFile, '');
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('isBinaryFile', () => {
  it('returns false for a plain text file', () => {
    expect(isBinaryFile(textFile)).toBe(false);
  });

  it('returns true for a file containing null bytes', () => {
    expect(isBinaryFile(binaryFile)).toBe(true);
  });

  it('returns false for an empty file', () => {
    expect(isBinaryFile(emptyFile)).toBe(false);
  });
});

describe('getFileSizeKB', () => {
  it('returns correct size', () => {
    // 'Hello, world!\n' = 14 bytes
    expect(getFileSizeKB(textFile)).toBeCloseTo(14 / 1024, 2);
  });

  it('returns 0 for empty file', () => {
    expect(getFileSizeKB(emptyFile)).toBe(0);
  });

  it('throws for nonexistent file', () => {
    expect(() => getFileSizeKB('/nonexistent/path')).toThrow();
  });
});

describe('applyReadBlock', () => {
  it('reads a single text file', async () => {
    const result = await applyReadBlock(readBlock(textFile));
    expect(result.success).toBe(true);
    expect(result.files).toEqual([textFile]);
    expect(result.output).toContain('Hello, world!');
  });

  it('reads multiple text files', async () => {
    const result = await applyReadBlock(readBlock(`${textFile}\n${emptyFile}`));
    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.output).toContain('Hello, world!');
  });

  it('reports error for nonexistent file', async () => {
    const result = await applyReadBlock(readBlock('/nonexistent/file.txt'));
    expect(result.success).toBe(false);
    expect(result.output).toContain('Error:');
  });

  it('returns failure for empty block', async () => {
    const result = await applyReadBlock(readBlock(''));
    expect(result.success).toBe(false);
    expect(result.output).toContain('No file paths');
  });

  describe('size guard', () => {
    let originalMaxSize: number;

    beforeAll(() => {
      originalMaxSize = getLocalActionsConfig().fileReads.maxFileSizeKB;
    });

    afterAll(() => {
      (getLocalActionsConfig().fileReads as any).maxFileSizeKB = originalMaxSize;
    });

    it('rejects a file exceeding maxFileSizeKB', async () => {
      (getLocalActionsConfig().fileReads as any).maxFileSizeKB = 1; // 1 KB
      const result = await applyReadBlock(readBlock(largeFile));
      expect(result.success).toBe(false);
      expect(result.output).toContain('File too large');
      expect(result.output).toContain('Maximum allowed size is 1 KB');
    });

    it('accepts a file within the size limit', async () => {
      (getLocalActionsConfig().fileReads as any).maxFileSizeKB = 1; // 1 KB
      const result = await applyReadBlock(readBlock(textFile)); // 14 bytes
      expect(result.success).toBe(true);
    });
  });

  describe('binary guard', () => {
    it('rejects a binary file', async () => {
      const result = await applyReadBlock(readBlock(binaryFile));
      expect(result.success).toBe(false);
      expect(result.output).toContain('binary');
    });

    it('accepts a text file', async () => {
      const result = await applyReadBlock(readBlock(textFile));
      expect(result.success).toBe(true);
    });
  });

  describe('mixed results', () => {
    it('reads valid files and skips invalid ones', async () => {
      const content = `${textFile}\n${binaryFile}\n/nonexistent/file.txt`;
      const result = await applyReadBlock(readBlock(content));
      expect(result.success).toBe(false);
      expect(result.files).toHaveLength(3);
      expect(result.output).toContain('Hello, world!');
      expect(result.output).toContain('binary');
      expect(result.output).toContain('Error:');
    });
  });
});
