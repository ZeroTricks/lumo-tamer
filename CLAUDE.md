# lumo-tamer
This project creates an OpenAI-compatible API on top of Proton's conversation agent Lumo.

## Architecture

**Entry point**: `src/tamer.ts` - dispatches to server (`tamer server`), CLI (default), or auth (`tamer auth`).

**Application** (`src/app/`): Shared bootstrap for all modes. Loads config, initializes auth, creates LumoClient + ConversationStore + optional sync. Exposes `AppContext` to consumers.

**Clients** (both use LumoClient + ConversationStore):
- API (`src/api/`): `/v1/responses` (primary), `/v1/chat/completions`. Message conversion in `message-converter.ts`, tool call parsing in `tools/`, shared logic in `routes/shared.ts`.
- CLI (`src/cli/`): Interactive client with code block detection/execution.

**Core**:
- **LumoClient** (`src/lumo-client/client.ts`): Bridge to Proton. Handles U2L encryption, SSE streaming, native tool call detection (web_search, weather, etc.), bounces misrouted custom tools.
- **ConversationStore** (`src/conversations/store.ts`): In-memory LRU cache. Message deduplication, turn conversion, dirty-flagging for sync.
- **Auth** (`src/auth/`): Three providers (login/Go SRP, browser token extraction, rclone). `AuthManager` handles auto-refresh + 401 retries.
- **Sync** (`src/conversations/sync/`, `encryption/`): Optional Proton-native storage. KeyManager for user keys, SyncService for push/pull.

**Proton integration** (see `docs/upstream.md`):
- `packages/lumo/` (`@lumo/*`): From `WebClients/applications/lumo/src/app/` - **do not edit**, use `npm run sync-upstream`
- `packages/proton/` (`@proton/*`): From `WebClients/packages` - **do not edit**
- `src/shims/`: Non-Proton polyfills (IndexedDB, lodash, etc.)

## Coding guidelines:
- Reuse Proton's WebClients code when possible:
  - Prefer syncing files unchanged over writing shims
  - Use tsconfig aliases and polyfills to make upstream code work
  - Update `scripts/upstream/sync.sh` when adding files
  - Document source URLs in shim file headers
  - Write modular code, reuse common logic between:
    - different authentication methods
    - /v1/responses and /v1/chat/completions endpoints
    - API and CLI calls
  - Use config.ts, config.yaml and config.defaults.yaml to add configuration parameters. Don't put defaults in config.ts or other code; config.defaults.yaml is the single source of truth.
  - Use src/logger.ts for logging. Use print() to force printing to stdout. Don't use console.log(). Log errors like this: logger.error({error}, "Can't do that").

  ## Testing:
  - Framework: Vitest. Run `npm test` (all) or `npm run test:unit` / `npm run test:integration`.
  - Tests inject `createMockProtonApi()` directly, bypassing Application/config.yaml entirely.
  - `tests/helpers/test-server.ts` creates an Express app with mock dependencies for integration tests.
  - Unit tests: pure function/class tests in `tests/unit/`.
  - Integration tests: HTTP endpoint tests in `tests/integration/`.
  - E2E tests: OpenAI SDK compatibility and CLI smoke test in `tests/e2e/`.
  - `tests/setup.ts` initializes config and silences the logger for all tests.

  ## Documentation guidelines:
  - Try to find extra information on relevant parts in docs/
  - After implementation, make sure relevant docs/ are up to date
  - Be concise in documentation. This project is in flux and documenation gets outdated quickly.
  - Don't use "—"