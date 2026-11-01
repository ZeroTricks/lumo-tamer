# Image Input (Vision)

lumo-tamer accepts images in OpenAI-compatible requests and forwards them to Lumo as native multimodal input, so vision-capable clients (Frigate, Open WebUI, the OpenAI SDKs, ...) can ask Lumo about pictures.

This is image *understanding* only. Image generation (`generate_image`) is not supported.

## Request formats

Images go in user messages as content parts. Both endpoints accept base64 data URLs; `http(s)` URLs are optional (see [Remote URLs](#remote-urls)).

`POST /v1/chat/completions`:

```json
{
  "model": "lumo",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What is happening in this picture?" },
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,/9j/4AAQ...", "detail": "low" } }
      ]
    }
  ]
}
```

`POST /v1/responses`:

```json
{
  "model": "lumo",
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "What is happening in this picture?" },
        { "type": "input_image", "image_url": "data:image/jpeg;base64,/9j/4AAQ..." }
      ]
    }
  ]
}
```

Notes:
- Several images per message and images in several messages (conversation history) are supported.
- `detail` is accepted and ignored.
- `image_url` may also be a plain string, and `input_image.image_url` may be an object with `url`; both forms are common in OpenAI-compatible clients.
- `file_id` sources are rejected (no file store).
- Responses API `function_call_output` items whose `output` is an array may carry `input_image` items; they are handled like images in user messages (numbering, limits, remote URLs).
- Image parts on `assistant` or `system` messages are ignored.

With cURL:

```bash
IMG=$(base64 -w0 photo.jpg)
curl http://localhost:3003/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d "{\"model\":\"lumo\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Describe this image\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/jpeg;base64,$IMG\"}}]}]}"
```

## Supported formats and limits

| | |
|---|---|
| Formats | JPEG, PNG, GIF, WebP, HEIC/HEIF (same set as Lumo's web client). Detected from the image bytes; the declared media type is ignored. |
| Size | `server.images.maxImageSize` per image (default 4mb, decoded). Lumo's web client downsizes uploads to about 1920px / 1MB JPEG, so larger images bring no benefit. |
| Count | `server.images.maxImagesPerRequest` (default 10), counted over the whole request including history. Older images beyond the limit are dropped and replaced by `[[Image omitted to save context size]]`, like the web client does; the request still succeeds. |
| Body size | `server.bodyLimit` (default 6mb) must fit all base64 payloads (about 1.37x the image size). A too-large body returns HTTP 413. |

Invalid requests return an OpenAI-style HTTP 400 (`type: invalid_request_error`) with one of these `code` values: `unsupported_image_format`, `invalid_image_data`, `image_too_large`, `remote_image_not_allowed`, `image_fetch_failed`, `too_many_images` (remote URLs only, see [Remote URLs](#remote-urls)), `unsupported_image_source`, `image_input_disabled`. Nothing is persisted when a request is rejected.

Messages that contain only images get a placeholder text (`[Image: image-1.jpg]`) so the stored conversation is never blank. Images are numbered across the whole request.

## Configuration

```yaml
server:
  images:
    enabled: true                # false: reject requests with images (HTTP 400)
    maxImageSize: "4mb"
    maxImagesPerRequest: 10
    allowRemoteUrls: false       # download http(s) image URLs server-side
    enableDescribeImageTool: false
  bodyLimit: "6mb"
```

### Remote URLs

With `allowRemoteUrls: true`, `http(s)` image URLs in user messages and tool outputs are downloaded by lumo-tamer (at most `maxImagesPerRequest` per request across both, concurrently, 15s timeout each, `maxImageSize` cap, redirects followed) and sent on as data URLs. This lets any client holding the API key make lumo-tamer fetch arbitrary URLs, including hosts on your local network, so it is off by default.

The download cap is separate from the context limit above: a request with more remote URLs than `maxImagesPerRequest` is rejected with `too_many_images` before anything is fetched. Data-URL images never trigger this code.

### describe_image tool

Lumo's web client advertises the native `describe_image` tool whenever image tools are enabled. lumo-tamer sends images as multimodal content, which the model reads directly. If image-aware answers are poor on your plan or model tier, try `enableDescribeImageTool: true`; the tool call is then handled by Lumo server-side, like web search.

## How it works

Images use the same protocol as Lumo's web client (`applications/lumo/src/app/llm/index.ts` and `packages/lumo-api-client/core/chat-completions.ts` upstream):

1. Each image gets a stable id (derived from its content) and a `<lumo-image id="..." source="user" name="image-1.jpg" />` marker appended to the message text. The marker is the model's handle on the image.
2. With U2L encryption on (the default), the image bytes are encrypted with the per-request AES-GCM key and the request's associated data, exactly like the text. The wire message becomes an OpenAI content-parts array: a `text` part and one `image_url` part per image (`data:application/octet-stream;base64,<ciphertext>` with `encrypted: true`).
3. Title generation never sees images; the title request is text-only.

Relevant code: `src/api/images.ts` (decoding and validation), `src/api/message-converter.ts` (content parts to turns), `src/lumo-client/images.ts` (markers and limits), `src/lumo-client/v2-body.ts` (wire format).

## Limitations

- Images are not persisted or synced: conversation storage keeps the message text only. Lumo sees exactly the messages of the current request, so clients keep image context by resending the full history (the OpenAI convention).
- No resizing. Send images at a sensible resolution; see the limits above.
- `detail` has no effect; `response_format` (JSON schema output) is not forwarded.
- Image generation and editing tools are not exposed.
- The CLI has no image support yet.
- Availability of vision depends on your Proton plan and model tier.

## Frigate

Frigate's Generative AI features (object and review descriptions, camera-aware chat) use the OpenAI provider with images as JPEG data URLs, which works out of the box:

```yaml
genai:
  provider: openai
  base_url: http://yourhost:3003/v1
  api_key: your-secret-api-key-here
  model: lumo
```

Frigate sends several frames per description (3 to 5 JPEG images of a few hundred KB each). The defaults (`bodyLimit: 6mb`, `maxImageSize: 4mb`) cover this; raise `server.bodyLimit` if you configure more frames or larger snapshots.

Review descriptions ask for JSON output and pass a `response_format`, which lumo-tamer ignores. Lumo usually follows the JSON instruction in the prompt; Frigate strips code fences before parsing.
