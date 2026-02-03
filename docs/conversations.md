# Conversation Persistence

This document covers conversation persistence: how Proton's Lumo WebClient does it, and how lumo-tamer implements compatible persistence.

> **NOTE**: Proton's API and codebase use `space` for conversation containers. The WebClient UI uses `project`. We follow this terminology: config and logs use `project` (user-facing), while internal code keeps `space` to match the API.

---

# Part 1: Proton Lumo WebClient Reference

Reference material based on analysis of `~/WebClients/applications/lumo/src/app/`.

## Architecture

Three-tier persistence:

```
UI (React) → Redux → Saga Middleware → IndexedDB (local) + Remote API (server)
```

1. **Redux** - In-memory state for fast UI
2. **IndexedDB** - Local encrypted storage, offline-first
3. **Remote API** - Server-side persistence (`/api/lumo/v1/`)

## Data Structures

### Space
Container for conversations with its own encryption key.

```typescript
type Space = {
    id: SpaceId;              // UUID
    createdAt: string;
    spaceKey: Base64;         // HKDF-derived, wrapped with master key
};
```

### Conversation
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

### Message
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

### Local Flags
```typescript
type LocalFlags = {
    dirty?: boolean;    // Needs sync to server
    deleted?: boolean;  // Soft delete
};
```

## API Endpoints

Base URL: `/api/lumo/v1/`

| Resource | Endpoints |
|----------|-----------|
| Spaces | `GET/POST /spaces`, `GET/PUT/DELETE /spaces/{id}` |
| Conversations | `POST /spaces/{spaceId}/conversations`, `GET/PUT/DELETE /conversations/{id}` |
| Messages | `POST /conversations/{id}/messages`, `GET /messages/{id}` |
| Master Keys | `GET/POST /masterkeys` |

## Encryption

### Key Hierarchy

```
User PGP Key (decrypted with mailbox password)
    → Master Key (PGP-encrypted on server)
        → Space Key (AES-KW wrapped with master key)
            → Data Encryption Key (HKDF-derived from space key)
                → Content (AES-GCM with AEAD)
```

### Process

1. **Master Key**: Fetched from `/lumo/v1/masterkeys`, decrypted with user's PGP private key
2. **Space Key**: Generated per-space, wrapped with master key using AES-KW
3. **Data Encryption Key (DEK)**: Derived from space key using HKDF with fixed salt
4. **Content**: Encrypted with AES-GCM using DEK

### AEAD (Authenticated Encryption with Associated Data)

All encrypted content uses associated data to bind ciphertext to its context, preventing substitution attacks. The AD is a JSON object with alphabetically sorted keys (via `json-stable-stringify`):

```typescript
// Space AD
{"app":"lumo","id":"<spaceId>","type":"space"}

// Conversation AD
{"app":"lumo","id":"<conversationId>","spaceId":"<spaceId>","type":"conversation"}

// Message AD
{"app":"lumo","conversationId":"<convId>","id":"<messageId>","parentId":"<parentId>","role":"user|assistant","type":"message"}
```

## Sync Mechanism

- **Dirty flags**: Items marked `dirty: true` need sync
- **Sagas**: Redux-saga orchestrates sync with debouncing (`noRaceSameId`)
- **Retry**: 30s intervals on failure
- **Ghost mode**: `ghost: true` conversations skip persistence

## Key Files (~/WebClients/applications/lumo/)

| Path | Purpose |
|------|---------|
| `src/app/types.ts` | Data structures |
| `src/app/remote/api.ts` | HTTP client |
| `src/app/indexedDb/db.ts` | IndexedDB operations |
| `src/app/redux/sagas/conversations.ts` | Sync orchestration |
| `src/app/serialization.ts` | Encryption helpers |

---

# Part 2: lumo-tamer Implementation

## Why Not Reuse Proton's Layers?

Proton's persistence is tightly coupled to their stack:

- **IndexedDB layer** (`DbApi`) - Clean, but requires `fake-indexeddb` polyfill for Node.js
- **Sync orchestration** - Lives in Redux sagas, deeply coupled to generators and Redux state

We reuse:

- **LumoApi** - Pulled [upstream](upstream.md) unchanged; integrated via a fetch adapter that routes API calls through our authenticated ProtonApi
- **Encryption scheme** - Same key hierarchy and AEAD format (compatible with WebClient)

