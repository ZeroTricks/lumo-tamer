/**
 * Streaming Tool Detector
 *
 * State machine for detecting JSON tool calls in streaming text.
 * Detects both:
 * - Code fence format: ```json {"name":"...", "arguments":{...}} ```
 * - Raw JSON format: {"name":"...", "arguments":{...}}
 *
 * Buffers tool JSON and emits it separately from normal text.
 */

import { isToolCallJson, type ParsedToolCall } from './tool-parser.js';
import { logger } from '../app/logger.js';

type DetectorState = 'normal' | 'in_code_fence' | 'in_raw_json';

export interface ProcessResult {
  /** Normal text to emit as content delta */
  textToEmit: string;
  /** Completed tool calls detected in this chunk */
  completedToolCalls: ParsedToolCall[];
}

/**
 * Streaming tool detector that processes chunks and separates
 * tool call JSON from normal message text.
 */
export class StreamingToolDetector {
  private state: DetectorState = 'normal';
  private buffer = '';
  private braceDepth = 0;
  private pendingText = '';

  // Patterns for detection
  private static readonly CODE_FENCE_START = /```(?:json)?\s*$/;
  private static readonly CODE_FENCE_END = /```/;
  private static readonly RAW_JSON_START = /\{[\s"']/;

  private showSnippet(index: number) {
    return this.pendingText.substring(Math.max(index - 7, 0), index + 7).replace(/\n/g, "\\n");
  }

  public getPendingText(){
    return this.pendingText;
  }

  /**
   * Process an incoming chunk and return what should be emitted.
   */
  processChunk(chunk: string): ProcessResult {
    const result: ProcessResult = {
      textToEmit: '',
      completedToolCalls: [],
    };

    // Add chunk to pending for processing
    this.pendingText += chunk;

    while (this.pendingText.length > 0) {
      const prevPendingLength = this.pendingText.length;
      const prevState = this.state;

      if (this.state === 'normal') {
        this.processNormalState(result);
      } else if (this.state === 'in_code_fence') {
        this.processCodeFenceState(result);
      } else if (this.state === 'in_raw_json') {
        this.processRawJsonState(result);
      }

      // Safety: if we didn't make any progress, break to avoid infinite loop
      // Progress = consumed pending text OR changed state
      const madeProgress =
        this.pendingText.length < prevPendingLength || this.state !== prevState;
      if (!madeProgress) {
        // Need more data - keep buffering
        break;
      }
    }

    return result;
  }

  /**
   * Process normal state - looking for start of JSON patterns.
   */
  private processNormalState(result: ProcessResult): void {
    // Look for code fence start
    const fenceMatch = this.pendingText.match(/```(?:json)?\s*\n?/);
    if (fenceMatch && fenceMatch.index !== undefined) {

      logger.debug(`Code block opener found: ${this.showSnippet(fenceMatch.index)}`);

      // Emit text before the fence
      if (fenceMatch.index > 0) {
        result.textToEmit += this.pendingText.slice(0, fenceMatch.index);
      }
      this.pendingText = this.pendingText.slice(fenceMatch.index + fenceMatch[0].length);
      this.state = 'in_code_fence';
      this.buffer = '';
      return;
    }

    // Look for raw JSON start (but be careful - need context)
    // Only match if it looks like start of a tool call object
    const jsonMatch = this.pendingText.match(/(?:^|\n)\s*(\{[\n\s]*")/);
    if (jsonMatch && jsonMatch.index !== undefined) {
      logger.debug(`Raw JSON opener found: ${this.showSnippet(jsonMatch.index)}`);

      const startIdx = jsonMatch.index + (jsonMatch[0].length - jsonMatch[1].length);

      // Emit text before the JSON
      if (startIdx > 0) {
        result.textToEmit += this.pendingText.slice(0, startIdx);
      }
      this.pendingText = this.pendingText.slice(startIdx);
      this.state = 'in_raw_json';
      this.buffer = '';
      this.braceDepth = 0;
      return;
    }

    // No pattern found - emit all but keep last few chars for partial match detection
    const keepChars = 10; // Keep enough for "```" pattern
    if (this.pendingText.length > keepChars) {
      result.textToEmit += this.pendingText.slice(0, -keepChars);
      this.pendingText = this.pendingText.slice(-keepChars);
    } else {
      // Not enough chars to be safe, emit nothing and wait for more
      // Actually, emit it all since we're likely at the end
      // result.textToEmit = "";
      // result.textToEmit += this.pendingText;
      // this.pendingText = '';
      // BUG: last 3 letters are dropped
    }
  }

  /**
   * Process code fence state - accumulate until closing ```.
   */
  private processCodeFenceState(result: ProcessResult): void {
    const endMatch = this.pendingText.match(/```/);
    if (endMatch && endMatch.index !== undefined) {

      logger.debug(`Code block ending found: ${this.showSnippet(endMatch.index)}`);

      // Found closing fence
      this.buffer += this.pendingText.slice(0, endMatch.index);
      this.pendingText = this.pendingText.slice(endMatch.index + 3);
      this.state = 'normal';

      // fix fenceMatch matching ``` before ```json
       this.buffer = this.buffer.replace(/^json/, "");

      // Try to parse as tool call
      const toolCall = this.tryParseToolCall(this.buffer.trim());
      if (toolCall) {
        result.completedToolCalls.push(toolCall);
      } else {
        // Not a valid tool call, emit as text with code fence formatting
        result.textToEmit += '```\n' + this.buffer + '```';
      }
      this.buffer = '';
    } else {
      // No closing fence yet, buffer everything
      this.buffer += this.pendingText;
      this.pendingText = '';
    }
  }



  /**
   * Process raw JSON state - track brace depth until balanced.
   */
  private processRawJsonState(result: ProcessResult): void {
    for (let i = 0; i < this.pendingText.length; i++) {
      const char = this.pendingText[i];
      this.buffer += char;

      if (char === '{') {
        this.braceDepth++;
      } else if (char === '}') {
        this.braceDepth--;
        if (this.braceDepth === 0) {

          logger.debug(`Raw JSON ending found: ${this.showSnippet(i)}`);

          // JSON is complete
          this.pendingText = this.pendingText.slice(i + 1);
          this.state = 'normal';

          // Try to parse as tool call
          const toolCall = this.tryParseToolCall(this.buffer.trim());
          if (toolCall) {
            result.completedToolCalls.push(toolCall);
          } else {
            // Not a valid tool call, emit as text
            result.textToEmit += this.buffer;
          }
          this.buffer = '';
          return;
        }
      } else if (char === '"') {
        // Handle string content - skip until closing quote
        i++;
        while (i < this.pendingText.length) {
          const strChar = this.pendingText[i];
          this.buffer += strChar;
          if (strChar === '\\' && i + 1 < this.pendingText.length) {
            // Escaped character
            i++;
            this.buffer += this.pendingText[i];
          } else if (strChar === '"') {
            break;
          }
          i++;
        }
        if (i >= this.pendingText.length) {
          // String not closed, need more data
          this.pendingText = '';
          return;
        }
      }
    }

    // Consumed all pending text, need more data
    this.pendingText = '';
  }

  /**
   * Try to parse content as a tool call JSON.
   */
  private tryParseToolCall(content: string): ParsedToolCall | null {
    try {
      const parsed = JSON.parse(content);
      if (isToolCallJson(parsed)) {
        return {
          name: parsed.name,
          arguments: parsed.arguments as Record<string, unknown>,
        };
      }
    } catch {
      // Not valid JSON
    }
    return null;
  }

  /**
   * Finalize - emit any remaining buffered content.
   */
  finalize(): ProcessResult {
    const result: ProcessResult = {
      textToEmit: '',
      completedToolCalls: [],
    };

    // Emit any remaining pending text
    if (this.pendingText) {
      result.textToEmit += this.pendingText;
      this.pendingText = '';
    }

    // If we were in the middle of parsing, emit buffer as text (incomplete)
    if (this.state !== 'normal' && this.buffer) {
      if (this.state === 'in_code_fence') {
        result.textToEmit += '```\n' + this.buffer;
      } else {
        result.textToEmit += this.buffer;
      }
      this.buffer = '';
    }

    this.state = 'normal';
    return result;
  }
}
