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
| `@proton/*` imports | tsconfig path alias | `packages/proton/` |
| Relative import to missing file | Shim at that path | `packages/lumo/` |
| Minor code tweaks | DEP-3 patch | `packages/lumo/patches/` |
| Major rewrites | Shim (replace file) | `packages/lumo/` |

## Directory Structure

Upstream code lives in workspace packages (separate from `src/`):

```
packages/
├── lumo/                # @lumo - DO NOT EDIT MANUALLY
│   ├── patches/
│   │   ├── series
│   │   ├── keys.patch
│   │   └── selectors.patch
│   ├── src/                    # Mirrors applications/lumo/src/app/
│   │   ├── config.ts           # Shim
│   │   ├── crypto/             # Synced from upstream
│   │   ├── lib/                # Synced from upstream
│   │   ├── redux/              # Synced + patched
│   │   └── ...
│   └── package.json
├── proton/            # @proton - DO NOT EDIT MANUALLY
│   ├── src/                    # Mirrors packages/ structure
│   │   ├── crypto/
│   │   │   ├── lib/
│   │   │   │   ├── proxy/proxy.ts     # Local shim (CryptoProxy)
│   │   │   │   ├── subtle/aesGcm.ts   # Synced from packages/
│   │   │   │   ├── subtle/hash.ts     # Synced from packages/
│   │   │   │   └── utils.ts           # Local shim
│   │   │   └── index.ts               # Barrel export
│   │   ├── shared/lib/                # Local shims
│   │   └── utils/mergeUint8Arrays.ts  # Local shim
│   └── package.json
src/
├── shims/                      # Non-Proton shims (polyfills, wrappers)
│   ├── console.ts              # Logger redirect
│   ├── fetch-adapter.ts        # HTTP adapter
│   ├── indexeddb-polyfill.ts   # SQLite-backed IndexedDB
│   ├── uint8array-base64-polyfill.ts  # ES2024 polyfill
│   ├── lodash-*.ts             # ESM wrappers
│   └── ...
└── ...                         # Your application code
```

## Current State

- **~40 files** synced unchanged from `applications/lumo/src/app/`
- **3 files** synced unchanged from `packages/` (aesGcm.ts, hash.ts, mergeUint8Arrays.ts)
- **4 patches** for Node.js adaptations (mostly IndexedDB transaction fixes)
- **8 shims** in `lumo/` (local implementations)
- **4 shims** in `proton/` (for `@proton/*` aliases)
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

Pulled unchanged and optionally patched. See `sync.sh` for full list.

### Patched Files

| File | Patch | Description |
|------|-------|-------------|
| `keys.ts` | `keys.patch` | Export for Node.js (no webpack DefinePlugin) |
| `redux/selectors.ts` | `redux-selectors.patch` | Remove react-redux, @proton/account |
| `redux/sagas/index.ts` | `redux-sagas-index.patch` | Fix IDB transaction auto-commit in loadReduxFromIdb |
| `indexedDb/db.ts` | `indexedDb-db.patch` | Fix IDB transaction auto-commit throughout DbApi |

### Shims in lumo/ (LUMO_SHIMS)

Local implementations that replace upstream Lumo app files. The sync script warns when upstream changes.

| File | Purpose |
|------|---------|
| `config.ts` | APP_NAME, APP_VERSION, API_URL |
| `lib/lumo-api-client/index.ts` | Minimal barrel (upstream imports too many modules) |
| `mocks/handlers.ts` | Scenario generators (upstream uses MSW) |
| `redux/slices/index.ts` | Core slices only (no UI slices) |
| `redux/slices/lumoUserSettings.ts` | Stub for Node.js |
| `redux/slices/attachmentLoadingState.ts` | Stub for saga compat |
| `redux/store.ts` | Simplified for Node.js (no browser middleware) |
| `redux/rootReducer.ts` | No @proton/redux-shared-store |
| `util/safeLogger.ts` | Console logging |
| `services/search/searchService.ts` | Stub |

### Shims in proton/ (PROTON_SHIMS)

Local implementations for `@proton/*` packages. The sync script warns when upstream changes.

| File | Purpose |
|------|---------|
| `crypto/lib/proxy/proxy.ts` | CryptoProxy using standard openpgp |
| `crypto/lib/utils.ts` | Partial (utf8/Uint8Array utils only) |
| `shared/lib/apps/helper.ts` | APP_NAME stub |
| `shared/lib/fetch/headers.ts` | UID/Authorization headers |

## Path Aliases

Two alias systems coexist:

### Package imports (for lumo-tamer code)

| Import | Resolves To |
|--------|-------------|
| `@lumo/*` | `packages/lumo/src/*` |

### Upstream-compatible imports (for synced code)

Upstream code uses `@proton/*` imports. These are mapped in `tsconfig.json`:

| Import | Resolves To | Note |
|--------|-------------|------|
| `@proton/*` | `packages/proton/src/*` | Wildcard for deep paths |
| `@proton/crypto` | `packages/proton/src/crypto/index.ts` | Barrel export |
| `@proton/crypto/lib` | `packages/proton/src/crypto/index.ts` | Upstream barrel imports WebWorker deps |

### Non-Proton aliases

| Import | Resolves To |
|--------|-------------|
| `lodash/isNil` | `src/shims/lodash-isNil.ts` |
| `lodash/isEqual` | `src/shims/lodash-isEqual.ts` |
| `lodash/isObject` | `src/shims/lodash-isObject.ts` |
| `json-stable-stringify` | `src/shims/json-stable-stringify.ts` |
| `toposort` | `src/shims/toposort.ts` |

## Patches

Patches in `packages/lumo/patches/` use DEP-3 format. The `series` file lists them in order.

### Creating a Patch

Use the helper script:

```bash
scripts/upstream/create-patch.sh <file-path> "<description>"

# Example:
scripts/upstream/create-patch.sh indexedDb/db.ts "Fix transaction auto-commit"
# Creates: packages/lumo/patches/indexedDb-db.patch
```

The patch name is derived from the file path (`indexedDb/db.ts` → `indexedDb-db.patch`).

The script downloads the pristine upstream file, creates a diff with DEP-3 headers, and verifies it applies. After running:

1. Edit the generated `.patch` file to improve the Description
2. Add the patch name to `packages/lumo/patches/series`

### DEP-3 Format

```
Description: Short summary
 Additional lines indented with space.
 .
 Blank paragraph uses single period.
Origin: vendor
---
 path/to/file.ts | 10 ++++------
 1 file changed, 4 insertions(+), 6 deletions(-)

diff --git a/path/to/file.ts b/path/to/file.ts
--- a/path/to/file.ts
+++ b/path/to/file.ts
@@ -1,5 +1,5 @@
...
```

The `diff --git` line and `--- a/` prefix are required. Patches are applied with `patch -p1` which strips the `a/` prefix.

See [DEP-3 spec](https://dep-team.pages.debian.net/deps/dep3/).

## About proton/

The `@proton/*` packages are internal to Proton's WebClients monorepo (not published to npm). We shim them because:

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

## Uint8Array.fromBase64 Polyfill

Upstream uses ES2024 `Uint8Array.fromBase64()` and `.toBase64()`. The polyfill in `src/shims/uint8array-base64-polyfill.ts` patches the global prototype at startup.

Native support arrives in Node.js 25+ (V8 14.1). Once Node 25/26 becomes minimum version, the polyfill can be removed.
