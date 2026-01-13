# Proton WebClients Codebase Analysis

This document captures learnings from analyzing Proton's WebClients repository for the lumo-bridge API integration.

**Source Repository:** https://github.com/ProtonMail/WebClients
**Analyzed Commit:** 2cd8b155ca61863382855906dd6f56f73b2558f7
**License:** GPLv3

---

## Repository Structure

```
/tmp/WebClients/
├── applications/
│   ├── lumo/                    # Lumo AI assistant application
│   ├── mail/                    # Proton Mail
│   ├── drive/                   # Proton Drive
│   └── ...                      # Other Proton apps
├── packages/
│   ├── crypto/                  # @proton/crypto - Encryption utilities
│   ├── shared/                  # @proton/shared - Shared types/utilities
│   ├── srp/                     # @proton/srp - Secure Remote Password auth
│   └── ...                      # Other shared packages
└── ...
```

---

## Lumo Application Structure

**Location:** `applications/lumo/src/app/`

### Key Directories

| Path | Purpose |
|------|---------|
| `lib/lumo-api-client/` | API client for Lumo backend |
| `crypto/` | Lumo-specific encryption utilities |
| `keys.ts` | Lumo's PGP public keys |
| `types.ts`, `types-api.ts` | TypeScript type definitions |

### API Client Architecture

```
lib/lumo-api-client/
├── core/
│   ├── client.ts          # Main LumoApiClient class (472 lines)
│   ├── types.ts           # Type definitions (197 lines)
│   ├── streaming.ts       # SSE parser (83 lines)
│   ├── encryption.ts      # U2L encryption (69 lines)
│   ├── network.ts         # HTTP endpoint calls (29 lines)
│   ├── request-builder.ts # Fluent API builder (264 lines)
│   └── interceptors.ts    # Request/response interceptors (231 lines)
├── integrations/
│   ├── react.ts           # React hooks
│   └── redux.ts           # Redux helpers
├── hooks.ts               # React hooks (duplicate)
├── utils.ts               # Helper utilities
└── index.ts               # Public exports
```

---

## API Communication

### Endpoint

```
POST /api/ai/v1/chat
```

### Request Format

```typescript
{
  Prompt: {
    type: 'generation_request',
    turns: Turn[],                    // Conversation history
    options: {
      tools?: ToolName[] | boolean    // ['proton_info', 'web_search', ...]
    },
    targets: ['message'] | ['message', 'title'],
    request_key?: string,             // PGP-encrypted AES key (base64)
    request_id?: string               // UUID for AEAD encryption
  }
}
```

### Turn Structure

```typescript
type Role = 'assistant' | 'user' | 'system' | 'tool_call' | 'tool_result';

type Turn = {
    role: Role;
    content?: string;
    encrypted?: boolean;
};
```

### Response Format (Server-Sent Events)

```
data: {"type":"queued"}
data: {"type":"ingesting","target":"message"}
data: {"type":"token_data","target":"message","count":1,"content":"Hello","encrypted":true}
data: {"type":"token_data","target":"message","count":2,"content":" world","encrypted":true}
data: {"type":"done"}
```

### Message Types

| Type | Description |
|------|-------------|
| `queued` | Request accepted, waiting in queue |
| `ingesting` | Processing started for target |
| `token_data` | Streaming text chunk |
| `done` | Generation complete |
| `timeout` | Request timed out |
| `error` | General error |
| `rejected` | Request rejected |
| `harmful` | Content filtered |

### Generation Targets

| Target | Description |
|--------|-------------|
| `message` | Main response content |
| `title` | Auto-generated conversation title |
| `tool_call` | Function/tool invocation |
| `tool_result` | Result from tool execution |

---

## Encryption Scheme

### Overview

Lumo uses **User-to-Lumo (U2L) encryption** for end-to-end privacy:

1. **Per-request AES key** generated for each API call
2. **Turn content** encrypted with AES-GCM using request key
3. **Request key** encrypted with Lumo's PGP public key
4. **Response chunks** encrypted with same request key

