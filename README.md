# Lumo Bridge

OpenAI-compatible API for web chatboxes using Playwright automation.

## Quick Start

```bash
# Setup
cp .env.example .env  # Edit with your chatbox URL and selectors
npm install
npm run dev

# Or with Docker
make dev-build        # Browser GUI at http://localhost:3001
```

**API Usage:**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="your-api-key"
)

response = client.chat.completions.create(
    model="your-model-name",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)
```

## Docker

```bash
make dev-build  # Start with hot reload
make logs       # Watch logs
make prod-up    # Production mode
```

Browser GUI: http://localhost:3001 (noVNC)

See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for all commands.

## Configuration

**Find DOM selectors** using DevTools:
1. Right-click element → Inspect
2. Test in console: `document.querySelector('your-selector')`
3. Add to `.env` file

For complex sites, modify [src/browser/chatbox.ts](src/browser/chatbox.ts).

## Endpoints

- `POST /v1/chat/completions` - OpenAI-compatible chat (streaming/non-streaming)
- `GET /v1/models` - List models
- `GET /health` - Health check
- `GET /login/status` - Login status

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design.

## Troubleshooting

- **Selectors not working**: Verify in DevTools, check for dynamic IDs/shadow DOM
- **Response timeout**: Increase timeout in [src/browser/chatbox.ts](src/browser/chatbox.ts)
- **Browser not connecting**: Check `CDP_ENDPOINT` in `.env`, verify port 9222

See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for development workflow.

## Docs

- [DEVELOPMENT.md](docs/DEVELOPMENT.md) - Dev workflow & commands
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) - Two-service design
- [CLAUDE.md](docs/CLAUDE.md) - Project overview for AI

## License

MIT - Educational/personal use. Respect target site ToS.
