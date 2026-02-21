/**
 * Deterministic ID generation utilities.
 *
 * SESSION_ID ensures IDs are unique per server session while remaining
 * deterministic within a session (same seed = same ID).
 */

import { randomUUID, createHash } from 'crypto';

// Session ID generated once at module load - makes deterministic IDs unique per server session
// This prevents 409 conflicts with deleted conversations from previous sessions
const SESSION_ID = randomUUID();

/**
 * Generate a deterministic UUID from a seed string, scoped to the current session.
 * The same seed within the same session always produces the same UUID,
 * but different sessions produce different UUIDs (prevents sync conflicts).
 */
export function deterministicUUID(seed: string): string {
  const hash = createHash('sha256').update(`lumo-tamer:${SESSION_ID}:${seed}`).digest('hex');
  // Format as UUID: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
