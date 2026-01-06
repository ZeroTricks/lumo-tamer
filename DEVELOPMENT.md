# Development Guide

This guide explains how to develop Lumo Bridge directly in a Docker container with live code reloading.

## Quick Start - Container Development

You have **two ways** to develop Lumo Bridge in containers with live code reloading:

### Using Make (Recommended)

```bash
make dev-build    # Build and start with hot reload
make logs         # Watch logs
make shell        # Get a shell
make dev-down     # Stop
make help         # See all commands
```

### Using Docker Compose Directly

```bash
docker compose -f docker-compose.dev.yml up --build    # Start with hot reload
docker compose -f docker-compose.dev.yml logs -f       # Watch logs
docker compose -f docker-compose.dev.yml exec lumo-bridge-dev /bin/bash  # Get a shell
docker compose -f docker-compose.dev.yml down          # Stop
```

## How It Works

### File Mounting Strategy
```
Your Computer          →    Docker Container
─────────────────           ─────────────────
./src/                 →    /app/src/          (LIVE mounted - edits reload!)
./sessions/            →    /app/sessions/     (Persistent - survives restarts)
./package.json         →    /app/package.json  (Read-only)
./.env                 →    /app/.env          (Read-only)
node_modules/          →    Docker Volume      (Performance - not mounted)
```

**Key Points:**
- ✅ Edit files in `src/` → Container restarts automatically
- ✅ Login sessions persist in `sessions/`
- ⚠️  Change dependencies → Rebuild: `make dev-build`

### Hot Reloading

The development container uses `tsx watch` which automatically restarts when you save files:

1. You edit `src/browser/chatbox.ts`
2. Container detects change
3. App automatically restarts
4. New code running in ~1 second!

```bash
# Edit any file in src/
vim src/browser/chatbox.ts

# Save → App automatically restarts in container!
```

### Debugging

The debugger is exposed on port 9229:

```bash
# In Chrome, go to:
chrome://inspect

# Click "Configure" → Add localhost:9229
# Click "inspect" when target appears
```

### Viewing Logs

```bash
# Follow logs
make logs

# Or using docker compose directly
docker compose -f docker-compose.dev.yml logs -f

# Or inspect container logs
docker logs -f lumo-bridge-dev
```

### Shell Access

```bash
# Get a shell in the running container
make shell

# Or using docker compose directly
docker compose -f docker-compose.dev.yml exec lumo-bridge-dev /bin/bash

# Now you can run commands:
npx playwright --version
ls -la sessions/
cat .env
```

## X11 Setup for Browser Display

The container needs to show the browser for Playwright Inspector (login).

### Linux

```bash
# Allow Docker to access X11
make x11-enable

# Or manually:
xhost +local:docker

# Start container - browser appears on your screen!
make dev-build
```

### macOS

```bash
# Install XQuartz
brew install --cask xquartz

# Start XQuartz
open -a XQuartz

# In XQuartz preferences:
# - Enable "Allow connections from network clients"
# - Restart XQuartz

# Get your IP
export DISPLAY=$(ipconfig getifaddr en0):0

# Allow connections
xhost + $(ipconfig getifaddr en0)

# Start container with display
DISPLAY=$DISPLAY make dev-build
```

### Windows (WSL2)

```bash
# In WSL2, set display
export DISPLAY=$(cat /etc/resolv.conf | grep nameserver | awk '{print $2}'):0

# Install VcXsrv on Windows
# Start XLaunch with "Disable access control"

# Start container
make dev-build
```

## File Structure & What Gets Mounted

```
/home/david/lumo-bridge/
├── src/                    # ✅ Mounted (live edits!)
├── package.json            # ✅ Mounted (read-only)
├── tsconfig.json           # ✅ Mounted (read-only)
├── .env                    # ✅ Mounted (read-only)
├── sessions/               # ✅ Mounted (persistent)
└── node_modules/           # ⚠️  Docker volume (persisted separately)
```

**Important:** `node_modules` is a Docker volume for performance. If you change dependencies:

```bash
# Rebuild to update node_modules
make dev-build
```

## Development Workflow Example