### Algorithms

| Purpose | Algorithm | Key Size |
|---------|-----------|----------|
| Content encryption | AES-GCM | 256 bits |
| Key exchange | PGP (ECDH) | 256 bits |
| IV | Random | 12 bytes |

### AEAD (Additional Authenticated Data)

Request turns use AD string:
```
lumo.request.{requestId}.turn
```

Response chunks use AD string:
```
lumo.response.{requestId}.chunk
```

### Encryption Flow

```
1. Generate requestKey (AES-GCM-256)
2. Generate requestId (UUID)
3. For each turn:
   - Encrypt content with requestKey + AD "lumo.request.{requestId}.turn"
   - Set encrypted: true
4. Encrypt requestKey with Lumo's PGP public key
5. Send request with encrypted turns + encrypted key + requestId
6. Receive encrypted response chunks
7. Decrypt each chunk with requestKey + AD "lumo.response.{requestId}.chunk"
```

### Lumo Public Key

**Location:** `applications/lumo/src/app/keys.ts`

```
Fingerprint: F032A1169DDFF8EDA728E59A9A74C3EF61514A2A
Algorithm: EdDSA (signing) + ECDH (encryption)
Key Size: 256 bits
Created: 2025-04-28
Expires: 2029-04-27
UserID: Proton Lumo (Prod Key 0002) <support@proton.me>
```

---

## @proton/crypto Package

**Location:** `packages/crypto/`

### Not Published to npm

The package is workspace-internal (`workspace:^`), not available on npm. Uses `pmcrypto` (alias for `@protontech/pmcrypto`) internally.

### Key Components

| Export | Purpose |
|--------|---------|
| `CryptoProxy` | Main interface for crypto operations |
| `lib/subtle/aesGcm` | AES-GCM encryption using WebCrypto |
| `lib/subtle/hash` | SHA-256 hashing |
| `lib/utils` | UTF-8 encoding utilities |

### AES-GCM Implementation

**Location:** `packages/crypto/lib/subtle/aesGcm.ts`

```typescript
// Constants
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const ENCRYPTION_ALGORITHM = 'AES-GCM';

// Key functions
generateKey(): Uint8Array              // Random 32 bytes
importKey(bytes): Promise<CryptoKey>   // Import for WebCrypto
exportKey(key): Promise<Uint8Array>    // Export from WebCrypto

// Encryption
encryptData(key, data, ad?): Promise<Uint8Array>  // Returns IV + ciphertext
decryptData(key, data, ad?): Promise<Uint8Array>  // Expects IV + ciphertext

// Key wrapping (AES-KW)
wrapKey(key, wrappingKey): Promise<Uint8Array>
unwrapKey(encryptedKey, wrappingKey): Promise<CryptoKey>

// Key derivation (HKDF)
deriveKey(secret, salt, info): Promise<CryptoKey>
```

### CryptoProxy Interface

```typescript
// PGP operations (via pmcrypto)
CryptoProxy.importPublicKey({ armoredKey }): Promise<PublicKey>
CryptoProxy.encryptMessage({ binaryData, encryptionKeys, format }): Promise<EncryptedMessage>
CryptoProxy.decryptMessage({ ... }): Promise<DecryptedMessage>
```

---

## Lumo Crypto Utilities

**Location:** `applications/lumo/src/app/crypto/`

### Key Functions

```typescript
// Key generation
generateMasterKeyBytes(): Uint8Array    // AES-KW wrapping key
generateSpaceKeyBytes(): Uint8Array     // AES-GCM for spaces
generateRequestKeyBytes(): Uint8Array   // AES-GCM for requests

// Encryption/Decryption
encryptString(plaintext, key, ad?): Promise<string>   // Returns base64
decryptString(encrypted, key, ad): Promise<string>    // Expects base64

// Key derivation
deriveDataEncryptionKey(spaceKeyBytes): Promise<AesGcmCryptoKey>

// Key wrapping
wrapAesKey(key, wrappingKey): Promise<Uint8Array>
unwrapAesKey(encrypted, masterKey): Promise<AesGcmCryptoKey>
```

