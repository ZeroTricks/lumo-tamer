# lumo-tamer

Use Proton's Lumo AI through an OpenAI-compatible API and CLI.

## Features

- OpenAI-compatible API (`/v1/chat/completions`, `/v1/responses`)
- Interactive CLI mode
- Conversation sync with Proton's Lumo WebClient
- Multiple authentication methods

## Quick Start

### 1. Install dependencies

```bash
git clone https://github.com/ZeroTricks/lumo-tamer.git
cd lumo-tamer
npm install
```

### 2. Build

```bash
npm run build
```

**Optional:** Build Go binary for SRP login authentication:

```bash
# Requires Go 1.24+
cd src/auth/login/go && go build -o ../../../../dist/proton-auth && cd -
```

### 3. Configure

```bash
cp config.example.yaml config.yaml
# Edit config.yaml if needed (defaults work for most setups)
```

### 4. Authenticate

```bash
npm run auth
```

Choose one of three methods:

- **browser** - Extract tokens from a logged-in browser session (recommended)
- **login** - Enter Proton credentials (requires Go binary from step 2)
- **manual** - Paste tokens directly

### 5. Run

```bash
# Interactive CLI
npm run cli

# Or start the API server
npm run server
```

## Usage

### CLI

```bash
npm run cli -- "Hello!"

# Or install globally
npm link
tamer "What is 2+2?"
```

### API

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3003/v1",
    api_key="your-api-key"
)

response = client.chat.completions.create(
    model="lumo",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)
```

### Docker

```bash
# Setup: create vault encryption key
mkdir -p secrets && chmod 700 secrets
openssl rand -base64 32 > secrets/lumo-vault-key
chmod 600 secrets/lumo-vault-key

# Authenticate (interactive)
docker compose run --rm -it app tamer-auth

# Run
docker compose up app                        # API server
docker compose run --rm app tamer "Hello!"   # CLI
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI chat completions |
| `POST /v1/responses` | OpenAI responses API |
| `GET /v1/models` | List available models |
| `GET /health` | Health check |

## Documentation

See [docs/](docs/) for detailed documentation.

## License

GPLv3 - See [LICENSE](LICENSE). Includes code from [Proton WebClients](https://github.com/ProtonMail/WebClients).
