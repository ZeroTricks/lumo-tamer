# Lumo Webclient Conversation Persistence

Documentation of how Proton Lumo's webclient persists conversations, based on analysis of `~/WebClients/applications/lumo/src/app/`.

## Architecture Overview

The webclient uses a **three-tier persistence architecture**:

1. **In-memory (Redux)** - Fast access during session
2. **Local storage (IndexedDB)** - Offline-first, encrypted storage
3. **Remote API (`/api/lumo/v1/`)** - Server-side persistence with encryption

```
UI Layer (React Components)
        ↓
Redux State Management (Store + Slices)
        ↓
Saga Middleware (Side Effects & Sync)
        ↓
Dual Storage Backend:
  - IndexedDB (Local)
  - Remote API (Server)
```

## Data Structures

### Space

Container/folder for conversations. Has its own encryption key.

```typescript
type SpacePub = {
    id: SpaceId;           // UUID
    createdAt: string;     // ISO date
};

type SpacePriv = {
    // Reserved for future metadata like title
};

type SpaceKeyClear = {
    spaceKey: Base64;      // HKDF-derived key for encrypting space contents
};

type SpaceKeyEnc = {
    wrappedSpaceKey: Base64;  // AES-KW(spaceKey, masterKey)
};

type Space = SpacePub & SpacePriv & SpaceKeyClear;
type SerializedSpace = SpacePub & Partial<Encrypted> & MaybeSpaceKey & LocalFlags;
```

### Conversation

```typescript
type ConversationPub = {
    id: ConversationId;        // UUID
    spaceId: SpaceId;          // Parent space ID
    createdAt: string;         // ISO date
    starred?: boolean;
};

type ConversationPriv = {
    title: string;             // Generated or user-provided, ENCRYPTED
};

type ConversationExtra = {
    status?: ConversationStatus;  // 'generating' | 'completed'
    ghost?: boolean;              // Transient conversations (not persisted)
};

type Conversation = ConversationPub & ConversationPriv & ConversationExtra;
type SerializedConversation = ConversationPub & Encrypted & LocalFlags;
```

### Message

```typescript
type MessagePub = {
    id: MessageId;                // UUID
    createdAt: string;            // ISO date
    role: Role;                   // 'assistant' | 'user' | 'system' | 'tool_call' | 'tool_result'
    parentId?: MessageId;         // For branching conversations
    conversationId: ConversationId;
    placeholder?: boolean;        // Optimistic UI flag
    status?: Status;              // 'succeeded' | 'failed'
};

type MessagePriv = {
    content?: string;             // ENCRYPTED
    context?: string;             // ENCRYPTED
    attachments?: ShallowAttachment[];
    toolCall?: string;            // Tool invocation data, ENCRYPTED
    toolResult?: string;          // Tool result data, ENCRYPTED
    contextFiles?: AttachmentId[];
};

type Message = MessagePub & MessagePriv;
type SerializedMessage = MessagePub & Partial<Encrypted> & LocalFlags;
```

### Common Types

```typescript
type Role = 'assistant' | 'user' | 'system' | 'tool_call' | 'tool_result';
type Status = 'succeeded' | 'failed';
type ConversationStatus = 'generating' | 'completed';

type LocalFlags = {
    dirty?: boolean;    // Needs sync to server
    deleted?: boolean;  // Soft delete marker
};

type Encrypted = {
    encrypted: EncryptedData;  // JSON "priv" part encrypted with spaceKey
};

type EncryptedData = Base64;  // iv || ciphertext
```

## API Endpoints

Base URL: `/api/lumo/v1/`

### Spaces

| Operation | Endpoint | Method |
|-----------|----------|--------|
| List spaces | `/spaces` | GET |
| Create space | `/spaces` | POST |
| Get space | `/spaces/{id}` | GET |
| Update space | `/spaces/{id}` | PUT |
| Delete space | `/spaces/{id}` | DELETE |
| Delete all spaces | `/spaces` | DELETE |

### Conversations

| Operation | Endpoint | Method |
|-----------|----------|--------|
| Create conversation | `/spaces/{spaceId}/conversations` | POST |
| Get conversation | `/conversations/{id}` | GET |
| Update conversation | `/conversations/{id}` | PUT |
| Delete conversation | `/conversations/{id}` | DELETE |

### Messages

| Operation | Endpoint | Method |
|-----------|----------|--------|
| Create message | `/conversations/{convId}/messages` | POST |
| Get message | `/messages/{id}` | GET |

### Master Keys

| Operation | Endpoint | Method |
|-----------|----------|--------|
| Get master key | `/masterkeys` | GET |
| Create master key | `/masterkeys` | POST |

## API Request/Response Types

### Creating a Conversation

