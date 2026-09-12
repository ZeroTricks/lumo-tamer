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
import { ToolMatcher } from './tool-matcher.js';

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
   * Optional matcher built from the tools declared in the current request
   * (`request.tools`). When provided (and non-empty), tool-shaped JSON is
   * only accepted as a real tool call if its name resolves against it -
   * this is what actually implements "matching against the OpenAI tools
   * API" rather than accepting any `{"name":...,"arguments":...}` blob.
   * When omitted, behavior falls back to the legacy shape-only detection
   * (kept for callers that don't have a tool list handy, e.g. some tests).
   */
  constructor(private readonly toolMatcher?: ToolMatcher) {}

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
      return;
    }

    // Look for raw JSON start (but be careful - need context)
    // Only match if it looks like start of a tool call object, or a JSON
    // array of tool call objects (parallel tool calls), e.g.
    // `[{"name":...}, {"name":...}]`.
    const jsonMatch = this.pendingText.match(/(?:^|\n)\s*(\[\s*\{[\n\s]*"|\{[\n\s]*")/);
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
   *
   * The closing fence can be split across a chunk boundary (e.g. the buffer
   * ends with "``" and the next chunk starts with "`" followed immediately
   * by more content in the *same* chunk). Checking `pendingText` in
   * isolation misses that case, so we search across a small carried-over
   * tail of `buffer` plus the new `pendingText` instead.
   */
  private processCodeFenceState(result: ProcessResult): void {
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

  /** Complete a code fence: parse buffer as tool call or emit as text. */
  private completeCodeFence(result: ProcessResult): void {
    this.state = 'normal';

    // fix fenceMatch matching ``` before ```json
    this.buffer = this.buffer.replace(/^json/, '');

    // Try to parse as tool call(s)
    const toolCalls = this.tryParseToolCall(this.buffer.trim());
    if (toolCalls && toolCalls.length > 0) {
      result.completedToolCalls.push(...toolCalls);
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
        const toolCalls = this.tryParseToolCall(json.trim());
        if (toolCalls && toolCalls.length > 0) {
          result.completedToolCalls.push(...toolCalls);
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
   * Try to parse content as tool call JSON.
   * Strips the configured prefix from each tool name.
   *
   * Supports both a single tool call object and a JSON array of tool call
   * objects (parallel tool calls), e.g. `[{"name":...}, {"name":...}]`.
   * Only logs/tracks as invalid if content appears to be an attempted tool
   * call (has a name).
   *
   * Returns null if content isn't a tool call at all (caller should emit it
   * as plain text), otherwise an array of 1+ resolved tool calls.
   */
  private tryParseToolCall(content: string): ParsedToolCall[] | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // JSON parse failed - only track if regex finds a name that also
      // matches a declared tool (looks like a genuinely attempted tool call).
      const toolName = this.extractToolName(content);
      if (toolName) {
        const resolved = this.resolveAgainstDeclaredTools(toolName);
        if (resolved) {
          this.trackInvalidToolCall('malformed JSON', content, resolved.name);
        }
      }
      // Otherwise it's just broken/regular text, don't track
      return null;
    }

    if (Array.isArray(parsed)) {
      return this.resolveToolCallArray(parsed);
    }

    return this.resolveSingleToolCallObject(parsed, content);
  }

  /**
   * Resolve a single parsed JSON value (already confirmed not to be an
   * array) as a tool call. Shared by the single-object path and by each
   * element of a parallel-tool-calls array.
   */
  private resolveSingleToolCallObject(parsed: unknown, content: string): ParsedToolCall[] | null {
    if (isToolCallJson(parsed)) {
      const normalized = parseToolCallJson(parsed);
      if (!normalized) return null;
      const prefix = getCustomToolsConfig().prefix;
      const candidateName = stripToolPrefix(normalized.name, prefix);

      const resolved = this.resolveAgainstDeclaredTools(candidateName);
      if (resolved === null) {
        // Shape looks like a tool call, but the name doesn't match any tool
        // the client actually declared for this request. Most likely this
        // is coincidental JSON in the model's answer (e.g. an example
        // payload) rather than a genuine tool call - let it flow through
        // as normal text instead of swallowing it.
        logger.debug(
          `Tool-shaped JSON ignored, no declared tool matches "${candidateName}"`
        );
        return null;
      }
      if (!resolved.exact) {
        logger.info(
          `Tool call name "${candidateName}" fuzzy-matched to declared tool "${resolved.name}" (distance ${resolved.distance})`
        );
      }

      logger.info(`Tool call detected: ${content.replace(/\n/g, ' ').substring(0, 100)}...`);
      return [{
        name: resolved.name,
        arguments: normalized.arguments,
      }];
    }
    // JSON parsed but schema invalid - only track if it has a name that
    // also matches a declared tool (otherwise it's unrelated JSON that
    // merely happens to have a "name" field).
    if (parsed && typeof parsed === 'object' && 'name' in parsed && typeof (parsed as { name: unknown }).name === 'string') {
      const prefix = getCustomToolsConfig().prefix;
      const candidateName = stripToolPrefix((parsed as { name: string }).name, prefix);
      const resolved = this.resolveAgainstDeclaredTools(candidateName);
      if (resolved) {
        this.trackInvalidToolCall('missing arguments', content, resolved.name);
      }
    }
    // Otherwise it's just regular JSON, don't track
    return null;
  }

  /**
   * Resolve a JSON array as a batch of parallel tool calls.
   *
   * If none of the elements look tool-call-shaped, the array is treated as
   * ordinary data (e.g. the model was asked to return a JSON array) and
   * null is returned so the whole thing is emitted as text. Otherwise each
   * shaped element is resolved independently; elements that don't match a
   * declared tool (or are malformed) are dropped with the same logging as
   * the single-object path, rather than discarding the whole batch.
   */
  private resolveToolCallArray(arr: unknown[]): ParsedToolCall[] | null {
    if (arr.length === 0) return null;
    if (!arr.some((el) => isToolCallJson(el))) return null;

    const results: ParsedToolCall[] = [];
    for (const el of arr) {
      const single = this.resolveSingleToolCallObject(el, JSON.stringify(el));
      if (single) results.push(...single);
    }
    if (results.length === 0) return null;

    logger.info(`Parallel tool calls detected: ${results.length} call(s) in JSON array`);
    return results;
  }

  /**
   * Resolve a candidate name (already stripped of the custom-tool prefix)
   * against the tools declared for this request.
   *
   * When no matcher was provided, or it was built from an empty tool list,
   * this falls back to accepting any name (legacy shape-only behavior) so
   * existing callers without access to `request.tools` keep working.
   */
  private resolveAgainstDeclaredTools(
    candidateName: string
  ): { name: string; exact: boolean; distance: number } | null {
    if (!this.toolMatcher || this.toolMatcher.size === 0) {
      return { name: candidateName, exact: true, distance: 0 };
    }
    return this.toolMatcher.match(candidateName);
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
          const toolCalls = this.tryParseToolCall(trackerBuffer.trim());
          if (toolCalls && toolCalls.length > 0) {
            result.completedToolCalls.push(...toolCalls);
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
