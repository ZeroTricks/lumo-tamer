/**
 * Integration tests for image input on /v1/chat/completions and /v1/responses.
 *
 * The `imageInput` mock scenario echoes what reached the (mock) Lumo transport,
 * so these tests cover the whole path: HTTP request -> content-part decoding ->
 * turns -> LumoClient (markers, limits) -> chat/completions wire body.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestServer, parseSSEEvents, type TestServer } from '../helpers/test-server.js';
import { getImagesConfig } from '../../src/app/config.js';
import { JPEG_DATA_URL, PNG_DATA_URL, BMP_BYTES, PNG_BYTES, dataUrl, imageUrlPart, inputImagePart } from '../helpers/images.js';

function postChat(ts: TestServer, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ts.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postResponses(ts: TestServer, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ts.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const visionMessage = (text: string, ...urls: string[]) => ({
  role: 'user',
  content: [...urls.map((u) => imageUrlPart(u)), { type: 'text', text }],
});

let ts: TestServer;
const originalConfig = { ...getImagesConfig() };

// A fresh server per test: the mock transport caps calls per instance.
beforeEach(async () => {
  ts = await createTestServer('imageInput');
});

afterEach(async () => {
  await ts.close();
  Object.assign(getImagesConfig(), originalConfig);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/v1/chat/completions with images', () => {
  it('text-only requests still work and carry no images', async () => {
    const res = await postChat(ts, { model: 'lumo', messages: [{ role: 'user', content: 'Hello' }], stream: false });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('(Mocked) I received no images.');
  });

  it('forwards a single image with text (Frigate request shape)', async () => {
    const res = await postChat(ts, {
      model: 'lumo',
      messages: [visionMessage('Describe the scene.', JPEG_DATA_URL)],
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('(Mocked) I received 1 image(s) [image/jpeg] with 1 marker(s).');
  });

  it('forwards multiple images in one message', async () => {
    const res = await postChat(ts, {
      model: 'lumo',
      messages: [visionMessage('Compare these frames.', JPEG_DATA_URL, PNG_DATA_URL, JPEG_DATA_URL)],
      stream: false,
    });
    const body = await res.json();
    expect(body.choices[0].message.content).toBe(
      '(Mocked) I received 3 image(s) [image/jpeg, image/png, image/jpeg] with 3 marker(s).',
    );
  });

  it('streams responses for image requests', async () => {
    const res = await postChat(ts, {
      model: 'lumo',
      messages: [visionMessage('Describe', PNG_DATA_URL)],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const events = parseSSEEvents(await res.text());
    const text = events
      .filter((e) => typeof e.data === 'object')
      .map((e) => (e.data as any).choices?.[0]?.delta?.content ?? '')
      .join('');
    expect(text).toBe('(Mocked) I received 1 image(s) [image/png] with 1 marker(s).');
  });

  it('keeps image context across turns and applies the most-recent-images limit', async () => {
    const history = [
      visionMessage('First frame', JPEG_DATA_URL),
      { role: 'assistant', content: 'A person at the door.' },
      visionMessage('Second frame', PNG_DATA_URL),
    ];
    const chat = vi.spyOn(ts.deps.lumoClient, 'chatWithHistory');

    let res = await postChat(ts, { model: 'lumo', messages: history, stream: false });
    expect((await res.json()).choices[0].message.content).toBe(
      '(Mocked) I received 2 image(s) [image/jpeg, image/png] with 2 marker(s).',
    );
    const turns = chat.mock.calls[0][0];
    expect(turns.map((t) => t.images?.length ?? 0)).toEqual([1, 0, 1]);
    expect(chat.mock.calls[0][2]?.maxImagesPerRequest).toBe(originalConfig.maxImagesPerRequest);

    Object.assign(getImagesConfig(), { maxImagesPerRequest: 1 });
    res = await postChat(ts, { model: 'lumo', messages: history, stream: false });
    expect((await res.json()).choices[0].message.content).toBe(
      '(Mocked) I received 1 image(s) [image/png] with 1 marker(s).',
    );
  });

  it('persists only the text of image messages for stateful conversations', async () => {
    const { deriveIdFromUser } = (await import('../../src/app/config.js')).getConversationsConfig();
    const conversationsConfig = (await import('../../src/app/config.js')).getConversationsConfig();
    Object.assign(conversationsConfig, { deriveIdFromUser: true });
    try {
      const res = await postChat(ts, {
        model: 'lumo',
        user: 'image-session',
        messages: [visionMessage('What is this?', PNG_DATA_URL)],
        stream: false,
      });
      expect(res.status).toBe(200);
      const [, state] = [...ts.store.entries()].find(([, s]) => s.messages.some((m) => m.content === 'What is this?'))!;
      const stored = state.messages.find((m) => m.role === 'user')!;
      expect(stored.content).toBe('What is this?');
      expect((stored as Record<string, unknown>).images).toBeUndefined();

      // An image-only message is stored with a placeholder, never blank
      const imageOnly = await postChat(ts, {
        model: 'lumo',
        user: 'image-only-session',
        messages: [{ role: 'user', content: [imageUrlPart(PNG_DATA_URL)] }],
        stream: false,
      });
      expect(imageOnly.status).toBe(200);
      const [, state2] = [...ts.store.entries()].find(([, s]) => s.messages.some((m) => m.content === '[Image: image-1.png]'))!;
      expect(state2.messages[0].role).toBe('user');
    } finally {
      Object.assign(conversationsConfig, { deriveIdFromUser });
    }
  });

  describe('errors', () => {
    it('rejects unsupported image formats with a 400', async () => {
      const res = await postChat(ts, {
        model: 'lumo',
        messages: [visionMessage('x', dataUrl(BMP_BYTES, 'image/bmp'))],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.code).toBe('unsupported_image_format');
      expect(body.error.param).toBe('messages');
    });

    it('rejects malformed image data', async () => {
      const res = await postChat(ts, {
        model: 'lumo',
        messages: [visionMessage('x', 'data:image/png;base64,%%%not-base64%%%')],
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_image_data');
    });

    it('rejects oversized images', async () => {
      Object.assign(getImagesConfig(), { maxImageSize: 16 });
      const res = await postChat(ts, { model: 'lumo', messages: [visionMessage('x', JPEG_DATA_URL)] });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('image_too_large');
      expect(body.error.message).toContain('server.images.maxImageSize');
    });

    it('rejects remote URLs unless allowRemoteUrls is enabled', async () => {
      const res = await postChat(ts, {
        model: 'lumo',
        messages: [visionMessage('x', 'https://example.com/cat.jpg')],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('remote_image_not_allowed');
      expect(body.error.message).toContain('allowRemoteUrls');
    });

    it('rejects all images when image input is disabled', async () => {
      Object.assign(getImagesConfig(), { enabled: false });
      const res = await postChat(ts, { model: 'lumo', messages: [visionMessage('x', PNG_DATA_URL)] });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('image_input_disabled');
      // text-only still works
      const ok = await postChat(ts, { model: 'lumo', messages: [{ role: 'user', content: 'hi' }] });
      expect(ok.status).toBe(200);
    });

    it('does not persist anything when the image is invalid', async () => {
      const conversationsConfig = (await import('../../src/app/config.js')).getConversationsConfig();
      const { deriveIdFromUser } = conversationsConfig;
      Object.assign(conversationsConfig, { deriveIdFromUser: true });
      try {
        const before = ts.store.getStats().total;
        const res = await postChat(ts, {
          model: 'lumo',
          user: 'bad-image-session',
          messages: [visionMessage('x', dataUrl(BMP_BYTES))],
        });
        expect(res.status).toBe(400);
        expect(ts.store.getStats().total).toBe(before);
      } finally {
        Object.assign(conversationsConfig, { deriveIdFromUser });
      }
    });
  });
});

describe('/v1/responses with images', () => {
  it('forwards input_image parts', async () => {
    const res = await postResponses(ts, {
      model: 'lumo',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'What do you see?' }, inputImagePart(PNG_DATA_URL)] }],
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('completed');
    const message = body.output.find((o: any) => o.type === 'message');
    expect(message.content[0].text).toBe('(Mocked) I received 1 image(s) [image/png] with 1 marker(s).');
  });

  it('forwards images through streaming responses', async () => {
    const res = await postResponses(ts, {
      model: 'lumo',
      input: [{ role: 'user', content: [inputImagePart(JPEG_DATA_URL), { type: 'input_text', text: 'Go' }] }],
      stream: true,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const events = parseSSEEvents(await res.text());
    const done = events.find((e) => e.event === 'response.output_text.done');
    expect((done?.data as any).text).toBe('(Mocked) I received 1 image(s) [image/jpeg] with 1 marker(s).');
  });

  it('keeps images from earlier turns of the input array', async () => {
    const res = await postResponses(ts, {
      model: 'lumo',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Frame 1' }, inputImagePart(JPEG_DATA_URL)] },
        { role: 'assistant', content: 'Nothing unusual.' },
        { role: 'user', content: [{ type: 'input_text', text: 'Frame 2' }, inputImagePart(PNG_DATA_URL)] },
      ],
      stream: false,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();
    const message = body.output.find((o: any) => o.type === 'message');
    expect(message.content[0].text).toBe('(Mocked) I received 2 image(s) [image/jpeg, image/png] with 2 marker(s).');
  });

  it('downloads remote images in function_call_output items and counts them toward the cap', async () => {
    Object.assign(getImagesConfig(), { allowRemoteUrls: true });
    // The test client shares the global fetch with the server: only intercept the camera URL.
    const realFetch = globalThis.fetch;
    const cameraFetch = vi.fn(async () => new Response(new Uint8Array(PNG_BYTES), { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) =>
      String(url).startsWith('https://camera.local/') ? cameraFetch() : realFetch(url, init));

    const input = [
      { role: 'user', content: [{ type: 'input_text', text: 'Compare with this' }, inputImagePart(JPEG_DATA_URL)] },
      { type: 'function_call', call_id: 'call_snap', name: 'camera_snapshot', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_snap', output: [
        { type: 'input_text', text: 'Snapshot taken' },
        inputImagePart('https://camera.local/snap.png'),
      ] },
    ];

    const res = await postResponses(ts, { model: 'lumo', input, stream: false });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(cameraFetch).toHaveBeenCalledTimes(1);
    const message = (await res.json()).output.find((o: any) => o.type === 'message');
    expect(message.content[0].text).toBe('(Mocked) I received 2 image(s) [image/jpeg, image/png] with 2 marker(s).');

    // Two remote images (user message + tool output) exceed a cap of 1
    Object.assign(getImagesConfig(), { maxImagesPerRequest: 1 });
    input[0] = { role: 'user', content: [inputImagePart('https://camera.local/ref.png')] };
    const capped = await postResponses(ts, { model: 'lumo', input });
    expect(capped.status).toBe(400);
    expect((await capped.json()).error.code).toBe('too_many_images');
    expect(cameraFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects file_id image sources with a 400', async () => {
    const res = await postResponses(ts, {
      model: 'lumo',
      input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file-123' }] }],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('unsupported_image_source');
    expect(body.error.param).toBe('input');
  });
});