```bash
# 1. Start container
make dev-build

# 2. In another terminal, watch logs
make logs

# 3. Edit code in your favorite editor
vim src/browser/chatbox.ts  # or VS Code, etc.

# 4. Save → Auto-reload happens!
# Check logs to see restart

# 5. Test API
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-secret-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatbox-default","messages":[{"role":"user","content":"test"}]}'

# 6. Need to debug?
make shell
cd src
cat browser/manager.ts

# 7. Done!
make dev-down
```

## Common Development Tasks

### Adding a New Dependency

```bash
# Method 1: Rebuild container
# Edit package.json locally, then:
make dev-build

# Method 2: Install from inside container
make shell
npm install some-package
exit
# Then copy package.json changes to host
```

### Testing Selector Changes

```bash
# 1. Edit .env with new selectors
vim .env

# 2. Container auto-restarts with new config

# 3. Check logs to see if selectors work
make logs
```

### Clearing Session Data

```bash
# Use the make command
make clean-sessions

# Or manually
rm -rf sessions/*

# Restart container
make dev-restart
```

### Viewing Playwright Inspector in Container

The `page.pause()` opens Playwright Inspector. With X11 forwarding set up:

1. Start container with display enabled
2. When app calls `page.pause()`:
   - Browser window appears on your screen
   - Playwright Inspector window appears
3. Interact normally!

## Performance Tips

### Volume Mounting Performance

On macOS/Windows, Docker volumes can be slow. For better performance:

```yaml
# In docker-compose.dev.yml, consider:
volumes:
  - ./src:/app/src:cached  # macOS: Use cached mode
```

### Node Modules

We use a named volume for `node_modules` to avoid slow cross-platform filesystem operations:

```yaml
volumes:
  - node_modules:/app/node_modules  # Fast!
```

## Common Tasks Reference

```bash
# Start developing
make dev-build

# View all commands
make help

# Get shell access
make shell

# Clear sessions (test fresh login)
make clean-sessions

# Restart without rebuilding
make dev-restart

# Stop everything
make dev-down

# Clean everything including volumes
make clean-all
```

## Troubleshooting

### Changes not reflected

```bash
# Check if tsx watch is running
make logs

# Should see: "Watching for changes..."
```

### Browser not appearing

```bash
# Verify X11 forwarding
xhost

# Should show: access control disabled

# Check DISPLAY variable in container
make shell
echo $DISPLAY  # Should be :0 (dev) or :99 (prod)
```

### Port already in use

```bash
# Kill existing container
make dev-down

# Or change port in docker-compose.dev.yml
ports:
  - "3001:3000"  # Use 3001 instead
```

### Container crashes on start

```bash
# Check logs for errors
make logs

# Rebuild from scratch
make clean-all
make dev-build
```

## Production vs Development

| Feature | Development | Production |
|---------|------------|------------|
| Source code | Mounted (live edits) | Copied (built into image) |
| Hot reload | ✅ Yes | ❌ No |
| Debugger | ✅ Port 9229 | ❌ Disabled |
| Image size | Larger (dev tools) | Smaller (minimal) |
| TypeScript | tsx watch | Compiled to JS |
| Use case | Local development | Deployment |

## Advanced: Customizing the Dev Container

Edit [docker-compose.dev.yml](docker-compose.dev.yml) for custom configuration:

```yaml
environment:
  # Add custom env vars
  - MY_CUSTOM_VAR=value

volumes:
  # Mount additional directories
  - ./custom-dir:/app/custom-dir

ports:
  # Expose additional ports
  - "8080:8080"
```

## Next Steps

1. **Start developing:**
   ```bash
   make dev-build
   ```

2. **Configure your chatbox:**
   - Edit `.env` with your chatbox URL
   - Set the correct DOM selectors
   - See README.md for selector examples

3. **Try it out:**
   - Edit `src/browser/chatbox.ts`
   - Watch it reload automatically
   - Test API calls

4. **Read more:**
   - [README.md](README.md) - User documentation
   - [CLAUDE.md](CLAUDE.md) - Project architecture guide

## Resources

- [Playwright Documentation](https://playwright.dev)
- [Docker Compose Reference](https://docs.docker.com/compose/)

Happy coding! 🚀
