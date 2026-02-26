/**
 * Message deduplication utilities
 *
 * OpenAI API sends full conversation history with each request.
 * We need to deduplicate to avoid storing duplicate messages.
 */

import { createHash } from 'crypto';
import { Role } from '@lumo/types.js';
import type { Message } from './types.js';

/**
 * Compute hash for a message (role + content)
 */
export function hashMessage(role: Role, content: string): string {
    const data = `${role}:${content}`;
    return createHash('sha256').update(data, 'utf8').digest('hex');
}

interface MessageFingerprint {
    hash: string;               // SHA-256 of role + content
    role: Role;
    index: number;              // Position in conversation
}

/**
 * Create fingerprint for a message
 */
export function createFingerprint(
    role: Role,
    content: string,
    index: number
): MessageFingerprint {
    return {
        hash: hashMessage(role, content),
        role,
        index,
    };
}

/**
 * Create fingerprints for stored messages
 */
export function fingerprintMessages(messages: Message[]): MessageFingerprint[] {
    return messages.map((msg, index) => createFingerprint(
        msg.role,
        msg.content ?? '',
        index
    ));
}

/**
 * Incoming message format from API
 */
export interface MessageForStore {
    role: Role;
    content?: string;
    id?: string;  // Semantic ID for deduplication (call_id for tools)
}

/**
 * Find new messages that aren't already stored
 *
 * Strategy:
 * 1. Build set of stored semantic IDs (cached on messages)
 * 2. Match by sequence using semantic IDs
 * 3. Return incoming messages after the matching prefix
 */
export function findNewMessages(
    incoming: MessageForStore[],
    stored: Message[]
): MessageForStore[] {
    if (stored.length === 0) {
        return incoming;
    }

    if (incoming.length === 0) {
        return [];
    }

    // Build set of stored semantic IDs (already cached on messages)
    const storedIds = new Set<string>();
    for (const msg of stored) {
        if (msg.semanticId) storedIds.add(msg.semanticId);
    }

    // Find where incoming messages diverge from stored
    let matchedCount = 0;
    for (let i = 0; i < Math.min(stored.length, incoming.length); i++) {
        const incomingMsg = incoming[i];

        // Compute semantic ID for incoming message
        const incomingSemanticId = incomingMsg.id ?? hashMessage(incomingMsg.role, incomingMsg.content ?? '').slice(0, 16);

        if (storedIds.has(incomingSemanticId)) {
            matchedCount++;
        } else {
            // Divergence found - stop matching
            break;
        }
    }

    // Return messages after the matched prefix
    return incoming.slice(matchedCount);
}

/**
 * Check if incoming messages are a valid continuation of stored conversation
 *
 * Valid if:
 * - Incoming starts with the same messages as stored (prefix match by semantic ID)
 * - Or incoming is entirely new (stored is empty)
 */
export function isValidContinuation(
    incoming: MessageForStore[],
    stored: Message[]
): { valid: boolean; reason?: string; debugInfo?: { storedMsg?: string; incomingMsg?: string } } {
    if (stored.length === 0) {
        return { valid: true };
    }

    if (incoming.length < stored.length) {
        return {
            valid: false,
            reason: 'Incoming has fewer messages than stored - possible history truncation'
        };
    }

    // Check if incoming starts with the same messages (using semantic IDs)
    for (let i = 0; i < stored.length; i++) {
        const storedSemanticId = stored[i].semanticId;
        const incomingSemanticId = incoming[i].id ?? hashMessage(incoming[i].role, incoming[i].content ?? '').slice(0, 16);

        if (storedSemanticId !== incomingSemanticId) {
            return {
                valid: false,
                reason: `Message mismatch at index ${i} - history may have been modified`,
                debugInfo: {
                    storedMsg: `${stored[i].role}: ${stored[i].content ?? ''}`,
                    incomingMsg: `${incoming[i].role}: ${incoming[i].content ?? ''}`,
                }
            };
        }
    }

    return { valid: true };
}

/**
 * Detect if this is a branching request (user is continuing from a different point)
 *
 * Branching is detected when:
 * - Incoming has some matching prefix with stored
 * - But then diverges (different message at some index)
 */
export function detectBranching(
    incoming: MessageForStore[],
    stored: Message[]
): { isBranching: boolean; branchPoint?: number } {
    if (stored.length === 0 || incoming.length === 0) {
        return { isBranching: false };
    }

    // Find the point where they diverge
    let divergePoint = -1;
    const minLength = Math.min(stored.length, incoming.length);

    for (let i = 0; i < minLength; i++) {
        const storedSemanticId = stored[i].semanticId;
        const incomingSemanticId = incoming[i].id ?? hashMessage(incoming[i].role, incoming[i].content ?? '').slice(0, 16);

        if (storedSemanticId !== incomingSemanticId) {
            divergePoint = i;
            break;
        }
    }

    // If they diverge before the end of stored messages, it's a branch
    if (divergePoint >= 0 && divergePoint < stored.length) {
        return {
            isBranching: true,
            branchPoint: divergePoint
        };
    }

    return { isBranching: false };
}