```typescript
type NewConversationToApi = {
    SpaceID: RemoteId;
    IsStarred: boolean;
    Encrypted?: Base64;           // Encrypted ConversationPriv
    ConversationTag: LocalId;     // Local UUID for AEAD
};

// Response contains: { Conversation: { ID: RemoteId, ... } }
```

### Creating a Message

```typescript
type NewMessageToApi = {
    ConversationID: ConversationId;
    Role: RoleInt;                // 1 = User, 2 = Assistant
    ParentId?: RemoteId;
    ParentID?: RemoteId;          // Duplicate for backend compatibility
    Status?: StatusInt;           // 1 = Failed, 2 = Succeeded
    Encrypted?: Base64;           // Encrypted MessagePriv
    MessageTag: LocalId;          // Local UUID for AEAD
};

// Response contains: { Message: { ID: RemoteId, ... } }
```

### Updating a Conversation

```typescript
type ConversationToApi = {
    ID: RemoteId;
    SpaceID: RemoteId;
    IsStarred: boolean;
    Encrypted?: Base64;
    ConversationTag: LocalId;
};
```

## Encryption

### Key Hierarchy

```
User's Private Key (PGP)
        ↓
Master Key (encrypted with PGP, stored on server)
        ↓
Space Key (wrapped with Master Key via AES-KW)
        ↓
Data Encryption Key (derived from Space Key via HKDF)
        ↓
Encrypted Content (AES-GCM with AEAD)
```

### Encryption Process

1. **Master Key**: Retrieved from server, decrypted with user's PGP key
2. **Space Key**: Unwrapped using master key (AES-KW)
3. **Data Encryption Key**: Derived from space key using HKDF
4. **Content Encryption**: AES-GCM with associated data (AEAD)

### Associated Data (AD) Strings

Used for AEAD encryption to bind ciphertext to context:

- Space: `lumo.space.{spaceId}`
- Conversation: `lumo.conversation.{conversationId}`
- Message: `lumo.message.{messageId}`

### Encrypting Private Data

```typescript
// 1. Get space's data encryption key
const spaceDek = await getSpaceDek(space);

// 2. Serialize private data
const privJson = JSON.stringify(messagePriv);

// 3. Encrypt with AEAD
const adString = `lumo.message.${messageId}`;
const encrypted = await encryptString(privJson, spaceDek, adString);

// 4. Store encrypted blob
const serialized: SerializedMessage = {
    ...messagePub,
    encrypted,
};
```

## Sync Mechanism

### Dirty Flag System

```typescript
// When modifying locally:
await dbApi.updateConversation(conversation, { dirty: true });

// After successful server sync:
await dbApi.updateConversation(conversation, { dirty: false });
```

### Sync Flow

1. **Local Change**: Redux action dispatched
2. **Saga Intercepts**: Marks item as `dirty: true` in IndexedDB
3. **Background Sync**: Periodically syncs dirty items to server
4. **Conflict Detection**: Compares local vs remote with deep equality
5. **Resolution**: If unchanged, clears dirty flag; if conflict, retries

### Request Scheduler

- Limits concurrent API requests to 5
- Supports priority-based queueing
- Automatic retry on transient failures

## Ghost Mode

Conversations marked as `ghost: true` are transient and not persisted:

```typescript
if (conversation?.ghost) {
    console.log('Ghost conversation, skipping persistence');
    return; // Don't save to IndexedDB or server
}
```

## ID Mapping

Local IDs (UUIDs generated client-side) are mapped to remote IDs (server-assigned):

```typescript
type IdMapEntry = {
    localId: LocalId;
    remoteId: RemoteId;
    type: 'space' | 'conversation' | 'message' | 'attachment';
};
```

The "tag" fields (SpaceTag, ConversationTag, MessageTag) store local IDs on the server for AEAD encryption purposes.

## Key Files Reference

| File | Purpose |
|------|---------|
| `app/types.ts` | Core data structure definitions |
| `app/remote/api.ts` | Remote API client |
| `app/remote/types.ts` | API request/response types |
| `app/indexedDb/db.ts` | IndexedDB operations |
| `app/redux/slices/core/conversations.ts` | Redux conversation state |
| `app/redux/slices/core/messages.ts` | Redux message state |
| `app/redux/sagas/conversations.ts` | Conversation sync logic |
| `app/redux/sagas/messages.ts` | Message sync logic |
| `app/serialization.ts` | Encryption/decryption helpers |
| `lib/lumo-api-client/core/encryption.ts` | U2L encryption utilities |
| `lib/lumo-api-client/integrations/redux.ts` | Redux integration |

---

# Lumo Bridge Persistence Implementation

This section documents the actual persistence implementation in lumo-bridge.

## Architecture Overview

