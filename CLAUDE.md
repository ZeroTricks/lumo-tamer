# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Lumo Bridge** is an OpenAI-compatible API bridge for web-based chatboxes using Playwright. It translates OpenAI API requests into browser DOM interactions, allowing any web chatbox to be exposed as an OpenAI-compatible endpoint (`/v1/chat/completions`).

## Core Architecture

### Request Flow

```
OpenAI Client → Express API Server → Request Queue → Playwright Browser → Web Chatbox
                                    (serialization)     (DOM automation)
```

1. **API Server** ([src/api/server.ts](src/api/server.ts)) - Express server implementing OpenAI-compatible endpoints
2. **Request Queue** ([src/queue/manager.ts](src/queue/manager.ts)) - p-queue wrapper ensuring serial message processing
3. **Browser Manager** ([src/browser/manager.ts](src/browser/manager.ts)) - Playwright lifecycle, session persistence, login flow
4. **Chatbox Interactor** ([src/browser/chatbox.ts](src/browser/chatbox.ts)) - DOM manipulation layer using configurable selectors

### Key Architectural Decisions

**Session Persistence**: Uses Playwright's `storageState()` API to save/restore browser state to `sessions/state.json`. The `BrowserManager.pauseForLogin()` method uses `page.pause()` to open Playwright Inspector for interactive login, then saves the session automatically.

**Message Serialization**: The queue ensures only one message is processed at a time to prevent race conditions in the web UI. This is critical since most chatboxes don't handle concurrent messages.

**Streaming**: For `stream: true` requests, [src/browser/chatbox.ts](src/browser/chatbox.ts) implements `streamResponse()` which monitors DOM mutations to yield incremental content deltas as the chatbox renders the response.

## Configuration

All configuration is environment-based via `.env`

Configuration is loaded in [src/config.ts](src/config.ts) and exported as:
- `serverConfig` - Port, API key, and model name
- `browserConfig` - URL, headless mode, session directory
- `chatboxSelectors` - DOM selectors for chatbox interaction

## Development Commands

### Local Development (Non-Containerized)
```bash
npm install              # Install dependencies
npm run dev              # Run with hot reload (tsx watch)
npm run dev:debug        # Run with debugger on port 9229
npm run build            # Compile TypeScript to dist/
npm start                # Run compiled production build
```

### Container Development (Preferred)
```bash
make dev-build           # Build and start dev container with hot reload
make logs                # Follow container logs
make shell               # Exec into running container
make dev-down            # Stop development container
make x11-enable          # Enable X11 forwarding for headed browser (Linux)
```

The development container mounts `./src` as a read-write volume for hot reload. Changes to source files trigger automatic restart via `tsx watch`.

### Production
```bash
make prod-build          # Build production container
make prod-up             # Start production container (detached)
make prod-logs           # View production logs
```

## Docker Multi-Stage Build

The [Dockerfile](Dockerfile) uses a unified multi-stage approach:

```dockerfile
base (node:20-slim + Playwright deps)
  ├─→ builder (compile TypeScript)
  │     └─→ production (copy dist/, prod deps only)
  └─→ development (all deps, tsx watch, dev tools)
```

Compose files specify build target:
- [docker-compose.yml](docker-compose.yml): `target: production`
- [docker-compose.dev.yml](docker-compose.dev.yml): `target: development`

## Critical Implementation Details

### Login Flow
The entry point ([src/index.ts](src/index.ts)) checks login status on startup:
1. Calls `chatbox.isLoggedIn()` (customizable detection logic)
2. If not logged in, calls `browserManager.pauseForLogin()`
3. `pauseForLogin()` uses Playwright Inspector (`page.pause()`) for interactive login
4. After resume, session is saved to `sessions/state.json`

### Selector Customization
To adapt to different chatboxes, modify selectors in `.env`. For complex cases requiring logic changes:
- **Login detection**: [src/browser/chatbox.ts](src/browser/chatbox.ts) - `isLoggedIn()` method
- **Message sending**: [src/browser/chatbox.ts](src/browser/chatbox.ts) - `sendMessage()` method
- **Response detection**: [src/browser/chatbox.ts](src/browser/chatbox.ts) - `waitForResponse()` and `streamResponse()` methods

### X11 Display Configuration
For headed browser mode in containers (required for Playwright Inspector login):
- **Linux**: Run `xhost +local:docker` before starting container
- **Default DISPLAY**: Set to `:0` in [docker-compose.dev.yml](docker-compose.dev.yml) via `DISPLAY=${DISPLAY:-:0}`
- Production uses `DISPLAY=:99` expecting Xvfb or similar

## Testing the API

```bash
# Using curl (non-streaming)
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model-name","messages":[{"role":"user","content":"Hello"}],"stream":false}'

# Using OpenAI Python SDK
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3000/v1", api_key="your-secret-api-key")
response = client.chat.completions.create(
    model="your-model-name",  # Use the MODEL_NAME from your .env
    messages=[{"role": "user", "content": "Hello"}],
    stream=True
)
```

## Common Customization Scenarios

**New Chatbox Integration**:
1. Update `CHATBOX_URL` in `.env`
2. Inspect target chatbox DOM with browser DevTools
3. Update `SELECTOR_*` variables in `.env`
4. Test login flow with `npm run dev`
5. If selectors don't work, modify [src/browser/chatbox.ts](src/browser/chatbox.ts)

**Changing Response Detection Logic**:
Modify `waitForResponse()` in [src/browser/chatbox.ts](src/browser/chatbox.ts) - the default waits for `SELECTOR_LAST_MESSAGE` to appear and stabilize (no text changes for 500ms).

**Authentication**:
API key authentication is implemented in [src/api/server.ts](src/api/server.ts) middleware. The `/health` and `/login/*` endpoints bypass authentication.
