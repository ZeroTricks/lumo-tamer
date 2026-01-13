# Proton WebClients Upstream Files

This directory contains **unchanged** files from Proton's WebClients repository.
The `@proton/*` imports are resolved via TypeScript path aliases to our shims.

## Source Information

- **Repository:** https://github.com/ProtonMail/WebClients
- **Commit:** 2cd8b155ca61863382855906dd6f56f73b2558f7
- **Sync Date:** 2025-01-13
- **License:** GPLv3

## Directory Structure

```
proton-upstream/
├── crypto/
│   ├── index.ts      # Shim bridging relative imports to @proton/* shims
│   └── types.ts      # Crypto key types (unchanged)
├── keys.ts           # Lumo GPG public key (unchanged)
└── lib/lumo-api-client/core/
    ├── encryption.ts # U2L encryption (unchanged)
    ├── streaming.ts  # SSE processor (unchanged)
    └── types.ts      # API types (unchanged)
```

## How Path Aliases Work

The upstream files use `@proton/*` imports which are mapped in `tsconfig.json`:

| Import Path | Resolves To |
|-------------|-------------|
| `@proton/crypto` | `src/proton-shims/crypto.ts` |
| `@proton/crypto/lib/subtle/aesGcm` | `src/proton-shims/aesGcm.ts` |
| `@proton/crypto/lib/subtle/hash` | `src/proton-shims/hash.ts` |
| `@proton/crypto/lib/utils` | `src/proton-shims/utils.ts` |

At build time, `tsc-alias` rewrites these to relative paths in the output.

## Updating from Upstream

```bash
npm run sync-upstream
```

This fetches files directly from GitHub and compares them with local copies.

## About the Shims (`src/proton-shims/`)

The shims are **our own implementations** - they don't come from upstream and
don't need to be synced. They provide the same API as `@proton/crypto/*` packages
using standard libraries:

| Shim File | Replaces | Implementation |
|-----------|----------|----------------|
| `aesGcm.ts` | `@proton/crypto/lib/subtle/aesGcm` | Node.js `crypto.subtle` |
| `hash.ts` | `@proton/crypto/lib/subtle/hash` | Node.js `crypto.subtle` |
| `utils.ts` | `@proton/crypto/lib/utils` | `TextEncoder`/`TextDecoder` |
| `crypto.ts` | `@proton/crypto` (CryptoProxy) | `openpgp` npm package |

**When would shims need updating?**

Only if upstream changes the function signatures they expect from `@proton/*`:
- If upstream starts calling a new function we don't have
- If they change the return type or parameters of existing functions

The `sync-upstream.sh` script will show a build failure after syncing if this
happens, and you'd need to add the missing function to the appropriate shim.

In practice, these low-level crypto APIs are stable - they're thin wrappers
around WebCrypto, so they rarely change.

## Files NOT from Upstream

The `crypto/index.ts` file in this directory is a **shim**, not an upstream copy.
It bridges the upstream relative imports (`../../../crypto`) to our implementations.
