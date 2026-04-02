/**
 * Message deduplication utilities
 *
 * OpenAI API sends full conversation history with each request.
 * We need to deduplicate to avoid storing duplicate messages.
 */

import { createHash } from 'crypto';
import { Role } from '@lumo/types.js';
import type { Message, MessageForStore } from './types.js';
import { getMetrics } from '../app/metrics.js';
import logger from '../app/logger.js';
import { serverToolPrefix } from '../api/tools/server-tools/registry.js';

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

        // semantic id is stored or assistant response differs after a server tool call
        if (storedIds.has(incomingSemanticId) || stored[i + 1]?.semanticId?.startsWith(serverToolPrefix)) {
            matchedCount++;
        } else {
            // Divergence found - stop matching
            getMetrics()?.invalidContinuationsTotal.inc();
            logger.warn({
                index: i,
            }, 'Conversation message divergence');
            break;
        }
    }

    // Return messages after the matched prefix
    return incoming.slice(matchedCount);
}
