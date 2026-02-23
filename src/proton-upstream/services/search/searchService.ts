/**
 * Search service stub for Node.js
 *
 * The browser version provides full-text search for attachments.
 * For lumo-tamer, we don't need this functionality (yet).
 */

import type { Attachment } from '../../types';

export class SearchService {
    private static instances = new Map<string, SearchService>();

    private constructor(_userId: string) {}

    static get(userId: string): SearchService {
        let instance = SearchService.instances.get(userId);
        if (!instance) {
            instance = new SearchService(userId);
            SearchService.instances.set(userId, instance);
        }
        return instance;
    }

    async indexAttachment(_attachment: Attachment): Promise<void> {
        // Stub - no-op for Node.js
    }

    async unindexAttachment(_attachmentId: string): Promise<void> {
        // Stub - no-op for Node.js
    }

    async reindexUploadedAttachments(_attachments: Attachment[]): Promise<{ success: boolean; indexed: number }> {
        // Stub - no-op for Node.js
        return { success: true, indexed: 0 };
    }

    async search(_query: string): Promise<Attachment[]> {
        // Stub - no-op for Node.js
        return [];
    }

    async clearDriveDocuments(): Promise<void> {
        // Stub - no-op for Node.js
    }
}
