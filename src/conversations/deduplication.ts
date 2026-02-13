/**
 * Message deduplication utilities
 *
 * OpenAI API sends full conversation history with each request.
 * We need to deduplicate to avoid storing duplicate messages.
 */

import { createHash } from 'crypto';
import type { Message, MessageFingerprint, MessageRole } from './types.js';

/**
 * Compute hash for a message (role + content)
 */
export function hashMessage(role: string, content: string): string {
    const data = `${role}:${content}`;
    return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Create fingerprint for a message
 */
export function createFingerprint(
    role: MessageRole,
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
        msg.content,
        index
    ));
}

/**
 * Incoming message format from API
 */
export interface IncomingMessage {
    role: string;
    content: string;
}

/**
 * Find new messages that aren't already stored
 *
 * Strategy:
 * 1. Create fingerprints for both incoming and stored messages
 * 2. Match by sequence - incoming[0..n] should match stored[0..n]
 * 3. Return incoming messages after the matching prefix
 */
export function findNewMessages(
    incoming: IncomingMessage[],
    stored: Message[]
): IncomingMessage[] {
    if (stored.length === 0) {
        return incoming;
    }

    if (incoming.length === 0) {
        return [];
    }

    // Create fingerprints
    const storedFingerprints = fingerprintMessages(stored);
    const incomingFingerprints = incoming.map((msg, index) =>
        createFingerprint(msg.role as MessageRole, msg.content, index)
    );

    // Find where incoming messages diverge from stored
    let matchedCount = 0;
    for (let i = 0; i < Math.min(storedFingerprints.length, incomingFingerprints.length); i++) {
        if (storedFingerprints[i].hash === incomingFingerprints[i].hash) {
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
 * - Incoming starts with the same messages as stored (prefix match)
 * - Or incoming is entirely new (stored is empty)
 */
export function isValidContinuation(
    incoming: IncomingMessage[],
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

    // Check if incoming starts with the same messages
    for (let i = 0; i < stored.length; i++) {
        const storedHash = hashMessage(stored[i].role, stored[i].content);
        const incomingHash = hashMessage(incoming[i].role, incoming[i].content);

        if (storedHash !== incomingHash) {
            return {
                valid: false,
                reason: `Message mismatch at index ${i} - history may have been modified`,
                debugInfo: {
                    storedMsg: `${stored[i].role}: ${stored[i].content}`,
                    incomingMsg: `${incoming[i].role}: ${incoming[i].content}`,
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
    incoming: IncomingMessage[],
    stored: Message[]
): { isBranching: boolean; branchPoint?: number } {
    if (stored.length === 0 || incoming.length === 0) {
        return { isBranching: false };
    }

    // Find the point where they diverge
    let divergePoint = -1;
    const minLength = Math.min(stored.length, incoming.length);

    for (let i = 0; i < minLength; i++) {
        const storedHash = hashMessage(stored[i].role, stored[i].content);
        const incomingHash = hashMessage(incoming[i].role, incoming[i].content);

        if (storedHash !== incomingHash) {
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