Lumo-bridge uses a **two-tier persistence architecture**:

1. **In-memory (ConversationStore)** - Active conversations during session
2. **Remote API (LumoPersistenceClient)** - Server-side encrypted persistence

```
API Clients (OpenAI format)
        ↓
ConversationStore (in-memory with LRU eviction)
        ↓
KeyManager (decrypt master key using extracted session keys)
        ↓
LumoPersistenceClient → Lumo API (/api/lumo/v1/)
```

Goal: Share conversations between lumo-bridge and Proton Lumo webclient using the same encryption scheme.

## Configuration

Add to `config.yaml`:

```yaml
persistence:
  enabled: true
  syncInterval: 30000           # ms between sync attempts
  maxConversationsInMemory: 100
  defaultSpaceName: "lumo-bridge"
```

## Module Structure

```
src/persistence/
├── index.ts                    # Public exports
├── types.ts                    # Core types (ConversationId, Message, etc.)
├── conversation-store.ts       # In-memory store with LRU eviction
├── deduplication.ts            # Message hash-based deduplication
├── session-keys.ts             # Decrypt persisted session for mailbox password
├── encryption/
│   ├── index.ts
│   └── key-manager.ts          # Master key & space key management
└── sync/
    ├── index.ts
    └── server-client.ts        # Lumo API client
```

## Setup Flow

### 1. Token Extraction (One-time Setup)

Run the extraction script to get auth tokens + crypto keys:

```bash
npm run extract-token
```

This extracts:
- **Auth tokens** (UID, AccessToken, RefreshToken)
- **Persisted session** blob from localStorage (`ps-{localID}`)
- **ClientKey** from `/auth/v4/sessions/local/key`

Stored in `sessions/auth-tokens.json`:

```typescript
interface ExtendedAuthTokens {
  UID: string;
  AccessToken: string;
  RefreshToken: string;
  persistedSession?: {
    localID: number;
    UserID: string;
    UID: string;
    blob: string;           // Encrypted session blob (base64)
    payloadVersion: 1 | 2;
    persistedAt: number;
    clientKey: string;      // AES key to decrypt blob
  };
}
```

### 2. Key Decryption Flow

When persistence is enabled, the KeyManager performs:

```
1. Load persistedSession from auth tokens
2. Decrypt blob using clientKey → get mailbox password (keyPassword)
3. Fetch user's PGP keys from /core/v4/keys
4. Decrypt PGP private keys using keyPassword
5. Fetch master key from /lumo/v1/masterkeys
6. Decrypt master key using PGP private keys
7. Cache master key for space key operations
```

### 3. Encryption Hierarchy

```
User PGP Key (decrypted with mailbox password)
        ↓
Master Key (PGP-encrypted, fetched from server)
        ↓
Space Key (AES-KW wrapped with master key)
        ↓
Data Encryption Key (HKDF-derived from space key)
        ↓
Content (AES-GCM encrypted with AEAD)
```

## Request Flow (Responses API)

```
1. Request arrives with optional conversation_id or previous_response_id
2. Extract/generate conversationId
3. Persist user message to ConversationStore
4. Convert messages to Turn[] for Lumo chat API
5. Stream/return response from Lumo
6. Persist assistant response to ConversationStore
7. (Background) Sync dirty conversations to server
```

## API Integration

### Conversation ID Resolution

For Responses API (`/v1/responses`):
```typescript
const conversationId = request.conversation_id
    || request.previous_response_id
    || `conv-${randomUUID()}`;
```

For Chat Completions API (`/v1/chat/completions`):
```typescript
const conversationId = request.conversation_id
    || `conv-${randomUUID()}`;
```

### Extended Request Types

```typescript
interface OpenAIResponseRequest {
  // ... standard fields
  previous_response_id?: string;  // OpenAI continuation
  conversation_id?: string;       // Custom extension
}

interface OpenAIChatRequest {
  // ... standard fields
  conversation_id?: string;       // Custom extension
}
```

### Handler Signature

```typescript
async function handleStreamingRequest(
  req: Request,
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIResponseRequest,
  turns: Turn[],
  createdCallIds: Set<string>,
  conversationId?: ConversationId  // NEW
): Promise<void>
```

## Message Deduplication

OpenAI clients send full message history with each request. Deduplication prevents storing duplicates:

```typescript
// Hash each message (role + content)
function hashMessage(msg: IncomingMessage): string {
  return createHash('sha256')
    .update(`${msg.role}:${msg.content}`)
    .digest('hex')
    .slice(0, 16);
}

// Find only new messages at the end of the sequence
function findNewMessages(
  incoming: IncomingMessage[],
  existing: Message[]
): IncomingMessage[]
```

## Conversation Store API

