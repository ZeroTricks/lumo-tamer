# Development

## Setup

```bash
npm install
npm run build
```

See the [README](../README.md) for authentication setup.

## Dev Commands

```bash
npm run dev:server           # API server with hot reload (tsx watch)
npm run dev:cli              # CLI
npm run dev:auth             # Authentication tool

npm run dev:server:debug     # API server with Node inspector (port 9229)
npm run dev:cli:debug        # CLI with Node inspector
```

Hot reload uses `tsx watch`. Edit, save, done.

To attach a debugger, open `chrome://inspect` in Chrome and add `localhost:9229`, or use the included VSCode launch configurations.

## Build

```bash
npm run build                # TypeScript compilation + alias resolution

# Optional: Go binary for login auth method
cd src/auth/login/go && go build -o ../../../../dist/proton-auth && cd -
```

## Project Structure

```
src/
├── server.ts                  # API server entry point
├── cli.ts                     # CLI entry point
├── api/                       # OpenAI-compatible API
│   └── routes/                # /v1/responses, /v1/chat/completions, etc.
├── app/                       # Shared application logic
│   ├── config.ts              # Configuration management
│   ├── commands.ts            # Slash commands (/save, /help, /logout, etc.)
│   └── logger.ts              # Pino logger
├── cli/                       # CLI client (interactive mode, file ops, code execution)
├── auth/                      # Authentication (browser, login, rclone)
│   ├── browser/               # CDP-based browser token extraction
│   ├── login/                 # Go SRP binary integration
│   ├── rclone/                # Rclone config parsing
│   └── vault/                 # Encrypted credential storage
├── lumo-client/               # Bridge: connects API/CLI to Proton's Lumo backend
├── conversations/             # Conversation store, encryption, sync
│   ├── encryption/            # Key hierarchy (master key → space key → DEK)
│   └── sync/                  # Remote sync via upstream LumoApi
├── proton-upstream/           # Unchanged files from Proton WebClients
└── proton-shims/              # Reimplements @proton/crypto for Node.js
```

See [upstream.md](upstream.md) for details on upstream files and shims.

## Upstream Sync

```bash
npm run sync-upstream

# With a visual diff tool:
DIFF_TOOL=meld npm run sync-upstream
```

Fetches files from GitHub, compares with local copies, and provides an interactive menu to review changes, update files, and track the upstream commit.

See [upstream.md](upstream.md) for file mappings.

## Testing

There is no proper test suite yet. The `tests/` directory contains some ad-hoc scripts used during development. Proper testing is planned for a future release.
