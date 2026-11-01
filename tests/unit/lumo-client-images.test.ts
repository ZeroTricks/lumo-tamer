/**
 * Image handling in the Lumo client layer: turn preparation (markers, limits,
 * title stripping), U2L encryption of image bytes, and the request body sent
 * through the transport.
 */

import { describe, it, expect, vi } from 'vitest';
import { LumoClient } from '../../src/lumo-client/client.js';
import { Role, type ImageInput, type ProtonApiOptions, type Turn } from '../../src/lumo-client/types.js';
import {
  OMITTED_IMAGE_PLACEHOLDER,
  lumoImageMarker,
  prepareImageTurns,
  stripImagesForTitle,
  turnsHaveImages,
} from '../../src/lumo-client/images.js';
import type { ChatCompletionsBody, ChatImagePart, ChatTextPart } from '../../src/lumo-client/v2-body.js';
import { encryptTurns } from '@lumo/lib/lumo-api-client/core/encryption.js';
import { RequestEncryptionParams, generateRequestKey } from '@lumo/lib/lumo-api-client/core/encryptionParams.js';
import { decryptUint8Array, decryptString } from '@lumo/crypto/index.js';
import { JPEG_BYTES, PNG_BYTES } from '../helpers/images.js';

function img(id: string, data: Buffer, name?: string): ImageInput {
  return { encrypted: false, image_id: id, data: data.toString('base64'), name };
}

const PNG = img('11111111-1111-4111-8111-111111111111', PNG_BYTES, 'image-1.png');
const JPEG = img('22222222-2222-4222-8222-222222222222', JPEG_BYTES, 'image-1.jpg');

/** Build a fake SSE ReadableStream from CompletionChunk objects, ending with [DONE]. */
function sseStream(chunks: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const lines = [...chunks.map((c) => `data:${JSON.stringify(c)}\n`), 'data:[DONE]\n'];
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
}

const cc = (delta: object) => ({ object: 'CompletionChunk', model: 'lumo', choices: [{ index: 0, delta }] });

function makeClient(handler: (opts: ProtonApiOptions) => object[], enableEncryption = false) {
  const api = vi.fn(async (opts: ProtonApiOptions) => sseStream(handler(opts)));
  const client = new LumoClient(api as never, { enableEncryption });
  return { client, api, bodies: () => api.mock.calls.map((c) => c[0].data as ChatCompletionsBody) };
}

describe('lumoImageMarker', () => {
  it('matches the upstream marker format', () => {
    expect(lumoImageMarker('abc', 'user', 'pic.webp')).toBe('<lumo-image id="abc" source="user" name="pic.webp" />');
    expect(lumoImageMarker('a b', 'assistant')).toBe('<lumo-image id="a%20b" source="assistant" />');
  });
});

describe('prepareImageTurns', () => {
  it('returns the same array when no turn has images', () => {
    const turns: Turn[] = [{ role: Role.User, content: 'hi' }];
    expect(turnsHaveImages(turns)).toBe(false);
    expect(prepareImageTurns(turns, 10)).toBe(turns);
  });

  it('appends one marker per image after the text and keeps the bytes', () => {
    const turns: Turn[] = [{ role: Role.User, content: 'What is this?', images: [PNG, JPEG] }];
    const [turn] = prepareImageTurns(turns, 10);
    expect(turn.content).toBe(
      `What is this?\n${lumoImageMarker(PNG.image_id, 'user', 'image-1.png')}\n${lumoImageMarker(JPEG.image_id, 'user', 'image-1.jpg')}`,
    );
    expect(turn.images).toEqual([PNG, JPEG]);
    // Input untouched (bounce re-prepares the original turns)
    expect(turns[0].content).toBe('What is this?');
  });

  it('gives image-only turns non-empty content', () => {
    const [turn] = prepareImageTurns([{ role: Role.User, content: '', images: [PNG] }], 10);
    expect(turn.content).toBe(lumoImageMarker(PNG.image_id, 'user', 'image-1.png'));
  });

  it('keeps only the most recent images across the conversation and adds placeholders', () => {
    const turns: Turn[] = [
      { role: Role.User, content: 'first', images: [PNG, JPEG] },
      { role: Role.Assistant, content: 'ok' },
      { role: Role.User, content: 'second', images: [PNG] },
    ];
    const prepared = prepareImageTurns(turns, 2);
    expect(prepared[0].content).toBe(`first\n${lumoImageMarker(JPEG.image_id, 'user', 'image-1.jpg')}\n${OMITTED_IMAGE_PLACEHOLDER}`);
    expect(prepared[0].images).toEqual([JPEG]);
    expect(prepared[1]).toBe(turns[1]);
    expect(prepared[2].images).toEqual([PNG]);

    // Limit 0 drops everything; no `images` key remains
    const none = prepareImageTurns(turns, 0);
    expect(none[0].images).toBeUndefined();
    expect(none[0].content).toBe(`first\n${OMITTED_IMAGE_PLACEHOLDER}\n${OMITTED_IMAGE_PLACEHOLDER}`);
    // Undefined limit keeps all
    expect(prepareImageTurns(turns, undefined)[0].images).toHaveLength(2);
  });

  it('uses the assistant source for assistant turns', () => {
    const [turn] = prepareImageTurns([{ role: Role.Assistant, content: 'here', images: [PNG] }], 10);
    expect(turn.content).toContain('source="assistant"');
  });
});

