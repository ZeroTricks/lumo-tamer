/**
 * Tool Matcher
 *
 * Matches tool-call-like JSON detected in streaming text against the actual
 * list of tools declared by the API client for this request (`request.tools`).
 *
 * Why this exists:
 * StreamingToolDetector (and the native SSE processor) only checked the
 * *shape* of JSON it stumbled upon (`{"name": ..., "arguments"/"parameters": ...}`).
 * Without validating `name` against the tools the client actually declared,
 * two classes of bugs happen in practice:
 *
 * 1. False positives - the model's answer happens to contain ordinary JSON
 *    that matches the tool-call shape (e.g. an example payload it was asked
 *    to produce) and gets silently swallowed instead of shown to the user.
 * 2. Missed / rejected calls - Lumo's underlying models are much smaller
 *    than GPT-4 class models and are more prone to slightly mangling the
 *    tool name (wrong case, spaces instead of underscores, a dropped
 *    prefix, a typo). The call then gets forwarded to the client with a
 *    name that matches no declared tool, so the client (Home Assistant,
 *    Open WebUI, ...) silently drops or errors on it.
 *
 * ToolMatcher keeps a normalized index of the declared tool names for a
 * request and resolves any candidate name against it, with a small
 * edit-distance tolerance for near-misses.
 */

import type { OpenAITool } from '../types.js';

/** Normalize a tool name for comparison: case/whitespace/separator-insensitive. */
function normalize(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/** Iterative Levenshtein distance (O(n*m) time, O(m) space, no recursion). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const currRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow.push(
        Math.min(
          currRow[j - 1] + 1, // insertion
          prevRow[j] + 1, // deletion
          prevRow[j - 1] + cost, // substitution
        ),
      );
    }
    prevRow = currRow;
  }
  return prevRow[b.length];
}

/**
 * Max edit distance tolerated for a fuzzy match, scaled to name length.
 * Short names are not fuzzy-matched at all (too easy to collide by accident).
 */
function maxDistanceFor(length: number): number {
  if (length <= 4) return 0;
  if (length <= 8) return 1;
  return 2;
}

export interface ToolMatch {
  /** Canonical name exactly as declared by the client (function.name). */
  name: string;
  /** False when resolved via fuzzy matching rather than an exact match. */
  exact: boolean;
  /** Edit distance to the matched name (0 for exact matches). */
  distance: number;
}

/**
 * Index of tool names declared by the client for a single request, used to
 * validate/resolve candidate tool-call names detected in model output.
 */
export class ToolMatcher {
  private readonly byNormalizedName = new Map<string, string>();

  constructor(tools: OpenAITool[] = []) {
    for (const tool of tools) {
      const name = tool.function?.name ?? (tool as unknown as { name?: string }).name;
      if (name) this.byNormalizedName.set(normalize(name), name);
    }
  }

  /** Number of distinct declared tools indexed. */
  get size(): number {
    return this.byNormalizedName.size;
  }

  /**
   * Resolve a candidate tool name (already stripped of any custom prefix)
   * against the declared tools.
   *
   * Returns the canonical declared name (and match quality) or null if
   * nothing matches closely enough to be considered the same tool.
   */
  match(candidate: string): ToolMatch | null {
    if (!candidate) return null;
    const normalizedCandidate = normalize(candidate);
    if (!normalizedCandidate) return null;

    const exact = this.byNormalizedName.get(normalizedCandidate);
    if (exact) return { name: exact, exact: true, distance: 0 };

    // Fuzzy fallback: closest declared name within tolerance, if any.
    let best: { name: string; distance: number } | null = null;
    for (const [normalizedName, originalName] of this.byNormalizedName) {
      const distance = levenshtein(normalizedCandidate, normalizedName);
      const tolerance = maxDistanceFor(Math.min(normalizedCandidate.length, normalizedName.length));
      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = { name: originalName, distance };
      }
    }
    return best ? { name: best.name, exact: false, distance: best.distance } : null;
  }

  /** True if candidate resolves to a declared tool (exact or fuzzy). */
  has(candidate: string): boolean {
    return this.match(candidate) !== null;
  }
}
