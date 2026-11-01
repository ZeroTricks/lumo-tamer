/**
 * Image fixtures for tests.
 *
 * lumo-tamer validates images by their magic bytes only, so synthetic headers
 * padded with zeros are enough to exercise the full pipeline without real
 * picture data. PNG_1X1 is a real (transparent) 1x1 PNG.
 */

/** Real 1x1 transparent PNG. */
export const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function withPadding(head: number[], size = 32): Buffer {
  const buf = Buffer.alloc(size);
  Buffer.from(head).copy(buf);
  return buf;
}

/** JFIF header: FF D8 FF E0 00 10 'JFIF' 00 */
export const JPEG_BYTES = withPadding([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
export const GIF_BYTES = withPadding([...Buffer.from('GIF89a'), 0x01, 0x00, 0x01, 0x00]);
export const WEBP_BYTES = withPadding([...Buffer.from('RIFF'), 0x18, 0x00, 0x00, 0x00, ...Buffer.from('WEBPVP8 ')]);
export const HEIC_BYTES = withPadding([0x00, 0x00, 0x00, 0x18, ...Buffer.from('ftypheic'), 0x00, 0x00, 0x00, 0x00]);
export const HEIF_BYTES = withPadding([0x00, 0x00, 0x00, 0x18, ...Buffer.from('ftypmif1'), 0x00, 0x00, 0x00, 0x00]);
/** BMP is not accepted by Lumo's web client, so it is rejected. */
export const BMP_BYTES = withPadding([...Buffer.from('BM'), 0x3a, 0x00, 0x00, 0x00]);
export const TEXT_BYTES = Buffer.from('definitely not an image, just plain text');

export const PNG_BYTES = Buffer.from(PNG_1X1_BASE64, 'base64');

export function dataUrl(bytes: Buffer, mediaType = 'image/jpeg'): string {
  return `data:${mediaType};base64,${bytes.toString('base64')}`;
}

export const PNG_DATA_URL = dataUrl(PNG_BYTES, 'image/png');
export const JPEG_DATA_URL = dataUrl(JPEG_BYTES, 'image/jpeg');

/** Chat Completions image part. */
export function imageUrlPart(url: string, detail?: 'auto' | 'low' | 'high') {
  return { type: 'image_url', image_url: { url, ...(detail ? { detail } : {}) } };
}

/** Responses API image part. */
export function inputImagePart(url: string) {
  return { type: 'input_image', image_url: url };
}
