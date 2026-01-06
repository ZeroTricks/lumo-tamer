# Quick Start Reference

## Container Development (Recommended)

### Using Make (Easiest)
```bash
# Start development container
make dev-build

# View logs
make logs

# Open shell in container
make shell

# Stop container
make dev-down

# Enable X11 (Linux only, for browser display)
make x11-enable
```

### Using npm scripts
```bash
# Start development container
npm run docker:dev:build

# View logs
npm run docker:logs

# Open shell
npm run docker:shell

# Stop
npm run docker:dev:down
```

## Local Development

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env with your chatbox URL and selectors

# Run locally
npm run dev
```

## First Time Setup

1. **Configure chatbox URL and selectors in `.env`:**
```bash
# Copy the example file
cp .env.example .env

# Edit .env with your chatbox URL and appropriate DOM selectors
# Use browser DevTools to find the correct selectors for your chatbox
```

2. **Start the app** (container or local)

3. **Test the API:**
```bash
curl http://localhost:${PORT}/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "model": "chatbox-default",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Common Commands

```bash
# View all available commands
make help

# Clear saved sessions
make clean-sessions
# or
rm -rf sessions/*

# Rebuild everything
make dev-build

# Production deployment
make prod-build
make prod-up
```

## X11 Setup (for browser display)

**Linux:**
```bash
make x11-enable  # or: xhost +local:docker
make dev-build
```

**macOS:**
```bash
brew install --cask xquartz
# Start XQuartz, enable "Allow connections from network clients"
export DISPLAY=$(ipconfig getifaddr en0):0
xhost + $(ipconfig getifaddr en0)
make dev-build
```

**Windows WSL2:**
```bash
export DISPLAY=$(cat /etc/resolv.conf | grep nameserver | awk '{print $2}'):0
# Install VcXsrv on Windows, start with "Disable access control"
make dev-build
```

## File Locations

```
.env                  # Your configuration
src/                  # Source code (edit here!)
sessions/            # Saved login sessions
docker-compose.dev.yml  # Dev container config
Dockerfile.dev       # Dev container image
```

## Getting Help

- Full documentation: [README.md](README.md)
- Development guide: [DEVELOPMENT.md](DEVELOPMENT.md)
- All commands: `make help`
