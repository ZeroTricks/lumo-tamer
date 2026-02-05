# Proton WebClients Upstream Files

This directory contains **unchanged** files from Proton's WebClients repository.
The `@proton/*` imports are resolved via TypeScript path aliases to our shims.

## Source Information

- **Repository:** https://github.com/ProtonMail/WebClients
- **Commit:** 8206a9933db97d0e62d45d7f4c9a7248c30e67b5
- **Sync Date:** 2026-01-22
- **License:** GPLv3

## Directory Structure

```
proton-upstream/
├── config.ts             # SHIM: provides APP_NAME, APP_VERSION, API_URL
├── crypto/
│   ├── index.ts          # SHIM: bridges relative imports to @proton/* shims
│   └── types.ts          # Crypto key types (unchanged)
├── keys.ts               # Lumo GPG public key (unchanged)
├── lib/lumo-api-client/core/
│   ├── encryption.ts     # U2L encryption (unchanged)
│   ├── streaming.ts      # SSE processor (unchanged)
│   └── types.ts          # API types (unchanged)
├── redux/
│   └── sagas.ts          # SHIM: ClientError, ConflictClientError classes
├── remote/
│   ├── api.ts            # LumoApi class (unchanged) - replaces our LumoPersistenceClient
│   ├── conversion.ts     # API<->local type converters (unchanged)
│   ├── scheduler.ts      # RequestScheduler for concurrent requests (unchanged)
│   ├── types.ts          # Remote API type definitions (unchanged)
│   └── util.ts           # PascalCase utilities (unchanged)
├── types/
│   └── index.ts          # SHIM: types expected by remote/* files
└── util/
    ├── collections.ts    # mapify, listify (unchanged)
    ├── date.ts           # dateToUnixTimestamp (unchanged)
    ├── objects.ts        # objectFilterV, identityV (unchanged)
    └── sorting.ts        # topoSortMessagesFromApi (unchanged)
```

## How Path Aliases Work

The upstream files use `@proton/*` imports which are mapped in `tsconfig.json`:

| Import Path | Resolves To |
|-------------|-------------|
| `@proton/crypto` | `src/proton-shims/crypto.ts` |
| `@proton/crypto/lib/subtle/aesGcm` | `src/proton-shims/aesGcm.ts` |
| `@proton/crypto/lib/subtle/hash` | `src/proton-shims/hash.ts` |
| `@proton/crypto/lib/utils` | `src/proton-shims/crypto-lib-utils.ts` |
| `@proton/shared/lib/apps/helper` | `src/proton-shims/apps-helper.ts` |
| `@proton/shared/lib/fetch/headers` | `src/proton-shims/fetch-headers.ts` |

At build time, `tsc-alias` rewrites these to relative paths in the output.

## Updating from Upstream

```bash
npm run sync-upstream
```

This fetches files directly from GitHub and compares them with local copies.

## About the Shims (`src/proton-shims/`)

The `@proton/*` packages we shim are **all public** - they're published to npm
and their source is in WebClients under `packages/`.

**Why not use the npm packages with tree shaking?**

Tree shaking would reduce bundle size but doesn't solve the fundamental issues:
- `@proton/crypto` uses `pmcrypto` with WebWorker architecture (browser-only)
- `@proton/shared` has deep dependency chains on other `@proton/*` packages
- Both assume browser environment; lumo-tamer runs in Node.js
- We'd be locked to npm versions instead of tracking specific WebClients commits

Shimming gives us precise control: we implement only what we need, using Node.js
APIs (`crypto.subtle`, standard `openpgp`), while keeping upstream files unchanged.

**Specific reasons we shim:

1. **`@proton/crypto`** - Depends on `pmcrypto` (Proton's OpenPGP fork) with
   custom build tooling and worker-based architecture. Our shims use standard
   `openpgp` and Node.js `crypto.subtle` instead.

2. **`@proton/shared`** - A massive package with many dependencies on other
   `@proton/*` packages. We only need a few small utilities.

| Shim File | Original in WebClients | Our Implementation |
|-----------|------------------------|-------------------|
| `crypto.ts` | `packages/crypto/lib/proxy/index.ts` | `openpgp` npm package |
| `aesGcm.ts` | `packages/crypto/lib/subtle/aesGcm.ts` | Node.js `crypto.subtle` |
| `hash.ts` | `packages/crypto/lib/subtle/hash.ts` | Node.js `crypto.subtle` |
| `crypto-lib-utils.ts` | `packages/crypto/lib/utils.ts` | `TextEncoder`/`TextDecoder` |
| `apps-helper.ts` | `packages/shared/lib/apps/helper.ts` | Hardcoded client IDs |
| `fetch-headers.ts` | `packages/shared/lib/fetch/headers.ts` | Simple header builder |
| `fetch-adapter.ts` | (none - integration shim) | Bridges LumoApi's fetch to our ProtonApi |

Each shim file has a header comment with exact line number mappings to the
original WebClients source.

**When would shims need updating?**

Only if upstream changes the function signatures they expect from `@proton/*`:
- If upstream starts calling a new function we don't have
- If they change the return type or parameters of existing functions

The `sync-upstream.sh` script will show a build failure after syncing if this
happens, and you'd need to add the missing function to the appropriate shim.

In practice, these low-level crypto APIs are stable - they're thin wrappers
around WebCrypto, so they rarely change.

## Files NOT from Upstream (Shims)

These files in this directory are **shims**, not upstream copies:

- `config.ts` - Provides APP_NAME, APP_VERSION, API_URL
- `crypto/index.ts` - Bridges upstream relative imports to our implementations
- `redux/sagas.ts` - Error classes (ClientError, ConflictClientError)
- `types/index.ts` - Selective type definitions needed by remote/* files

Note: `fetch-adapter.ts` was moved to `src/proton-shims/` since it's not imported
by upstream files via relative paths.

## Adapted (Not 1:1) Upstream Code

Some upstream code is adapted rather than pulled unchanged, because it has
browser-specific dependencies that can't be shimmed:

- `src/mock/mock-api.ts` - SSE scenario generators from `applications/lumo/src/app/mocks/handlers.ts`.
  The upstream file depends on MSW (Mock Service Worker) and browser globals.
  We reuse the scenario logic wrapped in a ProtonApi-compatible function instead.

## NPM Dependencies for Upstream Files

The upstream files require these additional npm packages:

- `lodash` - Used by `remote/conversion.ts` for `isNil`
- `toposort` - Used by `util/sorting.ts` for message sorting
