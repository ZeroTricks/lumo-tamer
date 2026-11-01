/**
 * Unit tests for src/api/images.ts: content-part parsing, data URL decoding,
 * format sniffing, limits, and remote URL resolution.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ImageInputError,
  decodeImage,
  extractImages,
  parseDataUrl,
  readImagePart,
  contentHasImages,
  resolveRemoteImageUrls,
  sniffImageMimeType,
} from '../../src/api/images.js';
import { getImagesConfig } from '../../src/app/config.js';
import {
  BMP_BYTES, GIF_BYTES, HEIC_BYTES, HEIF_BYTES, JPEG_BYTES, PNG_BYTES, TEXT_BYTES, WEBP_BYTES,
  JPEG_DATA_URL, PNG_DATA_URL, dataUrl, imageUrlPart, inputImagePart,
} from '../helpers/images.js';

const originalConfig = { ...getImagesConfig() };

afterEach(() => {
  Object.assign(getImagesConfig(), originalConfig);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sniffImageMimeType', () => {
  it('detects the formats Lumo accepts', () => {
    expect(sniffImageMimeType(PNG_BYTES)).toBe('image/png');
    expect(sniffImageMimeType(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffImageMimeType(GIF_BYTES)).toBe('image/gif');
    expect(sniffImageMimeType(WEBP_BYTES)).toBe('image/webp');
    expect(sniffImageMimeType(HEIC_BYTES)).toBe('image/heic');
    expect(sniffImageMimeType(HEIF_BYTES)).toBe('image/heif');
  });

  it('rejects unsupported or non-image bytes', () => {
    expect(sniffImageMimeType(BMP_BYTES)).toBeUndefined();
    expect(sniffImageMimeType(TEXT_BYTES)).toBeUndefined();
    expect(sniffImageMimeType(new Uint8Array(3))).toBeUndefined();
  });
});

describe('parseDataUrl', () => {
  it('splits media type and base64 payload', () => {
    expect(parseDataUrl('data:image/png;base64,AAAA')).toEqual({ mediaType: 'image/png', base64: 'AAAA' });
    expect(parseDataUrl('data:;base64,AAAA')).toEqual({ mediaType: '', base64: 'AAAA' });
  });

  it('rejects non-base64 and non-data URLs', () => {
    expect(parseDataUrl('data:text/plain,hello')).toBeUndefined();
    expect(parseDataUrl('https://example.com/a.png')).toBeUndefined();
  });
});

describe('readImagePart', () => {
  it('reads Chat Completions image_url parts (object and string forms)', () => {
    expect(readImagePart(imageUrlPart('data:x', 'low'))).toEqual({ url: 'data:x' });
    expect(readImagePart({ type: 'image_url', image_url: 'data:y' })).toEqual({ url: 'data:y' });
  });

  it('reads Responses API input_image parts', () => {
    expect(readImagePart(inputImagePart('data:z'))).toEqual({ url: 'data:z' });
    expect(readImagePart({ type: 'input_image', image_url: { url: 'data:w' } })).toEqual({ url: 'data:w' });
    expect(readImagePart({ type: 'input_image', file_id: 'file-1' })).toEqual({ fileId: 'file-1' });
  });

  it('ignores text and unknown parts', () => {
    expect(readImagePart({ type: 'text', text: 'hi' })).toBeUndefined();
    expect(readImagePart('plain')).toBeUndefined();
    expect(readImagePart(null)).toBeUndefined();
  });

  it('contentHasImages only matches part arrays with images', () => {
    expect(contentHasImages('text')).toBe(false);
    expect(contentHasImages([{ type: 'text', text: 'a' }])).toBe(false);
    expect(contentHasImages([{ type: 'text', text: 'a' }, imageUrlPart(PNG_DATA_URL)])).toBe(true);
  });
});

describe('decodeImage', () => {
  it('produces a WireImage with detected type, name and a stable id', () => {
    const image = decodeImage(PNG_BYTES.toString('base64'), 1);
    expect(image.encrypted).toBe(false);
    expect(image.data).toBe(PNG_BYTES.toString('base64'));
    expect(image.mimeType).toBe('image/png');
    expect(image.name).toBe('image-1.png');
    expect(image.size).toBe(PNG_BYTES.length);
    expect(image.image_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Same bytes at the same position -> same id (stable across re-sent history);
    // another position or other bytes -> different id (unique within a request)
    expect(decodeImage(PNG_BYTES.toString('base64'), 1).image_id).toBe(image.image_id);
    expect(decodeImage(PNG_BYTES.toString('base64'), 2).image_id).not.toBe(image.image_id);
    expect(decodeImage(JPEG_BYTES.toString('base64'), 1).image_id).not.toBe(image.image_id);
    expect(decodeImage(JPEG_BYTES.toString('base64'), 7).name).toBe('image-7.jpg');
  });

  it('tolerates whitespace and URL-safe base64', () => {
    const b64 = JPEG_BYTES.toString('base64url');
    const wrapped = b64.slice(0, 10) + '\n' + b64.slice(10);
    expect(decodeImage(wrapped, 1).data).toBe(JPEG_BYTES.toString('base64'));
  });

  it('rejects invalid base64', () => {
    expect(() => decodeImage('not base64!!', 1)).toThrow(ImageInputError);
    expect(() => decodeImage('', 1)).toThrowError(expect.objectContaining({ code: 'invalid_image_data' }));
  });

  it('rejects unsupported formats', () => {
    expect(() => decodeImage(BMP_BYTES.toString('base64'), 1)).toThrowError(
      expect.objectContaining({ code: 'unsupported_image_format' }),
    );
    expect(() => decodeImage(TEXT_BYTES.toString('base64'), 2)).toThrowError(/Image 2 is not a supported/);
  });

  it('enforces maxImageSize exactly, without counting base64 padding', () => {
    Object.assign(getImagesConfig(), { maxImageSize: 16 });
    expect(() => decodeImage(JPEG_BYTES.toString('base64'), 1)).toThrowError(
      expect.objectContaining({ code: 'image_too_large' }),
    );
    // JPEG_BYTES is 32 bytes: exactly at the limit passes, one byte over fails
    Object.assign(getImagesConfig(), { maxImageSize: JPEG_BYTES.length });
    expect(decodeImage(JPEG_BYTES.toString('base64'), 1).size).toBe(JPEG_BYTES.length);
    const oneMore = Buffer.concat([JPEG_BYTES, Buffer.from([0])]); // 33 bytes -> base64 ends with '='
    expect(() => decodeImage(oneMore.toString('base64'), 1)).toThrowError(/33 B, larger than the allowed 32 B/);
    Object.assign(getImagesConfig(), { maxImageSize: '1kb' });
    expect(decodeImage(JPEG_BYTES.toString('base64'), 1).mimeType).toBe('image/jpeg');
  });
});

describe('extractImages', () => {
  it('returns [] for string content or parts without images', () => {
    expect(extractImages('hello')).toEqual([]);
    expect(extractImages([{ type: 'text', text: 'hello' }])).toEqual([]);
    expect(extractImages(undefined)).toEqual([]);
  });

  it('decodes every image part in order, numbering names per message', () => {
    const images = extractImages([
      imageUrlPart(JPEG_DATA_URL),
      { type: 'text', text: 'between' },
      imageUrlPart(PNG_DATA_URL),
    ]);
    expect(images.map((i) => i.name)).toEqual(['image-1.jpg', 'image-2.png']);
    expect(images.map((i) => i.mimeType)).toEqual(['image/jpeg', 'image/png']);
  });

  it('detects the format from bytes, not from the declared media type', () => {
    const [image] = extractImages([imageUrlPart(dataUrl(PNG_BYTES, 'image/jpeg'))]);
    expect(image.mimeType).toBe('image/png');
  });

  it('rejects images when image input is disabled', () => {
    Object.assign(getImagesConfig(), { enabled: false });
    expect(() => extractImages([imageUrlPart(PNG_DATA_URL)])).toThrowError(
      expect.objectContaining({ code: 'image_input_disabled' }),
    );
    // Text-only content is unaffected
    expect(extractImages([{ type: 'text', text: 'hi' }])).toEqual([]);
  });

  it('rejects file_id sources, remote URLs (when disabled) and non-data URLs', () => {
    expect(() => extractImages([{ type: 'input_image', file_id: 'file-1' }])).toThrowError(
      expect.objectContaining({ code: 'unsupported_image_source' }),
    );
    expect(() => extractImages([imageUrlPart('https://example.com/cat.jpg')])).toThrowError(
      expect.objectContaining({ code: 'remote_image_not_allowed' }),
    );
    expect(() => extractImages([imageUrlPart('ftp://example.com/cat.jpg')])).toThrowError(
      expect.objectContaining({ code: 'invalid_image_data' }),
    );
    expect(() => extractImages([{ type: 'image_url', image_url: {} }])).toThrowError(
      expect.objectContaining({ code: 'invalid_image_data' }),
    );
  });
});

describe('resolveRemoteImageUrls', () => {
  const OCTET = (bytes: Buffer) => `data:application/octet-stream;base64,${bytes.toString('base64')}`;

  function mockFetch(body: Buffer, init: { status?: number; contentType?: string; contentLength?: boolean } = {}) {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(body), {
      status: init.status ?? 200,
      headers: {
        'content-type': init.contentType ?? 'image/png',
        ...(init.contentLength === false ? {} : { 'content-length': String(body.length) }),
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const remoteUser = (url: string) => ({ role: 'user', content: [imageUrlPart(url)] });

  it('does nothing when remote URLs are disabled', async () => {
    const fetchMock = mockFetch(PNG_BYTES);
    const messages = [remoteUser('https://example.com/a.png')];
    await resolveRemoteImageUrls(messages);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((messages[0].content[0] as any).image_url.url).toBe('https://example.com/a.png');
  });

  it('does not fetch when image input is disabled or the part is not on a user message', async () => {
    Object.assign(getImagesConfig(), { allowRemoteUrls: true, enabled: false });
    const fetchMock = mockFetch(PNG_BYTES);
    await resolveRemoteImageUrls([remoteUser('https://example.com/a.png')]);
    expect(fetchMock).not.toHaveBeenCalled();

    Object.assign(getImagesConfig(), { enabled: true });
    await resolveRemoteImageUrls([{ role: 'assistant', content: [imageUrlPart('https://example.com/a.png')] }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('replaces remote URLs with data URLs (object and string image_url forms)', async () => {
    Object.assign(getImagesConfig(), { allowRemoteUrls: true });
    const fetchMock = mockFetch(PNG_BYTES);
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, imageUrlPart('https://example.com/a.png', 'high')] },
      { role: 'user', content: [inputImagePart('https://example.com/b.png'), imageUrlPart(JPEG_DATA_URL)] },
    ];
    await resolveRemoteImageUrls(messages);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((messages[0].content[1] as any).image_url).toEqual({ url: OCTET(PNG_BYTES), detail: 'high' });
    expect((messages[1].content[0] as any).image_url).toBe(OCTET(PNG_BYTES));
    expect((messages[1].content[1] as any).image_url.url).toBe(JPEG_DATA_URL); // untouched
    // The resolved content decodes like any data URL (format sniffed from bytes)
    expect(extractImages(messages[0].content)[0].mimeType).toBe('image/png');
  });

  it('is not confused by odd Content-Type headers', async () => {
    Object.assign(getImagesConfig(), { allowRemoteUrls: true });
    mockFetch(PNG_BYTES, { contentType: 'image/png, image/png' });
    const messages = [remoteUser('https://example.com/a.png')];
    await resolveRemoteImageUrls(messages);
    expect(extractImages(messages[0].content)[0].mimeType).toBe('image/png');
  });

  it('caps the number of remote images per request before fetching', async () => {
    Object.assign(getImagesConfig(), { allowRemoteUrls: true, maxImagesPerRequest: 2 });
    const fetchMock = mockFetch(PNG_BYTES);
    const messages = [
      { role: 'user', content: [1, 2, 3].map((i) => imageUrlPart(`https://example.com/${i}.png`)) },
    ];
    await expect(resolveRemoteImageUrls(messages)).rejects.toThrowError(
      expect.objectContaining({ code: 'too_many_images' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads remote images in function_call_output arrays', async () => {
    Object.assign(getImagesConfig(), { allowRemoteUrls: true });
    const fetchMock = mockFetch(PNG_BYTES);
    const input = [
      { role: 'user', content: 'Take a snapshot' },
      { type: 'function_call_output', call_id: 'call_snap', output: [
        { type: 'input_text', text: 'Snapshot taken' },
        inputImagePart('https://camera.local/snap.png'),
      ] },
      { type: 'function_call_output', call_id: 'call_text', output: 'no images here' },
    ];
    await resolveRemoteImageUrls(input);
    expect(fetchMock).toHaveBeenCalledWith('https://camera.local/snap.png', expect.anything());
    expect((input[1] as any).output[1].image_url).toBe(OCTET(PNG_BYTES));
    expect(extractImages((input[1] as any).output)[0].mimeType).toBe('image/png');
  });

  it('counts tool-output images toward the remote image cap', async () => {
    Object.assign(getImagesConfig(), { allowRemoteUrls: true, maxImagesPerRequest: 1 });
    const fetchMock = mockFetch(PNG_BYTES);
    const input = [
      remoteUser('https://example.com/a.png'),
      { type: 'function_call_output', call_id: 'call_snap', output: [inputImagePart('https://camera.local/snap.png')] },
    ];
    await expect(resolveRemoteImageUrls(input)).rejects.toThrowError(
      expect.objectContaining({ code: 'too_many_images', message: expect.stringContaining('2 remote images') }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('numbers tool-output images like the message converter', async () => {
    Object.assign(getImagesConfig(), { allowRemoteUrls: true });
    mockFetch(Buffer.alloc(0), { status: 404 });
    const input = [
      { role: 'user', content: [inputImagePart(PNG_DATA_URL)] },
      { role: 'assistant', content: [inputImagePart('https://example.com/ignored.png')] },
      { type: 'function_call_output', call_id: 'call_snap', output: [inputImagePart('https://camera.local/snap.png')] },
    ];
    await expect(resolveRemoteImageUrls(input)).rejects.toThrowError(
      expect.objectContaining({ code: 'image_fetch_failed', message: expect.stringMatching(/^Image 2 .*snap\.png/) }),
    );
  });

  it('reports download failures as image_fetch_failed', async () => {
    Object.assign(getImagesConfig(), { allowRemoteUrls: true });
    mockFetch(Buffer.alloc(0), { status: 404 });
    await expect(resolveRemoteImageUrls([remoteUser('https://example.com/x.png')]))
      .rejects.toThrowError(expect.objectContaining({ code: 'image_fetch_failed', message: expect.stringContaining('HTTP 404') }));

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(resolveRemoteImageUrls([remoteUser('https://example.com/x.png')]))
      .rejects.toThrowError(expect.objectContaining({ code: 'image_fetch_failed' }));

    // A body that fails mid-stream (e.g. the 15s timeout) is a fetch failure, not a size error
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError')); },
    }), { status: 200, headers: { 'content-type': 'image/png' } })));
    await expect(resolveRemoteImageUrls([remoteUser('https://example.com/x.png')]))
      .rejects.toThrowError(expect.objectContaining({ code: 'image_fetch_failed', message: expect.stringContaining('timeout') }));
  });

  it('caps downloads at maxImageSize, with and without content-length', async () => {
    Object.assign(getImagesConfig(), { allowRemoteUrls: true, maxImageSize: 16 });
    mockFetch(JPEG_BYTES);
    await expect(resolveRemoteImageUrls([remoteUser('https://example.com/x.jpg')]))
      .rejects.toThrowError(expect.objectContaining({ code: 'image_too_large' }));

    mockFetch(JPEG_BYTES, { contentLength: false });
    await expect(resolveRemoteImageUrls([remoteUser('https://example.com/x.jpg')]))
      .rejects.toThrowError(expect.objectContaining({ code: 'image_too_large' }));
  });
});