### Type Definitions

```typescript
type AesGcmCryptoKey = {
    type: 'AesGcmCryptoKey';
    encryptKey: CryptoKey;
};

type AesKwCryptoKey = {
    type: 'AesKwCryptoKey';
    wrappingKey: CryptoKey;
};
```

---

## Authentication

### Protocol: SRP (Secure Remote Password)

**Location:** `packages/srp/lib/`

Proton uses SRP for password-based authentication without transmitting the actual password.

### Flow

1. `POST /core/v4/auth/info` - Get auth info (modulus, salt, SRP session)
2. Compute SRP proof client-side
3. `POST /core/v4/auth` - Send proof, receive tokens
4. Handle 2FA if required (`POST /core/v4/auth/2fa`)
5. Handle CAPTCHA if triggered (requires browser)

### Session Tokens

| Token | Lifespan | Purpose |
|-------|----------|---------|
| AccessToken | Hours-days | API authentication |
| RefreshToken | Weeks-months | Get new access tokens |
| UID | Session | User identifier |

### Cookie-Based Token Storage

Proton stores auth tokens in cookies with specific naming conventions:

| Cookie Pattern | Domain | Purpose |
|----------------|--------|---------|
| `AUTH-{uid}` | `lumo.proton.me` | Access token for API calls |
| `REFRESH-{uid}` | `lumo.proton.me` | Refresh token (URL-encoded JSON) |
| `Session-Id` | `.proton.me` | Cross-app session identifier |

**Key Finding:** The UID is embedded in the cookie *name*, not stored separately. Extract it with:
```typescript
const authCookie = cookies.find(c => c.name.startsWith('AUTH-') && c.domain.includes('lumo.proton.me'));
const uid = authCookie.name.replace('AUTH-', '');
const accessToken = authCookie.value;
```

### Required HTTP Headers

**Location:** `packages/shared/lib/fetch/headers.ts`

```typescript
// From getAuthHeaders()
{
  'x-pm-uid': UID,
  'Authorization': `Bearer ${AccessToken}`,
  'x-pm-appversion': 'web-lumo@{version}'  // e.g., 'web-lumo@5.0.0'
}
```

All three headers are required for authenticated API calls. Missing `x-pm-appversion` returns error code 5002.

### Token Refresh

```
POST /auth/refresh
{
  ResponseType: 'token',
  GrantType: 'refresh_token',
  RefreshToken: '<token>',
  RedirectURI: 'https://protonmail.com'
}
```

The REFRESH cookie contains URL-encoded JSON with the refresh token and metadata:
```json
{
  "ResponseType": "token",
  "ClientID": "WebLumo",
  "GrantType": "refresh_token",
  "RefreshToken": "...",
  "UID": "..."
}
```

---

## Personalization / System Instructions

### How Lumo Handles "How should Lumo behave?"

**Key Finding:** Personalization is NOT sent as a system message. It's appended to the user's message content.

### Storage

```typescript
// Endpoint
GET/POST/PUT /api/lumo/v1/settings

// Structure
interface PersonalizationSettings {
    nickname: string;           // "Call me {nickname}."
    jobRole: string;            // "I work as: {jobRole}"
    personality: 'default' | 'business-cat' | 'sassy-cat' | ...;
    traits: string[];           // ['chatty', 'witty', ...]
    lumoTraits: string;         // Free-form text
    additionalContext: string;  // "How should Lumo behave?"
    enableForNewChats: boolean;
}
```

### Injection Pattern

```typescript
// From llm/index.ts
const updatedContent = originalContent
  ? `${originalContent}\n\n[Personal context: ${personalizationPrompt}]`
  : `[Personal context: ${personalizationPrompt}]`;
```

---

