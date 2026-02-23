# Proton WebClients Upstream Files

This document is for contributors maintaining the integration with Proton's WebClients.

---

## Source

- **Repository:** https://github.com/ProtonMail/WebClients
- **Path:** `applications/lumo/src/app/`
- **License:** GPLv3

## Strategy

We prefer to pull files unchanged from upstream. When that's not possible:

| Problem | Solution | Location |
|---------|----------|----------|
| `@proton/*` imports | tsconfig path alias | `proton-shims/` |
| Relative import to missing file | Shim at that path | `proton-upstream/` |
| Minor code tweaks | DEP-3 patch | `proton-upstream/patches/` |
| Major rewrites | Shim (replace file) | `proton-upstream/` |

## Current State

- **~40 files** synced unchanged from upstream
- **2 patches** for minor Node.js adaptations
- **8 shims** in `proton-upstream/` (local implementations)
- **~10 shims** in `proton-shims/` (for `@proton/*` aliases)

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

### Synced Files (UPSTREAM_FILES)

Pulled unchanged and optionally patched. See `sync-upstream.sh` for full list.

### Patched Files

| File | Patch | Description |
|------|-------|-------------|
| `keys.ts` | `keys.patch` | Export for Node.js (no webpack DefinePlugin) |
| `redux/selectors.ts` | `selectors.patch` | Remove react-redux, @proton/account |

### Shims (SHIM_SOURCE_FILES)

Local implementations that replace upstream files. The sync script warns when upstream changes.

| File | Purpose |
|------|---------|
| `config.ts` | APP_NAME, APP_VERSION, API_URL |
| `crypto/index.ts` | Bridges to @proton/* shims |
| `redux/slices/index.ts` | Core slices only (no UI slices) |
| `redux/slices/lumoUserSettings.ts` | Stub for Node.js |
| `redux/slices/attachmentLoadingState.ts` | Stub for saga compat |
| `redux/store.ts` | Simplified for Node.js (no browser middleware) |
| `redux/rootReducer.ts` | No @proton/redux-shared-store |
| `util/safeLogger.ts` | Console logging |

### Adapted Files (ADAPTED_SOURCE_FILES)

Partially reused with different structure:

| File | Purpose |
|------|---------|
| `mocks/handlers.ts` | SSE scenarios (no MSW dependency) |

## Path Aliases

Upstream `@proton/*` imports are mapped in `tsconfig.json`:

| Import | Resolves To |
|--------|-------------|
| `@proton/crypto` | `proton-shims/crypto.ts` |
| `@proton/crypto/lib/subtle/aesGcm` | `proton-shims/aesGcm.ts` |
| `@proton/crypto/lib/subtle/hash` | `proton-shims/hash.ts` |
| `@proton/crypto/lib/utils` | `proton-shims/crypto-lib-utils.ts` |
| `@proton/shared/lib/apps/helper` | `proton-shims/apps-helper.ts` |
| `@proton/shared/lib/fetch/headers` | `proton-shims/fetch-headers.ts` |

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

## Known Divergences

These files in `lib/lumo-api-client/core/` were rewritten early and use different types:

| File | Issue |
|------|-------|
| `types.ts` | Uses `GenerationToFrontendMessage` vs upstream's `GenerationResponseMessage` |
| `streaming.ts` | Depends on above |
| `encryption.ts` | Inline logic vs `RequestEncryptionParams` abstraction |

To resolve: rename types, pull `encryptionParams.ts`, update consumers.

## Uint8Array.fromBase64 Polyfill

Upstream uses ES2024 `Uint8Array.fromBase64()` and `.toBase64()`. The polyfill in `proton-shims/uint8array-base64-polyfill.ts` patches the global prototype at startup.
