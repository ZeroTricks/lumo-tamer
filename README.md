# Lumo Bridge

OpenAI-compatible API bridge for web-based chatboxes using Playwright. Expose any web chatbox as an OpenAI-compatible API endpoint.

## Features

- **OpenAI-Compatible API**: Drop-in replacement for OpenAI's chat completions endpoint
- **Playwright-Powered**: Reliable browser automation with built-in UI mode for easy login
- **Session Persistence**: Login once, credentials saved across restarts
- **Streaming Support**: Real-time response streaming via Server-Sent Events (SSE)
- **Queue Management**: Handles concurrent requests with proper serialization
- **Docker Ready**: Full containerization support with docker-compose
- **Hot Reload Development**: Develop in containers with live code updates via volume mounts

## Quick Start

> **💡 For development workflow, see [DEVELOPMENT.md](DEVELOPMENT.md)**

### Prerequisites

- Node.js 20+ (or Docker)
- A web-based chatbox you want to bridge

### Installation

1. Clone and install dependencies:
```bash
git clone <your-repo>
cd lumo-bridge
npm install
```

2. Configure environment:
```bash
cp .env.example .env
```

Edit `.env` with your configuration:
```bash
# See .env.example for all available settings
# Most importantly, configure:
# - CHATBOX_URL: Your target chatbox URL
# - API_KEY: Your secret API key
# - SELECTOR_*: DOM selectors (use browser DevTools to find these)
```

3. Start the bridge:
```bash
npm run dev
```

### First Run

The browser will open and navigate to your configured chatbox URL. Session state is automatically persisted to the `sessions/` directory.

### Using the API

Once logged in, the API is ready at `http://localhost:3000/v1/chat/completions`

**Python Example:**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="your-secret-api-key-here"
)

response = client.chat.completions.create(
    model="your-model-name",  # Use the MODEL_NAME from your .env
    messages=[
        {"role": "user", "content": "Hello!"}
    ],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

**cURL Example:**
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-api-key-here" \
  -d '{
    "model": "your-model-name",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

## Docker Deployment

### Build and Run

```bash
# Build
docker-compose build

# Run
docker-compose up -d

# View logs
docker-compose logs -f
```

### Login with Docker

For login with Docker, you'll need X11 forwarding:

**Linux:**
```bash
# Allow X11 connections
xhost +local:docker

# Run with display
docker-compose up
```

**macOS:**
```bash
# Install XQuartz first
brew install --cask xquartz

# Start XQuartz and enable "Allow connections from network clients"
# Then:
xhost +localhost
docker-compose up
```

**Alternative**: Run initial login locally, then copy `sessions/` directory to Docker volume.

## Customizing for Your Chatbox

The most important step is configuring the DOM selectors for your target chatbox:

### Finding the Right Selectors

1. Open your chatbox in Chrome DevTools
2. Right-click the message input → Inspect
3. Note the selector (ID, class, or element path)
4. Repeat for send button and message containers

### Tips for Finding Selectors

1. Use unique IDs when available (e.g., `#message-input`)
2. Use stable class names (avoid dynamic/generated classes)
3. Use attribute selectors for reliable targeting (e.g., `button[type="submit"]`)
4. Test selectors in browser console: `document.querySelector('your-selector')`
5. For the last message, use `:last-child` pseudo-selector on the message container

### Advanced Customization

For complex chatboxes, you may need to modify the code in [src/browser/chatbox.ts](src/browser/chatbox.ts):

- `sendMessage()`: Customize how messages are sent
- `waitForResponse()`: Adjust response detection logic
- `streamResponse()`: Modify streaming behavior

## API Endpoints

### POST `/v1/chat/completions`

OpenAI-compatible chat completions endpoint.

**Request:**
```json
{
  "model": "your-model-name",
  "messages": [
    {"role": "user", "content": "Hello!"}
  ],
  "stream": false
}
```

**Response (non-streaming):**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "your-model-name",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hi there!"
    },
    "finish_reason": "stop"
  }]
}
```

### GET `/v1/models`

List available models.

### GET `/login/status`

Check login status and page information.

### GET `/health`

Health check with queue statistics.

## Architecture

```
┌─────────────────┐
│  OpenAI Client  │
└────────┬────────┘
         │ HTTP/SSE
         ▼
┌─────────────────┐
│   API Server    │  (Express)
│   Port 3000     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Request Queue   │  (Serializes requests)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Playwright    │
│  Browser Mgr    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Web Chatbox    │  (Target site)
└─────────────────┘
```

## Troubleshooting

### Browser not opening
- Ensure `HEADLESS=false` in `.env`
- Check Playwright installation: `npx playwright install chromium`

### Login not detected
- Adjust the login detection logic in `BrowserManager.pauseForLogin()`
- Customize based on your chatbox's DOM structure

### Selectors not working
- Use browser DevTools to verify selectors
- Try more specific selectors (combine classes/attributes)
- Check for dynamic IDs or shadow DOM

### Response timeout
- Increase timeout in `chatbox.waitForResponse()` or `chatbox.streamResponse()`
- Check if response selector matches actual message elements
- Verify messages are appearing in the DOM

### Docker display issues
- Ensure X11 forwarding is properly configured
- Try running locally first to isolate Docker-specific issues
- Consider using VNC for remote deployments

## Development

```bash
# Development mode with auto-reload
npm run dev

# Build TypeScript
npm run build

# Production mode
npm start

# Clean build artifacts
npm run clean
```

## Security Considerations

- **API Key**: Change the default API key in production
- **Network**: Don't expose port 3000 to the internet without additional security
- **Rate Limiting**: Consider adding rate limiting for production use
- **Secrets**: Never commit `.env` or `sessions/` directory

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.

## Disclaimer

This tool is for educational and personal use. Ensure you comply with the terms of service of any chatbox you're bridging. Some services may prohibit automated access.
