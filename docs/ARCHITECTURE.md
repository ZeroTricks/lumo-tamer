# Two-Service Architecture

## Overview

```
┌─────────────────┐    CDP/WS      ┌──────────────────┐
│  App Service    │ ◄────────────► │  Browser Service │
│  (Node + API)   │  ws://browser  │  (Chromium+CDP)  │
│  ~50MB          │     :9222      │  ~400MB          │
└─────────────────┘                └──────────────────┘
```

**Why split?**
- Fast rebuilds: 30s vs 3-5min
- Hot reload without browser restart
- Swap browsers easily
- Better layer caching

## How It Works

1. App reads `browser.cdpEndpoint` from config.yaml
2. Playwright connects via `chromium.connectOverCDP()`
3. Browser persists independently of app lifecycle

**IMPORTANT**: `browser.cdpEndpoint` is required. No bundled browser.

## Docker Setup

```yaml
# docker-compose.yml
services:
  browser-dev:
    image: lscr.io/linuxserver/chromium
    environment:
      - CHROME_CLI=--remote-debugging-address=0.0.0.0 --remote-debugging-port=9222
    volumes:
      - ./browser-data:/config  # Persistent profile
    ports:
      - "3001:3001"  # noVNC web GUI

  app-dev:
    build:
      dockerfile: Dockerfile.app
      target: development
    volumes:
      - ./config.yaml:/app/config.yaml:ro  # Configuration
      - ./src:/app/src:rw  # Hot reload
    depends_on:
      - browser-dev
```

## Commands

```bash
make dev-build     # Dev with hot reload
make prod-build    # Production build
make logs-app      # App logs
make logs-browser  # Browser logs
```

## File Structure

```
├── Dockerfile.app        # App image (no browser)
├── Dockerfile.browser    # Browser service
├── docker-compose.yml    # Multi-service config
├── src/browser/manager.ts  # CDP connection
└── browser-data/         # Browser persistence
```

## Configuration

```yaml
# config.yaml
browser:
  cdpEndpoint: "http://browser-dev:9223"  # REQUIRED
```

## Before vs After

| | Monolithic | Two-Service |
|-|------------|-------------|
| Build time | 3-5 min | 30 sec (app) |
| Image size | ~800MB | ~50MB (app) |
| Hot reload | Restarts browser | Browser persists |
| Browser swap | Rebuild everything | Change image |

## Local Dev (Non-Docker)

Run browser separately:

```bash
docker run -d -p 9222:9222 \
  -e CHROME_CLI="--remote-debugging-address=0.0.0.0 --remote-debugging-port=9222" \
  lscr.io/linuxserver/chromium

# In config.yaml, set:
# browser:
#   cdpEndpoint: "ws://localhost:9222"
npm run dev
```

## Advanced

### Custom Browser

```yaml
browser:
  image: browserless/chrome
```

### External Service (Selkie, etc.)

```yaml
# config.yaml
browser:
  cdpEndpoint: "ws://your-service.com/browser-id"
```

## Troubleshooting

**Connection refused**: Browser not ready. Check `make logs-browser`

**State not persisting**: Verify `./browser-data:/config` volume mount

**Hot reload broken**: Check `./src:/app/src:rw` mount exists

**No noVNC**: Ensure port 3001 exposed and `CUSTOM_HTTP_PORT=3001` set
