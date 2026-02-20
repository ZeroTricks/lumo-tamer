/**
 * Streaming code block detector for CLI
 *
 * Detects triple-backtick code blocks with optional language tags.
 * Simpler than API's StreamingToolDetector - no JSON parsing needed.
 */

import { blockHandlers } from './block-handlers.js';
import { type CodeBlock } from './types.js';

export type { CodeBlock };

export interface DetectorResult {
  text: string; // Text to display (excludes code block markers)
  blocks: CodeBlock[]; // Completed code blocks
}

type State = 'normal' | 'in_block';

function summarizeBlock(language: string | null, content: string): string {
  const block = { language, content };
  const handler = blockHandlers.find(h => h.matches(block));
  return handler ? handler.summarize(block) : `[${language || 'code'}]\n`;
}

export class CodeBlockDetector {
  private state: State = 'normal';
  private buffer = '';
  private language: string | null = null;
  private pendingText = '';
  private isActionable: (language: string | null) => boolean;

  constructor(isActionable?: (language: string | null) => boolean) {
    this.isActionable = isActionable ?? (() => true);
  }

  /**
   * Process a streaming chunk.
   * Returns text to display immediately and any completed code blocks.
   */
  processChunk(chunk: string): DetectorResult {
    const result: DetectorResult = { text: '', blocks: [] };
    this.pendingText += chunk;

    while (this.pendingText.length > 0) {
      const prevLength = this.pendingText.length;
      const prevState = this.state;

      if (this.state === 'normal') {
        this.processNormal(result);
      } else {
        this.processInBlock(result);
      }

      // Break if no progress (need more data)
      if (this.pendingText.length === prevLength && this.state === prevState) {
        break;
      }
    }

    return result;
  }

  /**
   * Finalize - emit any remaining content.
   */
  finalize(): DetectorResult {
    const result: DetectorResult = { text: '', blocks: [] };

    // Emit remaining pending text
    if (this.pendingText) {
      result.text += this.pendingText;
      this.pendingText = '';
    }

    // If in block, emit as incomplete (no closing fence)
    if (this.state === 'in_block' && this.buffer) {
      // Reconstruct the opening fence + content
      const lang = this.language || '';
      result.text += '```' + lang + '\n' + this.buffer;
      this.buffer = '';
    }

    this.state = 'normal';
    return result;
  }

  private processNormal(result: DetectorResult): void {
    // Look for code fence start: ```lang\n or ```\n
    // Must see the newline to be sure we have the complete opening fence
    const match = this.pendingText.match(/```(\w*)\n/);

    if (match && match.index !== undefined) {
      // Emit text before the fence
      if (match.index > 0) {
        result.text += this.pendingText.slice(0, match.index);
      }

      // Extract language (empty string becomes null)
      this.language = match[1] || null;
      this.buffer = '';
      this.state = 'in_block';
      this.pendingText = this.pendingText.slice(match.index + match[0].length);
      return;
    }

    // Check if we have a potential partial fence at the end
    // Pattern could be: `, ``, ```, ```l, ```la, ```lan, etc (up to ```lang without \n)
    // Find where the potential fence starts by looking for the first ` in a trailing ` sequence
    let fenceStart = -1;
    for (let i = this.pendingText.length - 1; i >= 0; i--) {
      const char = this.pendingText[i];
      if (char === '`' || (fenceStart !== -1 && /\w/.test(char))) {
        fenceStart = i;
      } else if (fenceStart !== -1) {
        break;
      }
    }

    if (fenceStart !== -1 && this.pendingText.length - fenceStart <= 15) {
      // Potential partial fence - keep from the start of backticks
      if (fenceStart > 0) {
        result.text += this.pendingText.slice(0, fenceStart);
        this.pendingText = this.pendingText.slice(fenceStart);
      }
      // Otherwise wait for more data
    } else if (this.pendingText.length > 0) {
      // No potential fence - emit all text
      result.text += this.pendingText;
      this.pendingText = '';
    }
  }

  private processInBlock(result: DetectorResult): void {
    // Look for closing fence
    const endIndex = this.pendingText.indexOf('```');

    if (endIndex !== -1) {
      // Found closing fence
      this.buffer += this.pendingText.slice(0, endIndex);
      this.pendingText = this.pendingText.slice(endIndex + 3);
      this.state = 'normal';

      const trimmed = this.buffer.trim();
      if (this.isActionable(this.language)) {
        result.text += summarizeBlock(this.language, trimmed);
        result.blocks.push({ language: this.language, content: trimmed });
      } else {
        result.text += `\`\`\`${this.language || ''}\n${trimmed}\n\`\`\``;
      }

      this.buffer = '';
      this.language = null;
      return;
    }

    // No closing fence found - check for partial ``` at end
    // Keep trailing backticks that could be start of closing fence
    let keepFrom = this.pendingText.length;
    for (let i = this.pendingText.length - 1; i >= 0 && i >= this.pendingText.length - 2; i--) {
      if (this.pendingText[i] === '`') {
        keepFrom = i;
      } else {
        break;
      }
    }

    // Buffer everything except potential partial fence
    this.buffer += this.pendingText.slice(0, keepFrom);
    this.pendingText = this.pendingText.slice(keepFrom);
  }
}
