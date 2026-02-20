

import type { Turn } from './index.js';

// ── Instruction sanitization ─────────────────────────────────────────

/**
 * Sanitize instruction text to avoid breaking the [Project instructions: ...] wrapper.
 *
 * The wrapper ends with `]\n\n` so we need to prevent that pattern from
 * appearing in the instruction content. We insert a space between `]` and
 * newlines to break the pattern while keeping JSON valid and readable.
 */
export function sanitizeInstructions(text: string): string {
  return text
    .replace(/\](\n)/g, '] $1')  // ] followed by newline -> ] + space + newline
    .replace(/\n{3,}/g, '\n\n'); // collapse excessive newlines
}

// ── Turn index helpers ────────────────────────────────────────────────

/**
 * Find index of first user turn that isn't a command.
 * Returns -1 if no suitable turn found.
 */
export function findFirstUserTurnIndex(turns: Turn[]): number {
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role === 'user' && turn.content) {
      return i;
    }
  }
  return -1;
}

/**
 * Find index of last user turn that isn't a command.
 * Returns -1 if no suitable turn found.
 */
export function findLastUserTurnIndex(turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role === 'user' && turn.content) {
      return i;
    }
  }
  return -1;
}

// ── Instruction injection ─────────────────────────────────────────────

/**
 * Inject instructions into a user turn.
 *
 * @param turns - Array of conversation turns
 * @param instructions - Instructions to inject (skipped if undefined)
 * @param injectInto - "first" injects into first user turn (less token usage),
 *                     "last" injects into last user turn (matches WebClient behavior)
 *
 * Instructions are prepended as [Project instructions: ...] wrapper.
 */
export function injectInstructionsIntoTurns(
  turns: Turn[],
  instructions: string | undefined,
  injectInto: 'first' | 'last'
): Turn[] {
  if (!instructions) return turns;

  // Sanitize to avoid breaking the [Project instructions: ...] wrapper
  const sanitizedInstructions = sanitizeInstructions(instructions);

  const targetIdx = injectInto === 'first'
    ? findFirstUserTurnIndex(turns)
    : findLastUserTurnIndex(turns);

  if (targetIdx === -1) return turns;

  return turns.map((turn, index) => {
    if (index === targetIdx) {
      return {
        ...turn,
        content: `[Project instructions: ${sanitizedInstructions}]\n\n${turn.content}`,
      };
    }
    return turn;
  });
}
