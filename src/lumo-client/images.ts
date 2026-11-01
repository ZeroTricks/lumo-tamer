/**
 * Image turn preparation for Lumo 2.0.
 *
 * Mirrors how Proton's web client packages uploaded images for the model
 * (ProtonMail/WebClients applications/lumo/src/app/llm/index.ts, createGroupedImageTurn /
 * expandAttachmentsIntoTurns / computeKeptImageIds, and packages/lumo-api-client/utils.ts
 * lumoImageMarker):
 *
 * - The bytes travel in `turn.images`; the text content of the same turn gets one
 *   `<lumo-image id=... />` marker per image, which is the model's only handle on it.
 *   The backend zips markers with the image parts of the same turn.
 * - Only the most recent N images of the conversation are sent. Older ones are
 *   dropped and replaced by a placeholder line.
 * - Title generation only ever sees text.
 */

import { Role, type ImageInput, type Turn } from './types.js';

/** Placeholder substituted for images excluded from the request (same text as upstream). */
export const OMITTED_IMAGE_PLACEHOLDER = '[[Image omitted to save context size]]';

/**
 * The text marker that names an image sent on a turn.
 * Source: packages/lumo-api-client/utils.ts (lumoImageMarker), kept identical.
 */
export function lumoImageMarker(id: string, source: 'user' | 'assistant', name?: string): string {
    const nameAttr = name ? ` name="${encodeURIComponent(name)}"` : '';
    return `<lumo-image id="${encodeURIComponent(id)}" source="${encodeURIComponent(source)}"${nameAttr} />`;
}

/** Whether any turn carries images. */
export function turnsHaveImages(turns: Turn[]): boolean {
    return turns.some((turn) => (turn.images?.length ?? 0) > 0);
}

/** Total number of images across all turns. */
export function countImages(turns: Turn[]): number {
    return turns.reduce((sum, turn) => sum + (turn.images?.length ?? 0), 0);
}

/**
 * Prepare turns for sending: add image markers (and omission placeholders) to the
 * text of turns that carry images, keeping only the `maxImages` most recent images
 * over the whole conversation. Turns without images are returned unchanged.
 *
 * Returns new turn objects; the input is not mutated, so callers can re-prepare
 * the original turns (e.g. for a bounce) without duplicating markers.
 */
export function prepareImageTurns(turns: Turn[], maxImages?: number): Turn[] {
    if (!turnsHaveImages(turns)) return turns;

    // Drop the oldest images beyond the limit (chronological order = turn order).
    const total = countImages(turns);
    let toDrop = maxImages !== undefined && maxImages >= 0 ? Math.max(0, total - maxImages) : 0;

    return turns.map((turn) => {
        const images = turn.images ?? [];
        if (images.length === 0) return turn;

        const dropped = Math.min(toDrop, images.length);
        toDrop -= dropped;
        const kept = images.slice(dropped);

        const source = turn.role === Role.Assistant ? 'assistant' : 'user';
        const markers = kept.map((image) => lumoImageMarker(image.image_id, source, (image as ImageInput).name));
        const placeholders = Array.from({ length: dropped }, () => OMITTED_IMAGE_PLACEHOLDER);
        const content = [turn.content, ...markers, ...placeholders].filter(Boolean).join('\n');

        const { images: _omit, ...rest } = turn;
        return kept.length > 0 ? { ...rest, content, images: kept } : { ...rest, content };
    });
}

/**
 * Text-only view of the turns for title generation: images are never sent
 * (upstream extractTitleSourceText skips image-only turns the same way).
 */
export function stripImagesForTitle(turns: Turn[]): Turn[] {
    if (!turnsHaveImages(turns)) return turns;
    return turns
        .map(({ images: _omit, ...rest }) => rest)
        .filter((turn) => turn.role !== Role.User || Boolean(turn.content));
}
