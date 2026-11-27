/**
 * Image input handling for the OpenAI-compatible API.
 *
 * Turns OpenAI `image_url` (Chat Completions) and `input_image` (Responses API)
 * content parts into Lumo `WireImage` objects (base64 bytes + image_id). The
 * image bytes travel to Lumo exactly like text: inside the turn, U2L-encrypted
 * by LumoClient when encryption is on.
 *
 * Validation mirrors what Lumo's web client accepts when a user uploads a file
 * (JPEG, PNG, GIF, WebP, HEIC/HEIF; see applications/lumo/src/app/llm/attachments.ts
 * upstream) and adds a configurable size limit. Formats are detected from the
 * image bytes, not from the declared MIME type.
 */

import { createHash } from 'crypto';
import bytes from 'bytes';
import { getImagesConfig } from '../app/config.js';
import { deterministicUUID } from '../app/id-generator.js';
import { logger } from '../app/logger.js';
import type { ImageInput } from '../lumo-client/types.js';

// ── Errors ───────────────────────────────────────────────────────────

/** Client error for an image the request carries; routes map it to an OpenAI-style 400. */
export class ImageInputError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly param: string | null = null,
  ) {
    super(message);
    this.name = 'ImageInputError';
  }
}

/** Internal: a remote body exceeded the size cap (distinguished from transport failures). */
class RemoteBodyTooLargeError extends Error {}

// ── Format detection ─────────────────────────────────────────────────

/** Image formats accepted by Lumo's web client (applications/lumo/src/app/llm/attachments.ts). */
export type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/heic' | 'image/heif';

const EXTENSION_BY_MIME: Record<ImageMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);

function ascii(data: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...data.subarray(start, end));
}

/** Detect a supported image format from its magic bytes. */
export function sniffImageMimeType(data: Uint8Array): ImageMimeType | undefined {
  if (data.length < 12) return undefined;
  if (data[0] === 0x89 && ascii(data, 1, 4) === 'PNG') return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (ascii(data, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(data, 4, 8) === 'ftyp') {
    const brand = ascii(data, 8, 12).toLowerCase();
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (HEIF_BRANDS.has(brand)) return 'image/heif';
  }
  return undefined;
}

// ── Content part extraction ──────────────────────────────────────────

/** Image reference found in a content part: a data URL, an http(s) URL, or an unsupported source. */
export interface ImageReference {
  url?: string;
  /** OpenAI `file_id` source (not supported by lumo-tamer). */
  fileId?: string;
}

/**
 * Request-wide image counter. Images are numbered across all messages of one
 * request so names (`image-3.jpg`) and ids are unique within the request, and
 * identical for the same history re-sent later.
 */
export interface ImageCounter {
  next: number;
}

export function createImageCounter(): ImageCounter {
  return { next: 1 };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Read the image reference out of one OpenAI content part, or undefined when the
 * part is not an image. Accepts:
 * - Chat Completions: `{ type: 'image_url', image_url: { url, detail? } }`
 * - Chat Completions (lenient): `{ type: 'image_url', image_url: '<url>' }`
 * - Responses API: `{ type: 'input_image', image_url: '<url>' | { url }, file_id?, detail? }`
 *
 * `detail` is accepted but ignored: Lumo has no equivalent.
 */
export function readImagePart(part: unknown): ImageReference | undefined {
  const obj = asRecord(part);
  if (!obj) return undefined;
  if (obj.type !== 'image_url' && obj.type !== 'input_image') return undefined;

  const ref: ImageReference = {};
  const imageUrl = obj.image_url;
  if (typeof imageUrl === 'string') {
    ref.url = imageUrl;
  } else {
    const nested = asRecord(imageUrl);
    if (typeof nested?.url === 'string') ref.url = nested.url;
  }
  if (typeof obj.file_id === 'string') ref.fileId = obj.file_id;
  return ref;
}

/** Whether a message content value (string or parts array) carries any image part. */
export function contentHasImages(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => readImagePart(part) !== undefined);
}

// ── Decoding ─────────────────────────────────────────────────────────

const DATA_URL_RE = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s;

export function isDataUrl(url: string): boolean {
  return /^data:/i.test(url);
}

export function isRemoteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Split a base64 data URL into its declared media type and raw base64 payload. */
export function parseDataUrl(url: string): { mediaType: string; base64: string } | undefined {
  const match = DATA_URL_RE.exec(url);
  if (!match) return undefined;
  const [, mediaType, params, payload] = match;
  if (!/;base64/i.test(params)) return undefined; // percent-encoded text payloads are never images
  return { mediaType: mediaType.toLowerCase(), base64: payload };
}

/** Configured per-image byte limit (validated positive by the config schema). */
function maxImageSizeBytes(): number {
  return bytes.parse(getImagesConfig().maxImageSize) ?? 0;
}

function describeSize(size: number): string {
  return bytes.format(size, { unitSeparator: ' ' }) ?? `${size} bytes`;
}

/**
 * Decode and validate base64 image data.
 *
 * @param base64 - Raw base64 payload (standard or URL-safe alphabet, whitespace tolerated)
 * @param ordinal - 1-based position of the image within the request (used in the name and errors)
 */
export function decodeImage(base64: string, ordinal: number): ImageInput {
  const maxSize = maxImageSizeBytes();
  const cleaned = base64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length === 0) {
    throw new ImageInputError(`Image ${ordinal} is not valid base64 data`, 'invalid_image_data');
  }

  // Exact decoded size of valid base64 (padding excluded); checked before decoding.
  const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0;
  const size = Math.floor((cleaned.length * 3) / 4) - padding;
  if (size > maxSize) {
    throw new ImageInputError(
      `Image ${ordinal} is ${describeSize(size)}, larger than the allowed ${describeSize(maxSize)} (server.images.maxImageSize)`,
      'image_too_large',
    );
  }

  const data = Buffer.from(cleaned, 'base64');
  const mimeType = sniffImageMimeType(data);
  if (!mimeType) {
    throw new ImageInputError(
      `Image ${ordinal} is not a supported image format. Supported: JPEG, PNG, GIF, WebP, HEIC/HEIF`,
      'unsupported_image_format',
    );
  }

  // Unique within the request (position) and stable when the same history is re-sent.
  const digest = createHash('sha256').update(data).digest('hex');
  return {
    encrypted: false,
    image_id: deterministicUUID(`image:${ordinal}:${digest}`),
    data: data.toString('base64'),
    mimeType,
    name: `image-${ordinal}.${EXTENSION_BY_MIME[mimeType]}`,
    size: data.length,
  };
}