## Chat History API

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/lumo/v1/spaces` | GET | List all spaces with conversations |
| `/api/lumo/v1/spaces/{id}` | GET | Get single space |
| `/api/lumo/v1/conversations/{id}` | GET | Get conversation with messages |

### Data Model

```typescript
type Space = {
    id: SpaceId;
    createdAt: string;
    spaceKey: Base64;  // Key to decrypt conversation titles
};

type Conversation = {
    id: ConversationId;
    spaceId: SpaceId;
    createdAt: string;
    starred?: boolean;
    title: string;  // Encrypted
};
```

### Title Encryption

Conversation titles are encrypted with the space's derived encryption key:

```typescript
// Decryption flow
masterKey → unwrap spaceKey (AES-KW)
         → derive DEK via HKDF
         → decrypt title (AES-GCM)
```

---

## Available Tools

```typescript
type ToolName =
  | 'proton_info'      // Internal: Proton product information
  | 'web_search'       // External: Web search
  | 'weather'          // External: Weather data
  | 'stock'            // External: Stock prices
  | 'cryptocurrency';  // External: Crypto prices
```

---

## Dependencies

### Required for API Client

| Package | Purpose | Node.js Compatible |
|---------|---------|-------------------|
| `openpgp` | PGP encryption | Yes |
| `uuid` | UUID generation | Yes |

### Internal Proton Packages (Not on npm)

| Package | Alternative |
|---------|-------------|
| `@proton/crypto` | Use `openpgp` + native WebCrypto |
| `@proton/shared` | Define own types |
| `@proton/srp` | Use `go-proton-api` or implement |

---

## Key Files Reference

### For API Integration

| File | Purpose |
|------|---------|
| `applications/lumo/src/app/lib/lumo-api-client/core/client.ts` | Main client logic |
| `applications/lumo/src/app/lib/lumo-api-client/core/types.ts` | Type definitions |
| `applications/lumo/src/app/lib/lumo-api-client/core/streaming.ts` | SSE parsing |
| `applications/lumo/src/app/lib/lumo-api-client/core/encryption.ts` | U2L encryption |
| `applications/lumo/src/app/lib/lumo-api-client/core/network.ts` | API endpoint |
| `applications/lumo/src/app/crypto/index.ts` | Crypto utilities |
| `applications/lumo/src/app/keys.ts` | Lumo public key |
| `packages/crypto/lib/subtle/aesGcm.ts` | AES-GCM implementation |

### For Authentication

| File | Purpose |
|------|---------|
| `packages/srp/lib/` | SRP authentication |
| `packages/shared/lib/api/auth.ts` | Auth API calls |
| `packages/shared/lib/authentication/` | Session management |

---

## Gotchas & Learnings

1. **@proton/crypto not on npm** - Must copy/adapt code or use `openpgp` directly

2. **WebCrypto TypeScript types** - `Uint8Array` and `ArrayBuffer` type mismatches require explicit conversion:
   ```typescript
   function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
       const buf = new ArrayBuffer(arr.byteLength);
       new Uint8Array(buf).set(arr);
       return buf;
   }
   ```

3. **AEAD strings must match exactly** - Encryption and decryption must use identical AD strings

4. **Encryption may be optional** - The `enableU2LEncryption` config flag suggests server may accept unencrypted requests (not tested)

5. **Response chunks have `encrypted` flag** - Must check per-chunk whether decryption is needed

6. **Personalization injected into user message** - Not a separate system message, but appended as `[Personal context: ...]`

7. **SSE format uses `data:` prefix** - Each JSON message is prefixed with `data: `

8. **Incomplete lines buffered** - StreamProcessor handles partial JSON across chunk boundaries

9. **UID not a separate cookie** - Unlike typical auth flows, there's no `UID` cookie. The UID is embedded in the `AUTH-{uid}` cookie name pattern. The cookie value is the access token.

10. **Three required auth headers** - API calls need `x-pm-uid`, `Authorization: Bearer {token}`, AND `x-pm-appversion`. Missing any returns 400/401 errors.
