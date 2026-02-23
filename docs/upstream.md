# Proton WebClients Upstream Files

This document is for contributors maintaining the integration with Proton's WebClients.

---

## Source

- **Repository:** https://github.com/ProtonMail/WebClients
- **Paths:**
  - `applications/lumo/src/app/` - Lumo application code
  - `packages/` - Shared packages (`@proton/crypto`, `@proton/shared`, etc.)
- **License:** GPLv3

## Strategy

We prefer to pull files unchanged from upstream. When that's not possible:

| Problem | Solution | Location |
|---------|----------|----------|
| `@proton/*` imports | tsconfig path alias | `proton-shims/` |
| Relative import to missing file | Shim at that path | `proton-upstream/` |
| Minor code tweaks | DEP-3 patch | `scripts/upstream/patches/` |
| Major rewrites | Shim (replace file) | `proton-upstream/` |

## Directory Structure

```
src/
├── proton-upstream/    # Mirrors applications/lumo/src/app/
│   ├── crypto/         # Synced from upstream
│   ├── lib/            # Synced from upstream
│   ├── redux/          # Synced + patched
│   └── ...
├── proton-shims/       # Mirrors packages/ structure
│   ├── crypto/
│   │   ├── lib/
│   │   │   ├── proxy/proxy.ts     # Local shim (CryptoProxy)
│   │   │   ├── subtle/aesGcm.ts   # Synced from packages/
│   │   │   ├── subtle/hash.ts     # Synced from packages/
│   │   │   └── utils.ts           # Local shim
│   │   └── index.ts               # Barrel export
│   ├── shared/lib/                # Local shims
│   └── utils/mergeUint8Arrays.ts  # Local shim
└── shims/              # Non-Proton shims (polyfills, wrappers)
    ├── console.ts              # Logger redirect
    ├── fetch-adapter.ts        # HTTP adapter
    ├── indexeddb-polyfill.ts   # SQLite-backed IndexedDB
    ├── uint8array-base64-polyfill.ts  # ES2024 polyfill
    ├── lodash-*.ts             # ESM wrappers
    └── ...
```

## Current State

- **~40 files** synced unchanged from `applications/lumo/src/app/`
- **2 files** synced unchanged from `packages/` (aesGcm.ts, hash.ts)
- **2 patches** for minor Node.js adaptations
- **8 shims** in `proton-upstream/` (local implementations)
- **6 shims** in `proton-shims/` (for `@proton/*` aliases)
- **9 shims** in `shims/` (polyfills and library wrappers)

## Updating from Upstream

```bash
npm run sync-upstream
```

The script:
1. Downloads files from GitHub and compares with local
2. Shows changes to shim source files (with GitHub diff links)
3. Prompts to sync
4. Copies upstream files and applies patches
5. On patch conflict: produces git-style conflict markers (`<<<<<<<`, `>>>>>>>`)

Review changes with `git diff`, then `npm run build`.

## File Categories

### Synced Files (LUMO_FILES)

Pulled unchanged and optionally patched. See `sync-upstream.sh` for full list.

### Patched Files

| File | Patch | Description |
|------|-------|-------------|
| `keys.ts` | `keys.patch` | Export for Node.js (no webpack DefinePlugin) |
| `redux/selectors.ts` | `selectors.patch` | Remove react-redux, @proton/account |

### Shims in proton-upstream/ (LUMO_SHIMS)

Local implementations that replace upstream Lumo app files. The sync script warns when upstream changes.

| File | Purpose |
|------|---------|
| `config.ts` | APP_NAME, APP_VERSION, API_URL |
| `redux/slices/index.ts` | Core slices only (no UI slices) |
| `redux/slices/lumoUserSettings.ts` | Stub for Node.js |
| `redux/slices/attachmentLoadingState.ts` | Stub for saga compat |
| `redux/store.ts` | Simplified for Node.js (no browser middleware) |
| `redux/rootReducer.ts` | No @proton/redux-shared-store |
| `util/safeLogger.ts` | Console logging |
| `services/search/searchService.ts` | Stub |

### Shims in proton-shims/ (PROTON_SHIMS)

Local implementations for `@proton/*` packages. The sync script warns when upstream changes.

| File | Purpose |
|------|---------|
| `crypto/lib/proxy/proxy.ts` | CryptoProxy using standard openpgp |
| `crypto/lib/utils.ts` | Partial (utf8/Uint8Array utils only) |
| `shared/lib/apps/helper.ts` | APP_NAME stub |
| `shared/lib/fetch/headers.ts` | UID/Authorization headers |

