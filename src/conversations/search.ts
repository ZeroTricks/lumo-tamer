/**
 * Conversation search utilities
 *
 * Simple .includes() based search for conversation titles and message content.
 * Snippet extraction inspired by WebClients searchService.ts.
 */

import type { ConversationStore } from './store.js';
import type { ConversationId, Message } from './types.js';

export interface SearchResult {
    conversationId: ConversationId;
    title: string;
    /** Snippet around match in message content, if found */
    snippet?: string;
    updatedAt: string;
}

/**
 * Search conversations by title and message content
 *
 * @param store - Conversation store to search
 * @param query - Search query (case-insensitive)
 * @param limit - Maximum results to return (default 20)
 * @param excludeId - Conversation ID to exclude (e.g., current conversation)
 * @returns Array of matching conversations, sorted by most recent first
 */
export function searchConversations(
    store: Pick<ConversationStore, 'entries'>,
    query: string,
    limit = 20,
    excludeId?: ConversationId
): SearchResult[] {
    const lowerQuery = query.toLowerCase();
    const results: SearchResult[] = [];

    for (const [id, conv] of store.entries()) {
        // Skip excluded conversation (e.g., current one)
        if (excludeId && id === excludeId) continue;

        // Check title
        const titleMatch = conv.title?.toLowerCase().includes(lowerQuery);

        // Check messages for content match
        let snippet: string | undefined;
        if (!titleMatch) {
            snippet = findMatchingSnippet(conv.messages, lowerQuery);
        }

        if (titleMatch || snippet) {
            results.push({
                conversationId: id,
                title: conv.title ?? 'Untitled',
                snippet,
                updatedAt: conv.metadata.updatedAt,
            });
        }

        if (results.length >= limit) break;
    }

    // Sort by updatedAt descending (most recent first)
    results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return results;
}

/**
 * Find a matching snippet in messages
 *
 * Searches message content for the query and extracts a snippet
 * with context around the match.
 */
function findMatchingSnippet(messages: Message[], lowerQuery: string): string | undefined {
    for (const msg of messages) {
        const content = msg.content;
        if (!content) continue;

        const lowerContent = content.toLowerCase();
        const matchIndex = lowerContent.indexOf(lowerQuery);

        if (matchIndex !== -1) {
            return extractSnippet(content, matchIndex, lowerQuery.length);
        }
    }
    return undefined;
}

/**
 * Extract a snippet around a match position
 *
 * Takes ~80 characters on each side of the match, adds ellipsis
 * if truncated, and normalizes whitespace.
 *
 * Based on WebClients searchService.ts snippet extraction.
 */
function extractSnippet(content: string, matchIndex: number, matchLength: number): string {
    const radius = 80;
    const start = Math.max(0, matchIndex - radius);
    const end = Math.min(content.length, matchIndex + matchLength + radius);

    let snippet = content.slice(start, end);

    // Add ellipsis indicators
    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet = snippet + '...';

    // Normalize whitespace (newlines, multiple spaces)
    return snippet.replace(/\s+/g, ' ').trim();
}

/**
 * Strip markdown formatting from text
 */
function stripMarkdown(text: string): string {
    return text
        // Code blocks (```...```)
        .replace(/```[\s\S]*?```/g, '')
        // Inline code (`...`)
        .replace(/`([^`]+)`/g, '$1')
        // Bold (**...** or __...__)
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        // Italic (*...* or _..._)
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        // Links [text](url)
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        // Headers
        .replace(/^#{1,6}\s+/gm, '')
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Format date for display (e.g., "Mar 30" or "Mar 30, 2024")
 */
function formatShortDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const month = date.toLocaleDateString('en-US', { month: 'short' });
    const day = date.getDate();

    if (date.getFullYear() === now.getFullYear()) {
        return `${month} ${day}`;
    }
    return `${month} ${day}, ${date.getFullYear()}`;
}

/**
 * Format search results for CLI output
 */
export function formatSearchResults(results: SearchResult[], query: string): string {
    if (results.length === 0) {
        return `No results found for "${query}"`;
    }

    const lines: string[] = [];
    lines.push(`Found ${results.length} result${results.length === 1 ? '' : 's'}:`);
    lines.push('');

    for (const result of results) {
        lines.push(`**${stripMarkdown(result.title)}** ${formatShortDate(result.updatedAt)}`);
        if (result.snippet) {
            lines.push(`  ${stripMarkdown(result.snippet)}`);
        }
        lines.push(`  ID: ${result.conversationId}`);
        lines.push('');
    }

    return lines.join('\n');
}
