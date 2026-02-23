/**
 * Attachment data cache stub for Node.js
 *
 * The browser version caches attachment binary data in memory.
 * For Node.js/lumo-tamer, we store data directly in IndexedDB.
 */

import type { AttachmentId } from '../types';

export type CacheEntry = {
    data?: Uint8Array<ArrayBuffer>;
    imagePreview?: Uint8Array<ArrayBuffer>;
};

const cache = new Map<AttachmentId, CacheEntry>();

export function getCacheEntry(id: AttachmentId): CacheEntry | undefined {
    return cache.get(id);
}

export function setCacheEntry(id: AttachmentId, entry: CacheEntry): void {
    cache.set(id, entry);
}

export function deleteCacheEntry(id: AttachmentId): void {
    cache.delete(id);
}

export function clearCache(): void {
    cache.clear();
}

// Export as object for compatibility with upstream imports
export const attachmentDataCache = {
    get: getCacheEntry,
    set: setCacheEntry,
    delete: deleteCacheEntry,
    clear: clearCache,
    // Additional methods expected by upstream
    getData: (id: AttachmentId): Uint8Array<ArrayBuffer> | undefined => {
        return cache.get(id)?.data;
    },
    getImagePreview: (id: AttachmentId): Uint8Array<ArrayBuffer> | undefined => {
        return cache.get(id)?.imagePreview;
    },
    setData: (id: AttachmentId, data: Uint8Array<ArrayBuffer>): void => {
        const entry = cache.get(id) || {};
        entry.data = data;
        cache.set(id, entry);
    },
    setImagePreview: (id: AttachmentId, imagePreview: Uint8Array<ArrayBuffer>): void => {
        const entry = cache.get(id) || {};
        entry.imagePreview = imagePreview;
        cache.set(id, entry);
    },
};
