/**
 * E2E test: OpenAI JS SDK vision-style requests against the test server.
 *
 * Validates that the multimodal shapes produced by the official SDK (the same
 * ones Frigate and other vision clients send) are accepted on both endpoints.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import OpenAI from 'openai';
import { createTestServer, type TestServer } from '../helpers/test-server.js';
import { JPEG_DATA_URL, PNG_DATA_URL } from '../helpers/images.js';

let ts: TestServer;
let client: OpenAI;

beforeAll(async () => {
  ts = await createTestServer('imageInput');
  client = new OpenAI({ baseURL: `${ts.baseUrl}/v1`, apiKey: 'test-key' });
});

afterAll(async () => {
  await ts.close();
});

describe('OpenAI SDK - image input', () => {
  it('chat.completions.create with image_url parts', async () => {
    const completion = await client.chat.completions.create({
      model: 'lumo',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: JPEG_DATA_URL, detail: 'low' } },
            { type: 'image_url', image_url: { url: PNG_DATA_URL, detail: 'low' } },
            { type: 'text', text: 'Describe what happened in these frames.' },
          ],
        },
      ],
    });
    expect(completion.choices[0].message.content).toBe(
      '(Mocked) I received 2 image(s) [image/jpeg, image/png] with 2 marker(s).',
    );
  });

  it('chat.completions.create streaming with an image', async () => {
    const stream = await client.chat.completions.create({
      model: 'lumo',
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: PNG_DATA_URL } }] }],
    });
    let text = '';
    for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? '';
    expect(text).toBe('(Mocked) I received 1 image(s) [image/png] with 1 marker(s).');
  });

  it('responses.create with input_image parts', async () => {
    const response = await client.responses.create({
      model: 'lumo',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'What is in this picture?' },
            { type: 'input_image', image_url: PNG_DATA_URL, detail: 'auto' },
          ],
        },
      ],
    });
    expect(response.output_text).toBe('(Mocked) I received 1 image(s) [image/png] with 1 marker(s).');
  });
});
