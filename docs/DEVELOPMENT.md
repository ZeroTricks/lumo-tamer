# Development Guide

## Quick Start

### Docker (Recommended)

```bash
make dev-build    # Build and start with hot reload
make logs         # Watch logs
make shell        # Get a shell
make dev-down     # Stop
```

**Browser GUI**: http://localhost:3001 (noVNC)

### Local Development

```bash
npm install
cp config.example.yaml config.yaml  # Edit with your config
npm run dev
```

### First Time Setup

1. Configure `config.yaml`:
   - `browser.url` - Target URL
   - `server.apiKey` - Your secret key
   - `selectors.*` - DOM selectors (find via DevTools)

2. Test the API:
```bash
curl http://localhost:3003/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"lumo","messages":[{"role":"user","content":"Hello"}]}'
```

### Common Commands

```bash
make help              # All commands
make clean-sessions    # Clear login sessions
make prod-build        # Production build
make prod-up           # Production deploy
```

## How It Works

### File Mounting
```
Local                    Container
─────                    ─────────
./src/                → /app/src/          (live mounted - edits reload!)
./sessions/           → /app/sessions/     (persistent)
node_modules/         → Docker volume      (performance)
```

Edit files in `src/` → Container auto-restarts in ~1 sec.

### Hot Reload

Uses `tsx watch`. Edit, save, done.

### Browser Access

- **noVNC**: http://localhost:3001
- **X11**: `make x11-enable` (Linux only)

**X11 Setup (Alternative to noVNC):**

Linux:
```bash
make x11-enable
make dev-build
```

macOS:
```bash
brew install --cask xquartz
# XQuartz → Preferences → Allow network connections
export DISPLAY=$(ipconfig getifaddr en0):0
xhost + $(ipconfig getifaddr en0)
make dev-build
```

### Debugging

Port 9229 exposed. Chrome: `chrome://inspect` → Add `localhost:9229`

## Workflow

```bash
# 1. Start
make dev-build

# 2. Watch logs
make logs

# 3. Edit code
vim src/browser/chatbox.ts

# 4. Test
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer key" \
  -d '{"model":"x","messages":[{"role":"user","content":"test"}]}'

# 5. Debug if needed
make shell
```

## Common Tasks

### Add Dependency
```bash
# Edit package.json, then:
make dev-build
```

### Clear Sessions
```bash
make clean-sessions
make dev-restart
```

### Change Config
```bash
vim config.yaml  # Auto-reloads
```

## Troubleshooting

**Changes not reflected**: Check logs for tsx watch errors.

**Browser not appearing**:
- noVNC: Visit http://localhost:3001
- X11: Run `make x11-enable`

**Port conflict**: Change `server.port` in `config.yaml`

**Container crash**: `make clean-all && make dev-build`

## Dev vs Prod

| | Dev | Prod |
|-|-----|------|
| Source | Mounted (live) | Copied (static) |
| Hot reload | ✅ | ❌ |
| Debugger | Port 9229 | ❌ |
| TypeScript | tsx watch | Compiled JS |

## Docker Compose Services

- `app-dev` - Dev app with hot reload
- `app` - Production app
- `browser-dev` - Browser with noVNC (port 3001)
- `open-webui` - Optional test UI (port 8080)

Start specific services: `docker compose up app-dev browser-dev`

## Upstream Sync

The `src/proton/` directory contains adapted code from Proton's WebClients repository. To check for upstream changes:

```bash
npm run sync-upstream

# With a visual diff tool (e.g., kompare, meld, kdiff3):
DIFF_TOOL=kompare npm run sync-upstream
```

**Features:**
- Fetches files directly from GitHub (no local clone needed)
- Compares tracked commit vs latest upstream
- Auto-detects appVersion changes from upstream `package.json`

**Menu options:**
1. View summary of changes
2. Open file in diff tool
3. Update appVersion in config.yaml
4. Update UPSTREAM.md with latest commit
5. Copy upstream file for manual review
6. Show upstream commit history

See [src/proton/UPSTREAM.md](../src/proton/UPSTREAM.md) for file mappings and adaptation notes.

## Resources

- [Playwright Docs](https://playwright.dev)
- [Docker Compose Reference](https://docs.docker.com/compose/)