/** Decode one image reference (after remote URLs were resolved into data URLs). */
function decodeImageReference(ref: ImageReference, ordinal: number): ImageInput {
  if (ref.fileId !== undefined && ref.url === undefined) {
    throw new ImageInputError(
      `Image ${ordinal} uses file_id, which lumo-tamer does not support. Send a data URL instead`,
      'unsupported_image_source',
    );
  }
  if (!ref.url) {
    throw new ImageInputError(`Image ${ordinal} has no image_url`, 'invalid_image_data');
  }
  if (isRemoteUrl(ref.url)) {
    // Only reachable when the route skipped resolveRemoteImageUrls (remote fetching disabled).
    throw new ImageInputError(
      `Image ${ordinal} references a remote URL. Send a data URL, or enable server.images.allowRemoteUrls`,
      'remote_image_not_allowed',
    );
  }
  const parsed = parseDataUrl(ref.url);
  if (!parsed) {
    throw new ImageInputError(
      `Image ${ordinal} must be a base64 data URL (data:image/jpeg;base64,...)`,
      'invalid_image_data',
    );
  }
  return decodeImage(parsed.base64, ordinal);
}

/**
 * Extract and decode every image part of a message's content.
 * Returns an empty array for string content or content without images.
 * Throws ImageInputError for disabled image input or invalid images.
 *
 * @param counter - Request-wide counter shared by all messages of one request
 */
export function extractImages(content: unknown, counter: ImageCounter = createImageCounter()): ImageInput[] {
  if (!Array.isArray(content)) return [];
  const refs: ImageReference[] = [];
  for (const part of content) {
    const ref = readImagePart(part);
    if (ref) refs.push(ref);
  }
  if (refs.length === 0) return [];

  if (!getImagesConfig().enabled) {
    throw new ImageInputError(
      'Image input is disabled on this server (server.images.enabled)',
      'image_input_disabled',
    );
  }

  return refs.map((ref) => decodeImageReference(ref, counter.next++));
}