We implement our own:

- **ConversationStore** - Simple in-memory store with LRU eviction
- **SyncService** - Direct sync without saga complexity, delegates to LumoApi
- **AutoSyncService** - Timer-based debounce/throttle

## Architecture

Two-tier persistence:

```
API Clients (OpenAI format)
    → ConversationStore (in-memory, LRU eviction)
        → SyncService → LumoApi (upstream) → Fetch Adapter → ProtonApi → /api/lumo/v1/
```

Goal: Share conversations between lumo-tamer and Proton WebClient.

## Configuration

```yaml
conversations:
  maxInMemory: 100              # Max conversations in memory (LRU eviction)
  deriveIdFromUser: false           # For stateless clients (Home Assistant)
  sync:
    enabled: true
    projectName: lumo-tamer      # Project name (created if doesn't exist)
    # projectId: "uuid"           # Or use specific project UUID
    includeSystemMessages: false  # Only sync user/assistant messages
    autoSync: false             # Or use /save command
```

## Title Generation

Conversation titles are auto-generated on the first message, following Proton's WebClient pattern.

### How It Works

1. When a new conversation is created (title = `'New Conversation'`), `requestTitle: true` is passed to the LLM
2. The API streams title chunks alongside the message (targets: `['title', 'message']`)
3. Title is post-processed: quotes removed, trimmed, max 100 chars
4. Title is saved to `ConversationStore` and synced with the conversation


## Synchronization

### Manual Sync (`/save`)

Send `/save` as a message to sync all dirty conversations:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model": "lumo", "messages": [{"role": "user", "content": "/save"}]}'
```

### Auto-Sync

When `sync.autoSync: true`:

1. `ConversationStore.markDirty()` notifies `AutoSyncService`
2. **Debounce**: Waits for activity to settle
3. **Throttle**: Respects minimum interval
4. **Max delay**: Forces sync after timeout

### Known Limitation: Conversation Limit

Proton's backend enforces a per-project conversation limit. Deleted conversations count towards this limit. When reached, sync fails with HTTP 422 "You've reached maximum number of conversations". Conversations remain usable locally but are not persisted server-side. Use a new `projectName` to work around this. See [#16](https://github.com/ZeroTricks/lumo-tamer/issues/16).

## Module Structure

```
src/conversations/
├── store.ts                # In-memory store with LRU
├── deduplication.ts        # Message hash deduplication
├── types.ts                # Core types
├── encryption/
│   └── key-manager.ts      # Master/space key management
└── sync/
    ├── sync-service.ts     # Manual sync to server
    ├── auto-sync.ts        # Automatic sync scheduling
    └── lumo-api.ts         # Upstream LumoApi wrapper
```

## Key Files

| File | Purpose |
|------|---------|
| [src/conversations/conversation-store.ts](../src/conversations/conversation-store.ts) | In-memory store |
| [src/conversations/sync/sync-service.ts](../src/conversations/sync/sync-service.ts) | Server sync |
| [src/conversations/sync/auto-sync.ts](../src/conversations/sync/auto-sync.ts) | Auto-sync scheduling |
| [src/conversations/encryption/key-manager.ts](../src/conversations/encryption/key-manager.ts) | Key management |
| [src/conversations/sync/lumo-api.ts](../src/conversations/sync/lumo-api.ts) | Upstream LumoApi wrapper |
| [src/proton-upstream/remote/api.ts](../src/proton-upstream/remote/api.ts) | LumoApi (upstream, unchanged) |
| [src/proton-shims/fetch-adapter.ts](../src/proton-shims/fetch-adapter.ts) | Routes LumoApi fetch calls to ProtonApi |
| [src/app/commands.ts](../src/app/commands.ts) | `/save`, `/title` commands |
| [src/proton-shims/lumo-api-client-utils.ts](../src/proton-shims/lumo-api-client-utils.ts) | `postProcessTitle()` |

## Verification

```bash
# Start with sync + auto-sync
npm run dev

# Send messages
curl -X POST http://localhost:3000/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model": "lumo", "conversation_id": "test-123", "input": "Hello"}'

# Check logs for "Auto-sync completed" or manually /save
# Verify in Proton Lumo WebClient - conversation should appear
```
