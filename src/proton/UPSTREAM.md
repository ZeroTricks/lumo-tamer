# Proton WebClients Source Tracking

This directory contains code adapted from Proton's WebClients repository.

## Source Information

- **Repository:** https://github.com/ProtonMail/WebClients
- **Local Clone:** /tmp/WebClients
- **Commit:** 2cd8b155ca61863382855906dd6f56f73b2558f7
- **Extraction Date:** 2025-01-13
- **License:** GPLv3

## Files Adapted

| Local File | Source File | Notes |
|------------|-------------|-------|
| types.ts | applications/lumo/src/app/lib/lumo-api-client/core/types.ts | Subset of types, added AesGcmCryptoKey |
| streaming.ts | applications/lumo/src/app/lib/lumo-api-client/core/streaming.ts | Updated imports only |
| crypto.ts | applications/lumo/src/app/crypto/index.ts + packages/crypto/lib/subtle/aesGcm.ts | Reimplemented using Node.js WebCrypto |
| keys.ts | applications/lumo/src/app/keys.ts | Direct copy of public key |
| encryption.ts | applications/lumo/src/app/lib/lumo-api-client/core/encryption.ts | Adapted for openpgp package |

## Dependencies Replaced

| Proton Package | Replacement |
|----------------|-------------|
| @proton/shared/lib/interfaces (Api type) | Custom api-adapter.ts |
| @proton/crypto (CryptoProxy) | openpgp npm package |
| @proton/crypto/lib/subtle/aesGcm | Node.js crypto.subtle |
| @proton/crypto/lib/utils | TextEncoder/TextDecoder |
| @proton/utils/mergeUint8Arrays | Local utility function |

## Updating

To update from upstream:
1. `cd /tmp/WebClients && git pull`
2. Compare files listed above for changes
3. Update local files as needed
4. Update commit hash in this file