### Adapted Files (ADAPTED_SOURCE_FILES)

Partially reused with different structure:

| File | Purpose |
|------|---------|
| `mocks/handlers.ts` | SSE scenarios (no MSW dependency) |

## Path Aliases

Upstream `@proton/*` imports are mapped in `tsconfig.json` to mirror the packages/ structure:

| Import | Resolves To |
|--------|-------------|
| `@proton/crypto` | `proton-shims/crypto/index.ts` |
| `@proton/crypto/lib` | `proton-shims/crypto/index.ts` |
| `@proton/crypto/lib/subtle/aesGcm` | `proton-shims/crypto/lib/subtle/aesGcm.ts` |
| `@proton/crypto/lib/subtle/hash` | `proton-shims/crypto/lib/subtle/hash.ts` |
| `@proton/crypto/lib/utils` | `proton-shims/crypto/lib/utils.ts` |
| `@proton/shared/lib/apps/helper` | `proton-shims/shared/lib/apps/helper.ts` |
| `@proton/shared/lib/fetch/headers` | `proton-shims/shared/lib/fetch/headers.ts` |
| `@proton/utils/mergeUint8Arrays` | `proton-shims/utils/mergeUint8Arrays.ts` |

Non-Proton aliases:

| Import | Resolves To |
|--------|-------------|
| `lodash/isNil` | `shims/lodash-isNil.ts` |
| `lodash/isEqual` | `shims/lodash-isEqual.ts` |
| `lodash/isObject` | `shims/lodash-isObject.ts` |
| `json-stable-stringify` | `shims/json-stable-stringify.ts` |
| `toposort` | `shims/toposort.ts` |

## Patches

Patches in `proton-upstream/patches/` use DEP-3 format. The `series` file lists them in order.

### Creating a Patch

1. Sync upstream to get pristine file
2. Make changes
3. `diff -u file.orig file > patches/name.patch`
4. Add DEP-3 headers (Description, Author, Origin)
5. Add to `patches/series`

### DEP-3 Format

```
Description: Short summary
Author: Name <email>
Origin: vendor

---
diff --git a/path/to/file.ts b/path/to/file.ts
...
```

See [DEP-3 spec](https://dep-team.pages.debian.net/deps/dep3/).

## About proton-shims/

The `@proton/*` packages are public npm packages, but we shim them because:

- `@proton/crypto` uses pmcrypto with WebWorker architecture (browser-only)
- `@proton/shared` has deep dependency chains on other `@proton/*` packages
- Both assume browser environment; we run in Node.js

Our shims use standard `openpgp` and Node.js `crypto.subtle`.

The directory structure mirrors `packages/` so file paths match upstream. Some files (aesGcm.ts, hash.ts) are synced directly; others are local reimplementations.

## About shims/

Non-Proton shims that don't need upstream tracking:

| File | Purpose |
|------|---------|
| `console.ts` | Redirects console to pino logger |
| `fetch-adapter.ts` | Bridges upstream API calls to lumo-tamer |
| `indexeddb-polyfill.ts` | SQLite-backed IndexedDB for Node.js |
| `uint8array-base64-polyfill.ts` | ES2024 Uint8Array.fromBase64/toBase64 |
| `lodash-*.ts` | ESM wrappers for lodash functions |
| `json-stable-stringify.ts` | CJS/ESM interop |
| `toposort.ts` | CJS/ESM interop |

## Known Divergences

These files in `lib/lumo-api-client/core/` were rewritten early and use different types:

| File | Issue |
|------|-------|
| `types.ts` | Uses `GenerationToFrontendMessage` vs upstream's `GenerationResponseMessage` |
| `streaming.ts` | Depends on above |
| `encryption.ts` | Inline logic vs `RequestEncryptionParams` abstraction |

To resolve: rename types, pull `encryptionParams.ts`, update consumers.

## Uint8Array.fromBase64 Polyfill

Upstream uses ES2024 `Uint8Array.fromBase64()` and `.toBase64()`. The polyfill in `shims/uint8array-base64-polyfill.ts` patches the global prototype at startup.

Native support arrives in Node.js 25+ (V8 14.1). Once Node 25/26 becomes minimum version, the polyfill can be removed.