```typescript
class ConversationStore {
  // Get or create a conversation
  getOrCreate(id: ConversationId): ConversationState;

  // Append user messages (with deduplication)
  appendMessages(id: ConversationId, messages: IncomingMessage[]): void;

  // Append assistant response
  appendAssistantResponse(id: ConversationId, content: string): void;

  // Convert to Lumo Turn format
  toTurns(id: ConversationId): Turn[];

  // Mark as synced
  markClean(id: ConversationId): void;

  // Get conversations needing sync
  getDirtyConversations(): ConversationState[];
}
```

## Server Persistence Client

```typescript
class LumoPersistenceClient {
  // Space operations
  listSpaces(): Promise<SpaceFromApi[]>;
  createSpace(request: CreateSpaceRequest): Promise<RemoteId>;
  getSpace(remoteId: RemoteId): Promise<GetSpaceResponse>;
  deleteSpace(remoteId: RemoteId): Promise<void>;

  // Conversation operations
  createConversation(spaceRemoteId: RemoteId, request): Promise<RemoteId>;
  getConversation(remoteId: RemoteId): Promise<GetConversationResponse>;
  updateConversation(request: UpdateConversationRequest): Promise<void>;
  deleteConversation(remoteId: RemoteId): Promise<void>;

  // Message operations
  createMessage(conversationRemoteId: RemoteId, request): Promise<RemoteId>;
  getMessage(remoteId: RemoteId): Promise<MessageFromApi>;
  deleteMessage(remoteId: RemoteId): Promise<void>;
}
```

### Role Mapping

```typescript
const RoleToInt = {
  user: 1,
  assistant: 2,
  system: 1,      // Treat system as user
  tool_call: 2,
  tool_result: 1,
};

const StatusToInt = {
  failed: 1,
  succeeded: 2,
  completed: 2,
  pending: undefined,
  streaming: undefined,
};
```

## Key Files Reference

| File | Purpose |
|------|---------|
| [src/persistence/types.ts](../src/persistence/types.ts) | Core types |
| [src/persistence/conversation-store.ts](../src/persistence/conversation-store.ts) | In-memory store |
| [src/persistence/deduplication.ts](../src/persistence/deduplication.ts) | Message deduplication |
| [src/persistence/session-keys.ts](../src/persistence/session-keys.ts) | Session blob decryption |
| [src/persistence/encryption/key-manager.ts](../src/persistence/encryption/key-manager.ts) | Master/space key management |
| [src/persistence/sync/server-client.ts](../src/persistence/sync/server-client.ts) | Lumo API client |
| [src/proton-shims/crypto.ts](../src/proton-shims/crypto.ts) | PGP operations |
| [src/proton-shims/aesGcm.ts](../src/proton-shims/aesGcm.ts) | AES-GCM/KW operations |
| [src/api/routes/responses/handlers.ts](../src/api/routes/responses/handlers.ts) | Response handlers with persistence |
| [src/config.ts](../src/config.ts) | Persistence config schema |

## Testing

### Deduplication Tests

```bash
npm test -- tests/deduplication.test.ts
```

### Manual Verification

```bash
# 1. Start server with persistence enabled
npm run dev

# 2. Send request with conversation_id
curl -X POST http://localhost:3000/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "lumo",
    "conversation_id": "test-conv-123",
    "input": "Hello, this is a test message"
  }'

# 3. Continue conversation
curl -X POST http://localhost:3000/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "lumo",
    "conversation_id": "test-conv-123",
    "input": "What did I just say?"
  }'

# 4. Check webclient - conversation should appear with history
```

## Sync Service & /save Command

The `SyncService` handles on-demand conversation persistence to the server.

### Setup

Enable in `config.yaml`:
```yaml
persistence:
  enabled: true
  defaultSpaceName: lumo-bridge

auth:
  method: rclone
  rcloneRemote: your-remote-name
```

### Usage

Send `/save` or `/sync` as a message to trigger sync:
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "lumo", "messages": [{"role": "user", "content": "/save"}]}'
```

### How It Works

1. **Space Creation**: On first sync, creates a space on the server (or reuses existing)
2. **Encryption**: Messages encrypted with AES-GCM using space-derived DEK
3. **AEAD**: Uses `lumo.conversation.{id}` and `lumo.message.{id}` as associated data

### Key Files

| File | Purpose |
|------|---------|
| [src/persistence/sync/sync-service.ts](../src/persistence/sync/sync-service.ts) | SyncService with space creation and conversation sync |
| [src/api/commands.ts](../src/api/commands.ts) | `/save` command handler |

## Future Work

- [ ] Background sync coordinator with configurable interval
- [x] Space creation on first conversation
- [x] Full content encryption before server sync
- [x] Chat completions API integration (command context)
- [ ] Client-side conversation search
