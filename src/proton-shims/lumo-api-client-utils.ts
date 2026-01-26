/**
 * Utility functions for Lumo API client
 *
 * Source: WebClients/applications/lumo/src/app/lib/lumo-api-client/utils.ts
 * Note: This is a minimal subset - only functions we actually use are included.
 * The full upstream file has additional utilities that depend on types we don't have.
 */

/**
 * Post-process generated titles (remove quotes, trim, etc.)
 *
 * Source: WebClients utils.ts lines 60-73
 */
export function postProcessTitle(title: string): string {
    // Remove surrounding quotes if present
    let processed = title.replace(/^["']|["']$/g, '');

    // Trim whitespace
    processed = processed.trim();

    // Limit length (optional)
    if (processed.length > 100) {
        processed = processed.substring(0, 97) + '...';
    }

    return processed || 'Untitled Conversation';
}
