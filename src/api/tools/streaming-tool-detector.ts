/**
 * Streaming Tool Detector
 *
 * State machine for detecting JSON tool calls in streaming text.
 * Detects both:
 * - Code fence format: ```json {"name":"...", "arguments":{...}} ```
 * - Raw JSON format: {"name":"...", "arguments":{...}}
 *
 * Buffers tool JSON and emits it separately from normal text.
 * Raw JSON brace tracking is delegated to JsonBraceTracker.
 */

import { JsonBraceTracker } from './json-brace-tracker.js';
import { isToolCallJson, type ParsedToolCall } from './types.js';
import { logger } from '../../app/logger.js';
import { getCustomToolsConfig } from '../../app/config.js';
import { stripToolPrefix } from './prefix.js';
import { getMetrics } from '../metrics/index.js';

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
  private pendingText = '';
  private jsonTracker = new JsonBraceTracker();

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
      this.jsonTracker.reset();
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
    // First check pendingText for closing fence
    const endMatch = this.pendingText.match(/```/);
    if (endMatch && endMatch.index !== undefined) {

      logger.debug(`Code block ending found: ${this.showSnippet(endMatch.index)}`);

      // Found closing fence in pendingText
      this.buffer += this.pendingText.slice(0, endMatch.index);
      this.pendingText = this.pendingText.slice(endMatch.index + 3);
      this.completeCodeFence(result);
      return;
    }

    // No closing fence in pendingText - buffer it and check if buffer now ends with ```
    this.buffer += this.pendingText;
    this.pendingText = '';

    if (this.buffer.endsWith('```')) {
      logger.debug('Code block ending found at end of buffer');
      this.buffer = this.buffer.slice(0, -3);
      this.completeCodeFence(result);
    }
  }

  /** Complete a code fence: parse buffer as tool call or emit as text. */
  private completeCodeFence(result: ProcessResult): void {
    this.state = 'normal';

    // fix fenceMatch matching ``` before ```json
    this.buffer = this.buffer.replace(/^json/, '');

    // Try to parse as tool call
    const toolCall = this.tryParseToolCall(this.buffer.trim());
    if (toolCall) {
      result.completedToolCalls.push(toolCall);
    } else {
      // Not a valid tool call, emit as text with code fence formatting
      result.textToEmit += '```\n' + this.buffer + '```';
    }
    this.buffer = '';
  }



  /**
   * Process raw JSON state - delegates to JsonBraceTracker for brace-depth
   * tracking with proper string/escape handling across chunk boundaries.
   */
  private processRawJsonState(result: ProcessResult): void {
    const { results: completedJsons, remainder } = this.jsonTracker.feedWithRemainder(this.pendingText);

    if (completedJsons.length > 0) {
      // At least one JSON object completed
      for (const json of completedJsons) {
        logger.debug('Raw JSON ending found');
        const toolCall = this.tryParseToolCall(json.trim());
        if (toolCall) {
          result.completedToolCalls.push(toolCall);
        } else {
          // Not a valid tool call, emit as text
          result.textToEmit += json;
        }
      }

      // Remainder goes back to pendingText for normal-state processing
      this.pendingText = remainder;
      this.state = 'normal';
    } else {
      // No complete object yet, need more data
      this.pendingText = '';
    }
  }

  /**
   * Try to extract a tool name from content, even if JSON is malformed.
   * Uses regex to find "name": "..." pattern.
   */
  private extractToolName(content: string): string {
    const match = content.match(/"name"\s*:\s*"([^"]+)"/);
    if (match) {
      const prefix = getCustomToolsConfig().prefix;
      return stripToolPrefix(match[1], prefix);
    }
    return 'unknown';
  }

  /**
   * Try to parse content as a tool call JSON.
   * Strips the configured prefix from the tool name.
   * Logs and tracks metrics for both valid and invalid tool calls.
   */
  private tryParseToolCall(content: string): ParsedToolCall | null {
    try {
      const parsed = JSON.parse(content);
      if (isToolCallJson(parsed)) {
        const prefix = getCustomToolsConfig().prefix;
        const toolName = stripToolPrefix(parsed.name, prefix);
        logger.info(`Tool call detected: ${content.replace(/\n/g, ' ').substring(0, 100)}...`);
        return {
          name: toolName,
          arguments: parsed.arguments as Record<string, unknown>,
        };
      }
      // JSON parsed but schema invalid (missing name or arguments)
      const toolName = this.extractToolName(content);
      logger.info(`Invalid tool call (bad schema): ${content.replace(/\n/g, ' ')}`);
      getMetrics()?.toolCallsTotal.inc({ type: 'custom', status: 'invalid', tool_name: toolName });
    } catch {
      // JSON parse failed
      const toolName = this.extractToolName(content);
      logger.info(`Invalid tool call (malformed JSON): ${content.replace(/\n/g, ' ')}`);
      getMetrics()?.toolCallsTotal.inc({ type: 'custom', status: 'invalid', tool_name: toolName });
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

    // If we were in the middle of parsing, try to salvage before emitting as text
    if (this.state !== 'normal') {
      const trackerBuffer = this.state === 'in_raw_json' ? this.jsonTracker.getBuffer() : this.buffer;

      if (trackerBuffer) {
        // End-of-stream fallback: try JSON.parse on the complete buffer.
        // Catches edge cases where char-by-char tracking failed but JSON is actually complete.
        if (this.state === 'in_raw_json') {
          const toolCall = this.tryParseToolCall(trackerBuffer.trim());
          if (toolCall) {
            result.completedToolCalls.push(toolCall);
            this.jsonTracker.reset();
            this.state = 'normal';
            return result;
          }
        }

        if (this.state === 'in_code_fence') {
          result.textToEmit += '```\n' + trackerBuffer;
        } else {
          result.textToEmit += trackerBuffer;
        }
      }

      this.buffer = '';
      this.jsonTracker.reset();
    }

    this.state = 'normal';
    return result;
  }
}
