# Conversation Persistence

This document is for developers working on conversation persistence.


## Overview

lumo-tamer supports two conversation stores:
- **ConversationStore**: encrypted offline persistence and full sync reusing WebClient's code
- **FallbackStore**: in-memory, optional one-way sync

ConversationStore is the way forward, but still new. It will allow future lumo-tamer versions to make Lumo remember and search past converations.  
However, FallbackStore is the default for now (`useFallbackStore: true`) because:
- ConversationStore needs more testing (general performance and performance with `login`and `rclone` authentications)
- Persistence is not required for the core functionality of chatting with Lumo

To sync conversations with other Lumo instances (web- or mobile apps), **browser authentication** is required.

---

## Configuration

```yaml
conversations:
  useFallbackStore: true          # true = fallback, false = ConversationStore (default: true)
  enableSync: false               # Enable server sync (requires browser auth)
  projectName: lumo-tamer         # Project name (created if doesn't exist)
  deriveIdFromUser: false         # For stateless clients (Home Assistant)
  databasePath: "sessions/"       # IndexedDB SQLite files location
```


---

## ConversationStore

Reuses Proton's WebClient infrastructure for local persistence and server sync.

### Architecture

```
ConversationStore (adapter)
  → Redux store (in-memory state)
    → IndexedDB (encrypted offline persistence via indexeddbshim -> SQLite)
    → Sagas (automatic server sync)
```

### Store Initialization

1. Import IndexedDB polyfill (`src/shims/indexeddb-polyfill.js`)
2. Create DbApi (initialize IndexedDB -> SQLite)
3. Create saga middleware with context (dbApi, lumoApi)
4. Setup Redux store
5. Start root saga (triggers IDB load)
6. Dispatch `addMasterKey` (triggers initAppSaga)
7. Wait for Redux to load from IDB
8. Wait for remote spaces to be fetched
9. Find or create space by `projectName`
10. Return ConversationStore adapter

### Encryption
lumo-tamer reuses the Lumo WebClient's encryption layer. Both offline storage and data synced to Lumo is encryped using following keys:

1. **Master Key**: Fetched from `/lumo/v1/masterkeys`, decrypted with user's PGP private key
2. **Space Key**: Generated per-space, wrapped with master key using AES-KW
3. **Data Encryption Key (DEK)**: Derived from space key using HKDF with fixed salt
4. **Content**: Encrypted with AES-GCM using DEK

### Server Sync

When authenticated via browser, sync is automatic via Redux sagas:

- Messages and conversations are marked dirty in IndexedDB
- Sagas detect dirty items and push to server
- Sync state persists across restarts

### Message Deduplication

- **semanticId**: Call ID for tool messages, hash(role+content) for regular messages
- `findNewMessages()`: Compares incoming messages against stored messages