describe('stripImagesForTitle', () => {
  it('drops image bytes and image-only user turns', () => {
    const turns: Turn[] = [
      { role: Role.User, content: '', images: [PNG] },
      { role: Role.User, content: 'describe', images: [JPEG] },
      { role: Role.Assistant, content: 'a cat' },
    ];
    expect(stripImagesForTitle(turns)).toEqual([
      { role: Role.User, content: 'describe' },
      { role: Role.Assistant, content: 'a cat' },
    ]);
    const textOnly: Turn[] = [{ role: Role.User, content: 'hi' }];
    expect(stripImagesForTitle(textOnly)).toBe(textOnly);
  });
});

describe('U2L encryption of image bytes (vendored encryptTurns)', () => {
  it('encrypts each image with the request key and the request AD, decryptable with the same', async () => {
    const requestKey = await generateRequestKey();
    const params = new RequestEncryptionParams(requestKey, 'req-id-1');
    const [turn] = await encryptTurns([{ role: Role.User, content: 'look', images: [PNG, JPEG] }], params);

    expect(turn.encrypted).toBe(true);
    expect(turn.content).not.toBe('look');
    expect(turn.images).toHaveLength(2);
    for (const [i, original] of [PNG, JPEG].entries()) {
      const image = turn.images![i];
      expect(image.encrypted).toBe(true);
      expect(image.image_id).toBe(original.image_id);
      expect(image.data).not.toBe(original.data);
      const plain = await decryptUint8Array(image.data, requestKey, RequestEncryptionParams.getRequestAd('req-id-1'));
      expect(Buffer.from(plain).toString('base64')).toBe(original.data);
      // A different AD (e.g. another request id) must fail
      await expect(decryptUint8Array(image.data, requestKey, RequestEncryptionParams.getRequestAd('other'))).rejects.toThrow();
    }
    expect(await decryptString(turn.content!, requestKey, RequestEncryptionParams.getRequestAd('req-id-1'))).toBe('look');
  });
});

