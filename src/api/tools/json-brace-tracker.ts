/**
 * Reusable brace-depth JSON object tracker for chunked input.
 *
 * Extracts complete JSON objects from a stream of text chunks by tracking
 * brace depth, handling nested objects and strings with escaped characters.
 * Each time brace depth returns to 0, a complete JSON string is yielded.
 *
 * Used by:
 * - LumoClient.processStream() for native SSE tool_call/tool_result parsing
 * - StreamingToolDetector.processRawJsonState() for raw JSON in message text
 *
 * We don't use JSON.parse / partialParse (openai/_vendor/partial-json-parser)
 * per chunk for performance and different concerns:
 * - O(1) per char with zero allocations, vs JSON.parse on growing buffer O(n^2).
 * - partialParse deals with isolated cases (no trailing normal text or other blocks)
 * - Good enough: this covers majority of cases, while Lumo should ouput JSON in code blocks anyway
 * - The finalize() fallback uses JSON.parse once at end-of-stream as a safety net.
 */

export interface FeedResult {
    /** Complete JSON object strings extracted from this (and previous) chunks. */
    results: string[];
    /** Text remaining after the last complete JSON object, if any. Empty when still inside an object. */
    remainder: string;
}

export class JsonBraceTracker {
    private buffer = '';
    private braceDepth = 0;
    private inString = false;
    private escaped = false;

    /**
     * Feed a chunk of text. Returns an array of complete JSON object strings
     * (0 or more) extracted from this and previous chunks.
     *
     * Characters outside any JSON object are discarded.
     */
    feed(chunk: string): string[] {
        return this.feedWithRemainder(chunk).results;
    }

    /**
     * Feed a chunk of text, returning both complete JSON strings and any
     * trailing text after the last completed object.
     *
     * Useful when the caller needs to know what wasn't consumed
     * (e.g. StreamingToolDetector returning to normal state after JSON ends).
     */
    feedWithRemainder(chunk: string): FeedResult {
        const results: string[] = [];
        let lastCompleteIndex = -1;

        for (let i = 0; i < chunk.length; i++) {
            const char = chunk[i];

            if (this.inString) {
                this.buffer += char;
                if (this.escaped) {
                    this.escaped = false;
                } else if (char === '\\') {
                    this.escaped = true;
                } else if (char === '"') {
                    this.inString = false;
                }
                continue;
            }

            // Not in a string
            if (char === '"') {
                this.buffer += char;
                this.inString = true;
                this.escaped = false;
            } else if (char === '{') {
                this.braceDepth++;
                this.buffer += char;
            } else if (char === '}') {
                this.braceDepth--;
                this.buffer += char;
                if (this.braceDepth === 0) {
                    results.push(this.buffer);
                    this.buffer = '';
                    lastCompleteIndex = i;
                }
            } else if (this.braceDepth > 0) {
                // Only accumulate chars when inside an object
                this.buffer += char;
            }
            // Characters outside any JSON object are discarded
        }

        const remainder = lastCompleteIndex >= 0 && lastCompleteIndex < chunk.length - 1
            ? chunk.slice(lastCompleteIndex + 1)
            : '';

        return { results, remainder };
    }

    /** The in-progress buffer (incomplete JSON being accumulated). */
    getBuffer(): string {
        return this.buffer;
    }

    /** Whether the tracker is currently inside a JSON object (braceDepth > 0). */
    isActive(): boolean {
        return this.braceDepth > 0;
    }

    /** Reset all state for reuse. */
    reset(): void {
        this.buffer = '';
        this.braceDepth = 0;
        this.inString = false;
        this.escaped = false;
    }
}