### Manual save
Call `/save [optional title]` to save stateless conversations. See [troubleshooting](#i-enabled-sync-but-my-chats-dont-appear-in-lumo).


### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| ConversationStore | [src/conversations/store.ts](../src/conversations/store.ts) | Adapter wrapping Redux for lumo-tamer's interface |
| Store initialization | [src/conversations/init.ts](../src/conversations/init.ts) | Sets up Redux, IndexedDB, sagas, resolves project space |
| KeyManager | [src/conversations/key-manager.ts](../src/conversations/key-manager.ts) | Master/space key management |
| Deduplication | [src/conversations/deduplication.ts](../src/conversations/deduplication.ts) | Message deduplication via semantic IDs |
| Redux slices | [packages/lumo/src/redux/slices/core/](../packages/lumo/src/redux/slices/core/) | State for spaces, conversations, messages |
| Redux sagas | [packages/lumo/src/redux/sagas/](../packages/lumo/src/redux/sagas/) | Async sync operations (push/pull) |
| IndexedDB layer | [packages/lumo/src/indexedDb/db.ts](../packages/lumo/src/indexedDb/db.ts) | DbApi for local SQLite storage |

---

## FallbackStore

Legacy in-memory cache for environments without full persistence support.

### Architecture

```
FallbackStore (in-memory LRU)
  → SyncService (manual sync to server)
    → SpaceManager (space lifecycle)
    → EncryptionCodec (AEAD encryption)
    → AutoSyncService
```

### Auto-Sync

When authenticated via browser and `enableSync: true`:

1. `FallbackStore.markDirtyById()` notifies `AutoSyncService`
2. **Debounce**: Waits 5s for activity to settle
3. **Throttle**: Respects 30s minimum interval
4. **Max delay**: Forces sync after 60s
5. Auto syncs on exit.

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| FallbackStore | [src/conversations/fallback/store.ts](../src/conversations/fallback/store.ts) | In-memory Map with LRU eviction |
| SyncService | [src/conversations/fallback/sync/sync-service.ts](../src/conversations/fallback/sync/sync-service.ts) | Orchestrates server sync |
| SpaceManager | [src/conversations/fallback/sync/space-manager.ts](../src/conversations/fallback/sync/space-manager.ts) | Space lifecycle and key management |
| EncryptionCodec | [src/conversations/fallback/sync/encryption-codec.ts](../src/conversations/fallback/sync/encryption-codec.ts) | AEAD encryption/decryption |
| AutoSyncService | [src/conversations/fallback/sync/auto-sync.ts](../src/conversations/fallback/sync/auto-sync.ts) | Debounced/throttled sync |



---

## Known Limitations

### Sync only available when authenticated via `browser`
So far, only the `browser` authentication method is able to fetch all necessary tokens and keys to encrypt messages for storage, and call Lumo's API endpoints to save them.

### Conversation Limit

Proton's backend enforces a per-project conversation limit. Deleted conversations count towards this limit. When reached, sync fails with HTTP 422 "You've reached maximum number of conversations". Use a new `projectName` to work around this. See [#16](https://github.com/ZeroTricks/lumo-tamer/issues/16).

---

## Troubleshooting

### "I set useFallbackStore: false but it's still using FallbackStore"

**Solution:** ConversationStore requires cached encryption keys. Re-authenticate to save/generate them.

### "I enabled sync but my chats don't appear in Lumo"

**Cause:** Your API client isn't providing a conversation identifier, so lumo-tamer treats requests as stateless.

**Solution:** Configure your client to send a conversation identifier.
- Include `"conversation": "your-conversation-id"` in the request (`/v1/responses`)
- Use `previous_response_id` to chain responses together (`/v1/responses`)
- Include `"user": "unique-session-id"` and set `deriveIdFromUser: true` (`/v1/responses` and `/v1/chat/completions`)

**Example:**
```yaml
# config.yaml
conversations:
  deriveIdFromUser: true
  enableSync: true
```

```json
// API request
{
  "model": "lumo",
  "user": "session-abc123",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

**How to verify it's working:**
- Check logs for `Persisted conversation messages` (stateful) vs no persistence log (stateless)
- Check logs for `Generated title` on first message
- After sync, check Proton Lumo WebClient for the conversation

---

## Proton WebClient Reference

Reference material based on analysis of `https://github.com/ProtonMail/WebClients/applications/lumo/src/app/`.

### Architecture

Three-tier persistence:

```
UI (React) -> Redux -> Saga Middleware -> IndexedDB (local) + Remote API (server)
```

1. **Redux** - In-memory state for fast UI
2. **IndexedDB** - Local encrypted storage, offline-first
3. **Remote API** - Server-side persistence (`/api/lumo/v1/`)

### Data Structures

#### Space
Container for conversations with its own encryption key.

```typescript
type Space = {
    id: SpaceId;              // UUID
    createdAt: string;
    spaceKey: Base64;         // HKDF-derived, wrapped with master key
};
```

#### Conversation
```typescript
type Conversation = {
    id: ConversationId;
    spaceId: SpaceId;
    title: string;            // Encrypted
    starred?: boolean;
    status?: 'generating' | 'completed';
    ghost?: boolean;          // Transient, not persisted
};
```

#### Message
```typescript
type Message = {
    id: MessageId;
    conversationId: ConversationId;
    role: 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result';
    parentId?: MessageId;     // For branching
    content?: string;         // Encrypted
    status?: 'succeeded' | 'failed';
};
```

### AEAD (Authenticated Encryption with Associated Data)

All encrypted content uses associated data to bind ciphertext to its context. AD is a JSON object with alphabetically sorted keys (via `json-stable-stringify`):

```typescript
// Space AD
{"app":"lumo","id":"<spaceId>","type":"space"}

// Conversation AD
{"app":"lumo","id":"<conversationId>","spaceId":"<spaceId>","type":"conversation"}

// Message AD
{"app":"lumo","conversationId":"<convId>","id":"<messageId>","parentId":"<parentId>","role":"user|assistant","type":"message"}
```


### API Endpoints

Base URL: `/api/lumo/v1/`

| Resource | Endpoints |
|----------|-----------|
| Spaces | `GET/POST /spaces`, `GET/PUT/DELETE /spaces/{id}` |
| Conversations | `POST /spaces/{spaceId}/conversations`, `GET/PUT/DELETE /conversations/{id}` |
| Messages | `POST /conversations/{id}/messages`, `GET /messages/{id}` |
| Master Keys | `GET/POST /masterkeys` |

### Key Files

| Path | Purpose |
|------|---------|
| `src/app/types.ts` | Data structures |
| `src/app/remote/api.ts` | HTTP client |
| `src/app/indexedDb/db.ts` | IndexedDB operations |
| `src/app/redux/sagas/conversations.ts` | Sync orchestration |
| `src/app/serialization.ts` | Encryption helpers |
