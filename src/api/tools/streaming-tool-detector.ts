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
import { isToolCallJson, parseToolCallJson, type ParsedToolCall } from './types.js';
import { logger } from '../../app/logger.js';
import { getCustomToolsConfig } from '../../app/config.js';
import { stripToolPrefix } from './prefix.js';
import { getMetrics } from '../../app/metrics.js';

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
  /**
   * Whether the current code-fence's content looks like JSON ('json') or
   * arbitrary text/code ('generic'), decided once we've seen its first
   * non-whitespace character. JSON-flavored fences are parsed via
   * `jsonTracker` (string/escape aware) instead of a naive "```" text scan,
   * so a literal "```" inside a JSON string value - e.g. a file being
   * written that itself contains markdown code fences - isn't mistaken for
   * the fence's closing marker.
   */
  private codeFenceFlavor: 'unknown' | 'json' | 'generic' = 'unknown';

  // Patterns for detection
  private static readonly CODE_FENCE_START = /```(?:json)?\s*$/;
  private static readonly CODE_FENCE_END = /```/;
  private static readonly CODE_FENCE_MARKER = '```';
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
      this.codeFenceFlavor = 'unknown';
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
   * Process code fence state - dispatches to the JSON-aware or generic
   * handler once we know which flavor of content this fence holds.
   */
  private processCodeFenceState(result: ProcessResult): void {
    if (this.codeFenceFlavor === 'unknown') {
      // Merge anything already buffered with the new chunk before deciding.
      // The fence-opener regex above can match the "```" before a following
      // "json" language tag has fully arrived in a later chunk (e.g. "```"
      // and "json\n" split across two chunks), leaving a stray leading
      // "json" tag as if it were fence content. If what we have so far is
      // itself still a plain prefix of "json" (e.g. just "j", "js", "json"),
      // we can't yet tell whether more "json"-tag characters are coming -
      // wait for more data.
      const rawProbe = this.buffer + this.pendingText;
      if ('json'.startsWith(rawProbe)) {
        this.buffer = rawProbe;
        this.pendingText = '';
        return;
      }
      const probe = rawProbe.replace(/^json\s*\n?/, '');
      const firstNonWs = probe.match(/\S/);
      if (!firstNonWs) {
        // Still nothing but whitespace - keep buffering, wait for more data.
        this.buffer = probe;
        this.pendingText = '';
        return;
      }
      this.codeFenceFlavor = (firstNonWs[0] === '{') ? 'json' : 'generic';
      this.pendingText = probe;
      this.buffer = '';
      if (this.codeFenceFlavor === 'json') {
        this.jsonTracker.reset();
      }
    }

    if (this.codeFenceFlavor === 'json') {
      this.processJsonCodeFence(result);
    } else {
      this.processGenericCodeFence(result);
    }
  }

  /**
   * Process a code fence whose content looks like JSON (a tool call).
   * Delegates to `jsonTracker`, which understands quoted strings and
   * escapes, so a literal "```" inside a JSON string value - e.g. a file
   * being written that itself contains markdown code fences - is never
   * mistaken for the fence's own closing marker (unlike a plain text scan
   * for "```").
   */
  private processJsonCodeFence(result: ProcessResult): void {
    const { results, remainder } = this.jsonTracker.feedWithRemainder(this.pendingText);
    this.pendingText = '';

    if (results.length === 0) {
      // JSON value isn't complete yet - keep waiting for more chunks.
      return;
    }

    // Exactly one top-level JSON object per fence is the expected case.
    for (const jsonStr of results) {
      const toolCall = this.tryParseToolCall(jsonStr.trim());
      if (toolCall) {
        result.completedToolCalls.push(toolCall);
      } else {
        result.textToEmit += jsonStr;
      }
    }

    this.state = 'normal';
    this.codeFenceFlavor = 'unknown';

    // What follows the JSON value should be the closing "```" (plus maybe
    // a trailing newline) - strip it if present; anything left over goes
    // back to normal-state processing.
    const fenceClose = remainder.match(/^\s*```/);
    this.pendingText = fenceClose
      ? remainder.slice((fenceClose.index ?? 0) + fenceClose[0].length)
      : remainder;
  }

  /**
   * Process a generic (non-JSON) code fence - accumulate until closing ```.
   *
   * The closing fence can be split across a chunk boundary (e.g. the buffer
   * ends with "``" and the next chunk starts with "`" followed immediately
   * by more content in the *same* chunk). Checking `pendingText` in
   * isolation misses that case, so we search across a small carried-over
   * tail of `buffer` plus the new `pendingText` instead.
   */
  private processGenericCodeFence(result: ProcessResult): void {
    const overlap = StreamingToolDetector.CODE_FENCE_MARKER.length - 1; // 2
    const carry = this.buffer.slice(-overlap);
    const searchable = carry + this.pendingText;
    const match = searchable.match(StreamingToolDetector.CODE_FENCE_END);

    if (match && match.index !== undefined) {
      logger.debug(`Code block ending found: ${this.showSnippet(match.index)}`);

      // Index of the fence relative to pendingText; negative if the fence
      // starts inside the carried-over tail of buffer.
      const idxInPending = match.index - carry.length;
      if (idxInPending < 0) {
        this.buffer = this.buffer.slice(0, this.buffer.length + idxInPending);
      } else {
        this.buffer += this.pendingText.slice(0, idxInPending);
      }
      this.pendingText = this.pendingText.slice(idxInPending + StreamingToolDetector.CODE_FENCE_MARKER.length);
      this.completeCodeFence(result);
      return;
    }

    // No closing fence found even accounting for the boundary - buffer this
    // chunk and wait for more data.
    this.buffer += this.pendingText;
    this.pendingText = '';
  }

  /** Complete a generic code fence: parse buffer as tool call or emit as text. */
  private completeCodeFence(result: ProcessResult): void {
    this.state = 'normal';
    this.codeFenceFlavor = 'unknown';

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
   * Returns null if no name found (indicating this isn't a tool call attempt).
   */
  private extractToolName(content: string): string | null {
    const match = content.match(/"name"\s*:\s*"([^"]+)"/);
    if (match) {
      const prefix = getCustomToolsConfig().prefix;
      return stripToolPrefix(match[1], prefix);
    }
    return null;
  }

  /**
   * Log and track an invalid tool call attempt.
   * Only called when we've determined this was actually a tool call attempt (has a name).
   */
  private trackInvalidToolCall(reason: string, content: string, toolName: string): void {
    logger.info(`Invalid tool call (${reason}): ${content.replace(/\n/g, ' ')}`);
    getMetrics()?.toolCallsTotal.inc({ type: 'custom', status: 'invalid', tool_name: toolName });
  }

  /**
   * Try to parse content as a tool call JSON.
   * Strips the configured prefix from the tool name.
   * Only logs/tracks as invalid if content appears to be an attempted tool call (has a name).
   */
  private tryParseToolCall(content: string): ParsedToolCall | null {
    try {
      const parsed = JSON.parse(content);
      if (isToolCallJson(parsed)) {
        const normalized = parseToolCallJson(parsed);
        if (!normalized) return null;
        const prefix = getCustomToolsConfig().prefix;
        const toolName = stripToolPrefix(normalized.name, prefix);
        logger.info(`Tool call detected: ${content.replace(/\n/g, ' ').substring(0, 100)}...`);
        return {
          name: toolName,
          arguments: normalized.arguments,
        };
      }
      // JSON parsed but schema invalid - only track if it has a name (looks like attempted tool call)
      if ('name' in parsed && typeof parsed.name === 'string') {
        const prefix = getCustomToolsConfig().prefix;
        const toolName = stripToolPrefix(parsed.name, prefix);
        this.trackInvalidToolCall('missing arguments', content, toolName);
      }
      // Otherwise it's just regular JSON, don't track
    } catch {
      // JSON parse failed - only track if regex finds a name (looks like attempted tool call)
      const toolName = this.extractToolName(content);
      if (toolName) {
        this.trackInvalidToolCall('malformed JSON', content, toolName);
      }
      // Otherwise it's just broken/regular JSON, don't track
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
      const isJsonFence = this.state === 'in_code_fence' && this.codeFenceFlavor === 'json';
      const trackerBuffer = (this.state === 'in_raw_json' || isJsonFence)
        ? this.jsonTracker.getBuffer()
        : this.buffer;

      if (trackerBuffer) {
        // End-of-stream fallback: try JSON.parse on the complete buffer.
        // Catches edge cases where char-by-char tracking failed but JSON is actually complete.
        if (this.state === 'in_raw_json' || isJsonFence) {
          const toolCall = this.tryParseToolCall(trackerBuffer.trim());
          if (toolCall) {
            result.completedToolCalls.push(toolCall);
            this.jsonTracker.reset();
            this.state = 'normal';
            this.codeFenceFlavor = 'unknown';
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
      this.codeFenceFlavor = 'unknown';
    }

    this.state = 'normal';
    return result;
  }
}
