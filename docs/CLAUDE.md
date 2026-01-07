# Project Guide for Claude Code

## Architecture

```
OpenAI Client → API Server → Queue → Playwright → Web Chatbox
```

**Key files:**
- [src/api/server.ts](../src/api/server.ts) - Express API, OpenAI endpoints
- [src/queue/manager.ts](../src/queue/manager.ts) - Serial request processing
- [src/browser/manager.ts](../src/browser/manager.ts) - Playwright lifecycle, CDP connection
- [src/browser/chatbox.ts](../src/browser/chatbox.ts) - DOM interaction via selectors
- [src/config.ts](../src/config.ts) - Environment config loader

## Key Concepts

**Session Persistence**: `storageState()` API saves browser state to `sessions/state.json`. Login via `page.pause()` (Playwright Inspector), then auto-saved.

**Message Serialization**: Queue ensures one message at a time (prevents chatbox race conditions).

**Streaming**: `streamResponse()` monitors DOM mutations, yields incremental deltas as chatbox renders.

**CDP Connection**: App connects to remote browser via `chromium.connectOverCDP(browserConfig.cdpEndpoint)`. No bundled browser.

## Development

```bash
# Local
npm run dev          # Hot reload
npm run dev:debug    # Debugger on 9229

# Docker (preferred)
make dev-build       # Hot reload + noVNC
make logs            # Watch logs
make shell           # Container shell
```

## Configuration

All in `.env`, loaded via [src/config.ts](../src/config.ts):
- `serverConfig` - Port, API key, model name
- `browserConfig` - CDP endpoint, headless mode, sessions
- `chatboxSelectors` - DOM selectors

## Common Tasks

### New Chatbox Integration
1. Set `CHATBOX_URL` in `.env`
2. Find selectors in DevTools
3. Update `SELECTOR_*` in `.env`
4. If selectors fail, modify [src/browser/chatbox.ts](../src/browser/chatbox.ts)

### Customize Login Detection
Edit `isLoggedIn()` in [src/browser/chatbox.ts](../src/browser/chatbox.ts)

### Adjust Response Detection
Edit `waitForResponse()` or `streamResponse()` in [src/browser/chatbox.ts](../src/browser/chatbox.ts)

## Testing

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer key" \
  -H "Content-Type: application/json" \
  -d '{"model":"x","messages":[{"role":"user","content":"test"}]}'
```

Or use OpenAI SDK with `base_url="http://localhost:3000/v1"`