// ── Remote URLs ──────────────────────────────────────────────────────

const REMOTE_FETCH_TIMEOUT_MS = 15_000;

/**
 * Read a response body with a hard size cap, without buffering more than the cap.
 * Cancels the body on failure so the connection is released immediately.
 */
async function readBodyCapped(res: Response, maxSize: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxSize) {
    await res.body?.cancel().catch(() => undefined);
    throw new RemoteBodyTooLargeError(`response is ${describeSize(declared)}, larger than ${describeSize(maxSize)}`);
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxSize) {
        throw new RemoteBodyTooLargeError(`response is larger than ${describeSize(maxSize)}`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * Download a remote image and return it as a base64 data URL.
 * The media type is left generic: the format is detected from the bytes anyway,
 * and a Content-Type header cannot break the data URL syntax this way.
 */
export async function fetchRemoteImage(url: string, ordinal: number): Promise<string> {
  const maxSize = maxImageSizeBytes();
  const failed = (detail: string) =>
    new ImageInputError(`Image ${ordinal} could not be downloaded from ${url}: ${detail}`, 'image_fetch_failed');

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS), redirect: 'follow' });
  } catch (error) {
    logger.warn({ error, url }, 'Failed to fetch remote image');
    throw failed(error instanceof Error ? error.message : String(error));
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw failed(`HTTP ${res.status}`);
  }
  let data: Buffer;
  try {
    data = await readBodyCapped(res, maxSize);
  } catch (error) {
    if (error instanceof RemoteBodyTooLargeError) {
      throw new ImageInputError(
        `Image ${ordinal} could not be downloaded from ${url}: ${error.message} (server.images.maxImageSize)`,
        'image_too_large',
      );
    }
    throw failed(error instanceof Error ? error.message : String(error));
  }
  return `data:application/octet-stream;base64,${data.toString('base64')}`;
}

/**
 * The parts of one request item that the message converter decodes images from:
 * a `function_call_output` item's `output` array (Responses API tool outputs) or
 * a user message's `content` array. Image parts anywhere else are ignored by the
 * converter, so they are neither downloaded nor counted.
 */
function imageSourceParts(item: unknown): unknown[] {
  const record = asRecord(item);
  if (!record) return [];
  if (record.type === 'function_call_output') return Array.isArray(record.output) ? record.output : [];
  if (record.role === 'user' && Array.isArray(record.content)) return record.content;
  return [];
}

/**
 * Replace http(s) image URLs in user messages and tool outputs with data URLs by
 * downloading them. Mutates the parts in place. No-op when remote fetching (or
 * image input) is disabled; the later decoding step then rejects remote URLs.
 *
 * At most `maxImagesPerRequest` remote images are downloaded, concurrently.
 * Ordinals follow the converter's request-wide numbering, so errors name the
 * same image either way.
 *
 * @param messages - Chat Completions `messages` or Responses API `input` array
 */
export async function resolveRemoteImageUrls(messages: unknown): Promise<void> {
  const config = getImagesConfig();
  if (!Array.isArray(messages) || !config.allowRemoteUrls || !config.enabled) return;

  const remote: Array<{ part: Record<string, unknown>; url: string; ordinal: number }> = [];
  let ordinal = 0;
  for (const message of messages) {
    for (const part of imageSourceParts(message)) {
      const ref = readImagePart(part);
      if (!ref) continue;
      ordinal++;
      if (ref.url && isRemoteUrl(ref.url)) {
        remote.push({ part: part as Record<string, unknown>, url: ref.url, ordinal });
      }
    }
  }
  if (remote.length === 0) return;
  if (remote.length > config.maxImagesPerRequest) {
    throw new ImageInputError(
      `Request references ${remote.length} remote images; at most ${config.maxImagesPerRequest} are downloaded per request (server.images.maxImagesPerRequest)`,
      'too_many_images',
    );
  }

  await Promise.all(
    remote.map(async ({ part, url, ordinal: n }) => {
      const dataUrl = await fetchRemoteImage(url, n);
      part.image_url = typeof part.image_url === 'string' ? dataUrl : { ...asRecord(part.image_url), url: dataUrl };
    }),
  );
}