describe('LumoClient with images', () => {
  const userTurn = (): Turn => ({ role: Role.User, content: 'What is in this picture?', images: [PNG] });

  it('sends plaintext images as content parts with markers in the text', async () => {
    const { client, bodies } = makeClient(() => [cc({ content: 'A dot.' })]);
    const res = await client.chatWithHistory([userTurn()], undefined, { maxImagesPerRequest: 10 });
    expect(res.message.content).toBe('A dot.');

    const [body] = bodies();
    const message = body.messages[0];
    expect(message.role).toBe('user');
    expect(message.encrypted).toBeUndefined();
    const parts = message.content as Array<ChatTextPart | ChatImagePart>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: `What is in this picture?\n${lumoImageMarker(PNG.image_id, 'user', 'image-1.png')}` });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.data}` } });
    expect(body.tools).toEqual([{ name: 'proton_info' }]);
  });

  it('encrypts image bytes and flags every part when U2L encryption is on', async () => {
    const { client, bodies } = makeClient(() => [cc({ content: 'x' })], true);
    await client.chatWithHistory([userTurn()]);

    const [body] = bodies();
    expect(body.lumo.request_key).toBeDefined();
    expect(body.lumo.request_id).toBeDefined();
    const message = body.messages[0];
    expect(message.encrypted).toBe(true);
    const parts = message.content as Array<ChatTextPart | ChatImagePart>;
    expect(parts[0].type).toBe('text');
    expect((parts[0] as ChatTextPart).encrypted).toBe(true);
    expect((parts[0] as ChatTextPart).text).not.toContain('lumo-image');
    const imagePart = parts[1] as ChatImagePart;
    expect(imagePart.image_url.encrypted).toBe(true);
    expect(imagePart.image_url.url.startsWith('data:application/octet-stream;base64,')).toBe(true);
    expect(imagePart.image_url.url).not.toContain(PNG.data);
  }, 30_000);

  it('keeps text-only turns as plain string content alongside image turns', async () => {
    const { client, bodies } = makeClient(() => [cc({ content: 'x' })]);
    await client.chatWithHistory([
      { role: Role.User, content: 'hello' },
      { role: Role.Assistant, content: 'hi' },
      userTurn(),
    ]);
    const [body] = bodies();
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'hi' });
    expect(Array.isArray(body.messages[2].content)).toBe(true);
  });

  it('advertises describe_image only when enabled and images are present', async () => {
    const { client, bodies } = makeClient(() => [cc({ content: 'x' })]);
    await client.chatWithHistory([userTurn()], undefined, { enableDescribeImageTool: true });
    await client.chatWithHistory([{ role: Role.User, content: 'text only' }], undefined, { enableDescribeImageTool: true });
    const [withImages, textOnly] = bodies();
    expect(withImages.tools).toEqual([{ name: 'proton_info' }, { name: 'describe_image' }]);
    expect(textOnly.tools).toEqual([{ name: 'proton_info' }]);
  });

  it('applies the most-recent-images limit over the whole history', async () => {
    const { client, bodies } = makeClient(() => [cc({ content: 'x' })]);
    await client.chatWithHistory(
      [
        { role: Role.User, content: 'first', images: [PNG] },
        { role: Role.Assistant, content: 'ok' },
        { role: Role.User, content: 'second', images: [JPEG] },
      ],
      undefined,
      { maxImagesPerRequest: 1 },
    );
    const [body] = bodies();
    expect(body.messages[0]).toEqual({ role: 'user', content: `first\n${OMITTED_IMAGE_PLACEHOLDER}` });
    const parts = body.messages[2].content as ChatImagePart[];
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(1);
  });

  it('injects instructions into an image-only first user turn', async () => {
    const { client, bodies } = makeClient(() => [cc({ content: 'x' })]);
    await client.chatWithHistory([{ role: Role.User, content: '', images: [PNG] }], undefined, {
      instructions: 'Be brief',
      injectInstructionsInto: 'first',
    });
    const [body] = bodies();
    const text = (body.messages[0].content as ChatTextPart[])[0].text;
    expect(text.startsWith('[Project instructions: Be brief]')).toBe(true);
    expect(text).toContain('<lumo-image');
  });

  it('never sends images with the title request', async () => {
    const { client, bodies } = makeClient((opts) => {
      const target = (opts.data as ChatCompletionsBody).lumo.target;
      return [cc({ content: target === 'title' ? 'Dot Picture' : 'A dot.' })];
    });
    const res = await client.chatWithHistory([userTurn()], undefined, { requestTitle: true });
    expect(res.title).toBe('Dot Picture');
    const titleBody = bodies().find((b) => b.lumo.target === 'title')!;
    expect(titleBody.messages).toEqual([{ role: 'user', content: 'What is in this picture?' }]);
  });

  it('treats a native describe_image tool call as native (no bounce)', async () => {
    const { client, api } = makeClient(() => [
      { object: 'chat.tool_call', tool_call: { id: 'c1', name: 'describe_image', arguments: '{"image_id":"x"}' } },
      { object: 'chat.tool_result', tool_result: { call_id: 'c1', content: '{"description":"a dot"}' } },
      cc({ content: 'It is a dot.' }),
    ]);
    const res = await client.chatWithHistory([userTurn()]);
    expect(api).toHaveBeenCalledTimes(1);
    expect(res.misrouted).toBe(false);
    expect(res.message.content).toBe('It is a dot.');
    expect(JSON.parse(res.message.toolCall!)).toEqual({ name: 'describe_image', arguments: { image_id: 'x' } });
  });

  it('re-prepares the original turns on a bounce without duplicating markers', async () => {
    let calls = 0;
    const { client, bodies } = makeClient(() => {
      calls++;
      return calls === 1
        ? [cc({ tool_calls: [{ index: 0, function: { name: 'my_custom_tool', arguments: '{}' } }] })]
        : [cc({ content: 'done' })];
    });
    const res = await client.chatWithHistory([userTurn()]);
    expect(res.message.content).toBe('done');
    const bounceBody = bodies()[1];
    const text = (bounceBody.messages[0].content as ChatTextPart[])[0].text;
    expect(text.match(/<lumo-image/g)).toHaveLength(1);
  });
});

describe('LumoClient with images: edge cases', () => {
  it('skips the title request while the conversation has no text', async () => {
    const { client, api } = makeClient(() => [cc({ content: 'A dot.' })]);
    const res = await client.chatWithHistory([{ role: Role.User, content: '', images: [PNG] }], undefined, {
      requestTitle: true,
    });
    expect(api).toHaveBeenCalledTimes(1);
    expect(res.title).toBeUndefined();
    expect(res.message.content).toBe('A dot.');
  });

  it('does not advertise describe_image when the limit drops every image', async () => {
    const { client, bodies } = makeClient(() => [cc({ content: 'x' })]);
    await client.chatWithHistory([{ role: Role.User, content: 'look', images: [PNG] }], undefined, {
      enableDescribeImageTool: true,
      maxImagesPerRequest: 0,
    });
    const [body] = bodies();
    expect(body.tools).toEqual([{ name: 'proton_info' }]);
    expect(body.messages[0]).toEqual({ role: 'user', content: `look\n${OMITTED_IMAGE_PLACEHOLDER}` });
  });
});
