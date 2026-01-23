# Conversation Persistence

This document covers conversation persistence: how Proton's Lumo WebClient does it, and how lumo-bridge implements compatible persistence.

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

# Part 2: Lumo-Bridge Implementation

## Why Not Reuse Proton's Layers?

Proton's persistence is tightly coupled to their stack:

- **IndexedDB layer** (`DbApi`) - Clean, but requires `fake-indexeddb` polyfill for Node.js
- **Sync orchestration** - Lives in Redux sagas, deeply coupled to generators and Redux state
- **LumoApi** - Many dependencies on `@proton/shared` types

We reuse:

- **Encryption scheme** - Same key hierarchy and AEAD format (compatible with WebClient)
- **API endpoints** - Same `/api/lumo/v1/` REST API

We implement our own:

- **ConversationStore** - Simple in-memory store with LRU eviction
- **SyncService** - Direct sync without saga complexity
- **AutoSyncService** - Timer-based debounce/throttle

## Architecture

Two-tier persistence:

```
API Clients (OpenAI format)
    → ConversationStore (in-memory, LRU eviction)
        → SyncService → Lumo API (/api/lumo/v1/)
```

Goal: Share conversations between lumo-bridge and Proton WebClient.

## Configuration

```yaml
persistence:
  enabled: true
  defaultSpaceName: lumo-bridge
  maxConversationsInMemory: 100
  saveSystemMessages: false     # Only sync user/assistant messages
  autoSync:
    enabled: false              # Or use /save command
    debounceMs: 5000            # Wait after last change (min: 1s)
    minIntervalMs: 30000        # Min between syncs (min: 5s)
    maxDelayMs: 60000           # Force sync after (min: 10s)
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

When `autoSync.enabled: true`:

1. `ConversationStore.markDirty()` notifies `AutoSyncService`
2. **Debounce**: Waits for activity to settle
3. **Throttle**: Respects minimum interval
4. **Max delay**: Forces sync after timeout

## Module Structure

```
src/persistence/
├── conversation-store.ts    # In-memory store with LRU
├── deduplication.ts         # Message hash deduplication
├── types.ts                 # Core types
├── encryption/
│   └── key-manager.ts       # Master/space key management
└── sync/
    ├── sync-service.ts      # Manual sync to server
    ├── auto-sync.ts         # Automatic sync scheduling
    └── lumo-api-adapter.ts  # REST API client
```

## Key Files

| File | Purpose |
|------|---------|
| [src/persistence/conversation-store.ts](../src/persistence/conversation-store.ts) | In-memory store |
| [src/persistence/sync/sync-service.ts](../src/persistence/sync/sync-service.ts) | Server sync |
| [src/persistence/sync/auto-sync.ts](../src/persistence/sync/auto-sync.ts) | Auto-sync scheduling |
| [src/persistence/encryption/key-manager.ts](../src/persistence/encryption/key-manager.ts) | Key management |
| [src/app/commands.ts](../src/app/commands.ts) | `/save`, `/title` commands |
| [src/proton-shims/lumo-api-client-utils.ts](../src/proton-shims/lumo-api-client-utils.ts) | `postProcessTitle()` |

## Verification

```bash
# Start with persistence + auto-sync
npm run dev

# Send messages
curl -X POST http://localhost:3000/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model": "lumo", "conversation_id": "test-123", "input": "Hello"}'

# Check logs for "Auto-sync completed" or manually /save
# Verify in Proton Lumo WebClient - conversation should appear
```
