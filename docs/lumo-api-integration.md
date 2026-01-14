# Lumo-Bridge Rewrite Strategy: DOM Automation → Direct API Integration

## Executive Summary

This document outlines an exploratory strategy for rewriting lumo-bridge to use Proton Lumo's internal client logic instead of browser DOM automation. The current implementation uses Playwright to interact with the Lumo web UI, while the proposed approach would integrate Proton's TypeScript API client directly into Node.js.

**Current State:** Browser-based DOM automation (Playwright + CDP) **Proposed State:** Direct API integration using Proton's internal client code **Status:** Exploratory phase - evaluating feasibility and trade-offs

---

## Current Architecture Analysis

### How Lumo-Bridge Currently Works

```
Client Request → Express API → Queue → Playwright/CDP → DOM Manipulation → Response Parsing
                                              ↓
                                    Chrome Browser (remote)
                                              ↓
                                    https://lumo.proton.me
```

**Technology Stack:**

- **Frontend:** Express.js API server ([src/api/](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/api/))
- **Backend:** Playwright browser automation ([src/browser/](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/browser/))
- **Communication:** Chrome DevTools Protocol (CDP)
- **Browser:** Remote Chromium instance in Docker container

**Key Files:**

- [src/browser/manager.ts](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/browser/manager.ts) - Browser lifecycle, CDP connection (115 lines)
- [src/browser/chatbox.ts](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/browser/chatbox.ts) - Message send/receive, streaming (340 lines)
- [src/browser/tools.ts](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/browser/tools.ts) - Tool call extraction (82 lines)
- [src/browser/sources.ts](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/browser/sources.ts) - Source extraction (98 lines)
- [src/api/routes/chat-completions.ts](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/api/routes/chat-completions.ts) - OpenAI API endpoint (93 lines)

### Current Architecture Strengths

1. **Visual Debugging**: noVNC access allows seeing browser state
2. **No API Reverse Engineering**: Uses official web UI
3. **Automatic UI Updates**: Works when Proton updates frontend
4. **Session Persistence**: Browser profile maintains authentication
5. **Simple Authentication**: Login via browser UI, session auto-persists

### Current Architecture Weaknesses

1. **Browser Dependency**: Requires Chromium + Playwright (\~800MB)
2. **Fragile Selectors**: 15+ CSS selectors that break on UI changes
3. **Performance Overhead**: Full browser + DOM rendering for text I/O
4. **Resource Usage**: High memory (browser process + page rendering)
5. **Single Instance**: One browser connection limits scalability
6. **Completion Detection**: Relies on SVG icon selector that could change
7. **Two Runtime Contexts**: Node.js app + Browser (communication overhead)

---

## Proposed Architecture: Direct API Integration

### Vision

```
Client Request → Express API → Queue → Lumo API Client → Proton Backend
                                              ↓
                              Encryption/Decryption (Node.js)
                                              ↓
                              Stream Processing (SSE)
```

**Technology Stack:**

- **Frontend:** Same Express.js API
- **Backend:** Proton's `LumoApiClient` (TypeScript, extracted from WebClients)
- **Communication:** Direct HTTPS to Proton's API endpoints
- **Encryption:** `@proton/crypto` library for E2E encryption

### What We Would Gain

1. **No Browser Required**: Eliminate Chromium + Playwright dependencies
2. **Single Runtime Context**: Pure Node.js execution
3. **Better Performance**: Direct API calls, no DOM overhead
4. **Production-Tested Code**: Reuse Proton's official client logic
5. **Type Safety**: Full TypeScript types from source
6. **Cleaner Architecture**: API client → Express → OpenAI format
7. **Scalability**: Multiple concurrent requests possible
8. **Smaller Footprint**: \~50MB vs \~800MB Docker image

### What We Would Lose

1. **Visual Debugging**: No browser UI to inspect
2. **Authentication UI**: Need programmatic login flow
3. **Automatic UI Adaptation**: Must track Proton's API changes
4. **Session Management Simplicity**: Need to handle tokens/sessions explicitly

---

## Proton WebClients Analysis

### Reusable Components from `/tmp/WebClients/applications/lumo/`

#### 1. **API Client Core** (Ready to Use)

**Location:** `src/app/lib/lumo-api-client/core/`

**Components:**

- **client.ts** (472 lines) - Main `LumoApiClient` class with streaming
- **encryption.ts** (69 lines) - E2E encryption functions (User-to-Lumo)
- **streaming.ts** (83 lines) - SSE parser for `data:` prefixed chunks
- **request-builder.ts** (264 lines) - Fluent API for building requests
- **types.ts** (197 lines) - TypeScript interfaces

**Key Methods:**

```typescript
class LumoApiClient {
  async callAssistant(api: Api, turns: Turn[], options): Promise<void>
  async quickChat(api: Api, message: string, options): Promise<string>
  createRequest(): RequestBuilder
  addRequestInterceptor(interceptor)
  addResponseInterceptor(interceptor)
}
```

**Reusability:** **HIGH** - Minimal dependencies, framework-agnostic

#### 2. **Encryption Layer** (Copy-Paste Ready)

**Key Functions:**

```typescript
generateRequestKey() → AesGcmCryptoKey
generateRequestId() → UUID
encryptTurns(turns, requestKey, requestId) → EncryptedTurn[]
prepareEncryptedRequestKey(requestKey, lumoPubKey) → Base64
decryptContent(encryptedBase64, requestKey, adString) → string
```

**Encryption Scheme:**

- **Algorithm:** AES-GCM-256 with AEAD
- **Key Generation:** Ephemeral per-request
- **Key Exchange:** PGP-encrypted with Lumo's public key
- **Associated Data:** `lumo.request.{requestId}.turn` / `lumo.response.{requestId}.chunk`

**Only Dependency:** `@proton/crypto` (available as npm package)

#### 3. **Stream Processing** (Zero Dependencies)

**Class:** `StreamProcessor`

**Purpose:** Parse SSE format with incomplete line handling

```typescript
processChunk(chunk: string): GenerationToFrontendMessage[]
finalize(): GenerationToFrontendMessage[]
```

**Reusability:** **HIGH** - Pure TypeScript, no external deps

#### 4. **API Communication Pattern**

**Endpoint:** `POST /api/v1/ai/chat`

**Request Structure:**

```typescript
{
  Prompt: {
    type: 'generation_request',
    turns: Turn[],                    // Encrypted if U2L enabled
    options: { tools?: ToolName[] },
    targets: ['message'] | ['message', 'title'],
    request_key?: Base64,             // PGP-encrypted AES key
    request_id?: UUID                 // For AEAD encryption
  }
}
```

**Response Format:** Server-Sent Events (SSE)

```typescript
data: {"type":"queued"}
data: {"type":"ingesting","target":"message"}
data: {"type":"token_data","target":"message","content":"Hello","encrypted":true}
data: {"type":"token_data","target":"message","content":" world"}
data: {"type":"done"}
```

**Message Types:**

- `queued` - Request accepted
- `ingesting` - Processing started
- `token_data` - Streaming text chunk (may be encrypted)
- `done` - Generation complete
- `error` / `rejected` / `harmful` / `timeout` - Error states

### Dependencies Analysis

#### Required for Integration:

| Package          | Purpose                  | Node.js Compatible | Size   |
|------------------|--------------------------|--------------------|--------|
| `@proton/crypto`   | PGP + AES-GCM encryption | ✅ Yes              | \~2MB   |
| `uuid`             | UUID generation          | ✅ Yes              | \~50KB  |
| `@msgpack/msgpack` | Binary encoding          | ✅ Yes              | \~100KB |

#### Not Needed (Browser-Specific):

- `react`, `react-dom` - UI framework
- `react-redux`, `redux-saga` - State management
- `@tiptap/react` - Rich text editor
- `IndexedDB`, `localStorage` - Client storage

**Total New Dependencies:** \~2.2MB (vs 800MB for Chromium)

---

## Integration Strategies

### Strategy A: Full Client Integration (Recommended)

**Approach:** Copy Proton's API client core and adapt network layer

**Implementation Steps:**

1. **Copy from** `/tmp/WebClients/applications/lumo/`**:**
   - `lib/lumo-api-client/core/` → `src/proton/lumo-api-client/`
   - `crypto/` utilities → `src/proton/crypto/`
   - `types.ts`, `types-api.ts` → `src/proton/types/`
2. **Create Network Adapter:**

   ```typescript
   // src/proton/network-adapter.ts
   class NodeFetchAdapter implements ProtonApiInterface {
     constructor(private authToken: string, private baseUrl: string) {}
   
     async post(endpoint: string, payload: any, options?: RequestOptions): Promise<ReadableStream> {
       const response = await fetch(`${this.baseUrl}/${endpoint}`, {
         method: 'POST',
         headers: {
           'Authorization': `Bearer ${this.authToken}`,
           'Content-Type': 'application/json',
         },
         body: JSON.stringify(payload),
         signal: options?.signal,
       });
   
       return response.body!;
     }
   }
   ```
3. **Integrate with Express API:**

   ```typescript
   // src/api/routes/chat-completions.ts (replace chatbox interaction)
   import { LumoApiClient } from '@/proton/lumo-api-client';
   
   const client = new LumoApiClient({
     enableU2LEncryption: true,
     lumoPubKey: LUMO_GPG_PUB_KEY_PROD_2,
   });
   
   const turns = extractTurns(req.body.messages);
   
   await client.callAssistant(adapter, turns, {
     chunkCallback: (chunk) => {
       // Stream to client via SSE
       res.write(formatSSE(chunk));
     },
   });
   ```

**Files to Modify:**

- [src/api/routes/chat-completions.ts](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/api/routes/chat-completions.ts) - Replace browser calls
- [src/api/routes/responses.ts](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/api/routes/responses.ts) - Replace browser calls
- Delete entire [src/browser/](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/browser/) directory
- Update [docker-compose.yml](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/docker-compose.yml) - Remove browser service

**Estimated Code Changes:** \~300 lines (mostly network adapter + integration)

**Benefits:**

- Production-tested streaming logic
- Built-in encryption/decryption
- Interceptor system for extensibility
- Type-safe API

**Challenges:**

- Authentication (see Strategy B below)
- Network adapter must match Proton's `Api` interface
- Possible API endpoint changes over time

---

### Strategy B: Authentication Solutions

#### Current Problem

Browser-based auth works automatically:

1. User logs into Lumo via browser UI (manual, one-time)
2. Chromium persists cookies/session in profile
3. All subsequent requests authenticated automatically

**Without browser:** Need programmatic authentication

#### Proton Authentication Architecture (Research Summary)

**Protocol:** SRP (Secure Remote Password) - never transmits actual password **Official Library:** `go-proton-api` (Go) - used by proton-bridge **Existing Solutions:** proton-bridge, hydroxide, rclone (all in Go)

**Full Authentication Flow:**

1. Get auth info (modulus, SRP session, salt, version) → `POST /core/v4/auth/info`
2. Compute SRP proof using client-side crypto
3. Send SRP authentication → `POST /core/v4/auth`
4. Handle 2FA if enabled (TOTP/FIDO2) → `POST /core/v4/auth/2fa`
5. Handle CAPTCHA if triggered (hCaptcha) → requires browser interaction
6. Receive AccessToken + RefreshToken + UID
7. Store tokens securely (OS keychain in proton-bridge)

**Session Management:**

- **AccessToken:** Short-lived (hours-days), used for API calls
- **RefreshToken:** Long-lived (weeks-months), used to get new access tokens
- **UID:** User session identifier
- **Refresh:** `POST /auth/refresh` with RefreshToken

**Challenges:**

- **SRP Implementation:** Complex cryptographic protocol
- **CAPTCHA:** Requires browser interaction (hCaptcha can't be automated)
- **2FA:** TOTP can be automated, FIDO2 requires hardware
- **Rate Limiting:** Aggressive abuse detection (429 errors, CAPTCHA triggers)

#### Option B1: Session Token Extraction (Recommended for PoC)

**Approach:** Extract auth tokens from existing browser session

**Implementation:**

```typescript
// 1. Use Playwright ONE TIME to login and extract tokens
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

// Login flow (could be automated with credentials)
await page.goto('https://lumo.proton.me');
await page.pause(); // User logs in manually (handles CAPTCHA, 2FA, etc.)

// Extract session state
const state = await context.storageState();
fs.writeFileSync('session-state.json', JSON.stringify(state));

// 2. Parse cookies for auth token (UID, AccessToken)
const cookies = state.cookies;
const authCookies = {
  uid: cookies.find(c => c.name === 'UID')?.value,
  accessToken: cookies.find(c => c.name === 'AUTH')?.value, // Example - actual name TBD
  refreshToken: cookies.find(c => c.name === 'REFRESH')?.value,
};

// 3. Use tokens in Node.js app (no browser needed after this)
const adapter = new NodeFetchAdapter(authCookies, 'https://lumo.proton.me/api');
```

**Token Lifespan:**

- AccessToken: Hours to days (needs testing)
- RefreshToken: Weeks to months

**Refresh Strategy:**

```typescript
async refreshAccessToken(refreshToken: string): Promise<AuthTokens> {
  const response = await fetch('https://lumo.proton.me/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ResponseType: 'token',
      GrantType: 'refresh_token',
      RefreshToken: refreshToken,
      RedirectURI: 'https://protonmail.com',
    }),
  });

  const data = await response.json();
  return {
    accessToken: data.AccessToken,
    refreshToken: data.RefreshToken,
    uid: data.UID,
    expiresIn: data.ExpiresIn,
  };
}
```

**Benefits:**

- Simple one-time extraction
- No password storage
- Works with CAPTCHA and MFA (handled in browser)
- Can implement automatic refresh

**Challenges:**

- Tokens eventually expire (need refresh mechanism)
- Manual step required initially
- Token storage security

#### Option B2: Use Existing Authentication Client (Best Long-Term)

**Approach:** Leverage proton-bridge or go-proton-api for authentication

**Option B2a: Integrate go-proton-api (via IPC)**

```typescript
// 1. Call go-proton-api binary as subprocess
import { spawn } from 'child_process';

class ProtonAuthClient {
  async authenticate(username: string, password: string, totp?: string): Promise<AuthSession> {
    // Execute go-proton-api auth script
    const proc = spawn('./bin/proton-auth', [username, password, totp || '']);

    // Parse JSON response with AccessToken, RefreshToken, UID
    const result = await parseAuthResult(proc);
    return result;
  }
}
```

**Implementation Options:**

- **Embed go-proton-api:** Include compiled binary in Docker image
- **Go → Node.js Bridge:** Small Go service exposing HTTP auth endpoint
- **Port to TypeScript:** Reimplement SRP in Node.js (complex)

**Benefits:**

- Production-tested authentication
- Official Proton library
- Handles SRP complexity
- 2FA support (TOTP)

**Challenges:**

- Inter-process communication
- Still requires interactive CAPTCHA solving (browser fallback)
- Go dependency in TypeScript project

**Option B2b: Use proton-bridge Session**

```typescript
// 1. User runs proton-bridge separately
// 2. Extract session tokens from proton-bridge
// 3. Reuse tokens in lumo-bridge

// proton-bridge stores credentials in OS keychain
// Could export session state and import into lumo-bridge
```

**Benefits:**

- Reuse existing official tool
- No custom auth implementation
- Handles all edge cases

**Challenges:**

- Requires proton-bridge running
- May not expose session tokens easily
- Designed for email bridge, not general purpose

#### Option B3: Port SRP to TypeScript (Most Complex)

**Approach:** Reimplement Proton's SRP authentication in TypeScript

**Components Available in WebClients:**

- SRP library: `/tmp/WebClients/packages/srp/lib/`
- Password hashing: `/tmp/WebClients/packages/srp/lib/passwords.ts`
- Auth API calls: `/tmp/WebClients/packages/shared/lib/api/auth.ts`
- Session management: `/tmp/WebClients/packages/shared/lib/authentication/`

**Implementation:**

```typescript
// 1. Extract SRP from WebClients
import { getSrp } from '@/proton/srp';
import { getInfo, auth } from '@/proton/api/auth';

async function authenticateWithSRP(username: string, password: string): Promise<AuthSession> {
  // 1. Get auth info
  const info = await fetch('https://lumo.proton.me/core/v4/auth/info', {
    method: 'POST',
    body: JSON.stringify({ Username: username }),
  }).then(r => r.json());

  // 2. Compute SRP proof
  const { expectedServerProof, clientProof, clientEphemeral } =
    await getSrp(info, { username, password }, info.Version);

  // 3. Authenticate
  const authResponse = await fetch('https://lumo.proton.me/core/v4/auth', {
    method: 'POST',
    body: JSON.stringify({
      Username: username,
      ClientProof: clientProof,
      ClientEphemeral: clientEphemeral,
      SRPSession: info.SRPSession,
    }),
  }).then(r => r.json());

  // 4. Validate server proof
  if (authResponse.ServerProof !== expectedServerProof) {
    throw new Error('Server proof mismatch - possible MITM attack');
  }

  return {
    accessToken: authResponse.AccessToken,
    refreshToken: authResponse.RefreshToken,
    uid: authResponse.UID,
  };
}
```

**CAPTCHA Handling:**

```typescript
// If CAPTCHA triggered (error code 2000)
if (response.Code === 2000 && response.Details?.HumanVerificationToken) {
  // Fallback to browser for CAPTCHA
  const captchaToken = await solveCaptchaWithBrowser(response.Details);

  // Retry auth with captcha token
  headers['X-PM-Human-Verification-Token'] = captchaToken;
  headers['X-PM-Human-Verification-Token-Type'] = 'captcha';
}
```

**Benefits:**

- Pure TypeScript implementation
- No Go dependencies
- Full control over auth flow

**Challenges:**

- Must port SRP library (complex crypto)
- CAPTCHA still requires browser fallback
- 2FA TOTP requires additional library
- FIDO2 not feasible without browser
- High maintenance burden

#### Option B4: Hybrid Approach (Pragmatic)

**Approach:** Use browser for initial auth + CAPTCHA, API client for everything else

**Architecture:**

```
Initial Login (Browser) → Extract Tokens → Store Securely
                              ↓
                    Node.js API Client (with tokens)
                              ↓
                    Token Refresh (API endpoint)
                              ↓
                    CAPTCHA Needed? → Browser Fallback
```

**Implementation:**

```typescript
class HybridAuthManager {
  private authToken: string | null = null;
  private refreshToken: string | null = null;
  private uid: string | null = null;

  async ensureAuthenticated(): Promise<AuthSession> {
    // 1. Try cached token
    if (this.authToken && !isExpired(this.authToken)) {
      return { accessToken: this.authToken, uid: this.uid! };
    }

    // 2. Try refresh
    if (this.refreshToken) {
      try {
        const refreshed = await this.refreshAccessToken(this.refreshToken);
        this.authToken = refreshed.accessToken;
        this.refreshToken = refreshed.refreshToken;
        return refreshed;
      } catch (error) {
        // Refresh failed, fall through to browser
      }
    }

    // 3. Fallback to browser-based auth
    return await this.authenticateWithBrowser();
  }

  private async authenticateWithBrowser(): Promise<AuthSession> {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ storageState: 'session.json' });
    const page = await context.newPage();

    await page.goto('https://lumo.proton.me');

    // Wait for login (user handles CAPTCHA, 2FA)
    await page.waitForURL(/lumo\.proton\.me\/(chat|settings)/, { timeout: 120000 });

    // Extract tokens
    const state = await context.storageState();
    const tokens = this.extractTokens(state);

    await browser.close();

    return tokens;
  }
}
```

**Benefits:**

- Best of both worlds
- Graceful degradation
- Handles all edge cases (CAPTCHA, 2FA, etc.)
- Can migrate to pure API over time

**Challenges:**

- Still requires browser dependency (lighter usage)
- More complex architecture

#### Recommended Approach for Lumo-Bridge

**Phase 1 (PoC):** Option B1 - Token Extraction

- Simple, fast to implement
- Validates API client works
- Defer auth complexity

**Phase 2 (Production):** Option B4 - Hybrid Approach

- Browser for initial auth only
- API for token refresh
- Browser fallback for CAPTCHA
- Most robust long-term solution

**Future (Optional):** Option B2a - go-proton-api Integration

- If browser dependency must be eliminated
- Only after PoC proves API approach viable

---

### Strategy C: Minimal Integration (Fastest to Test)

**Approach:** Extract only encryption + streaming, implement custom API client

**Implementation:**

1. **Copy minimal components:**
   - `encryption.ts` + crypto utilities
   - `streaming.ts` (SSE parser)
   - Type definitions
2. **Implement simple API client:**

   ```typescript
   // src/api/lumo-client.ts
   class SimpleLumoClient {
     async chat(message: string, onChunk: (text: string) => void): Promise<void> {
       // 1. Encrypt message
       const requestKey = await generateRequestKey();
       const requestId = generateRequestId();
       const encryptedTurns = await encryptTurns([{ role: 'user', content: message }], requestKey, requestId);
       const requestKeyEncB64 = await prepareEncryptedRequestKey(requestKey, LUMO_PUB_KEY);
   
       // 2. Send request
       const response = await fetch('https://lumo.proton.me/api/v1/ai/chat', {
         method: 'POST',
         headers: {
           'Authorization': `Bearer ${this.authToken}`,
           'Content-Type': 'application/json',
         },
         body: JSON.stringify({
           Prompt: {
             type: 'generation_request',
             turns: encryptedTurns,
             targets: ['message'],
             request_key: requestKeyEncB64,
             request_id: requestId,
           }
         }),
       });
   
       // 3. Stream response
       const reader = response.body!.getReader();
       const processor = new StreamProcessor();
   
       while (true) {
         const { done, value } = await reader.read();
         if (done) break;
   
         const chunks = processor.processChunk(new TextDecoder().decode(value));
         for (const chunk of chunks) {
           if (chunk.type === 'token_data') {
             const decrypted = chunk.encrypted
               ? await decryptContent(chunk.content, requestKey, `lumo.response.${requestId}.chunk`)
               : chunk.content;
             onChunk(decrypted);
           }
         }
       }
     }
   }
   ```

**Estimated Code:** \~200 lines

**Benefits:**

- Minimal dependencies
- Full control over implementation
- Easy to understand

**Challenges:**

- Missing production features (interceptors, retries, etc.)
- Must implement request building from scratch
- Less battle-tested

---

## Critical Unknowns & Research Needed

### 1. API Endpoint Stability

**Question:** Are Proton's internal API endpoints stable?

**Risk:** Endpoints could change without notice (no public API contract)

**Mitigation:**

- Monitor Proton's WebClients repository for changes
- Implement version detection
- Keep browser automation as fallback

### 2. Authentication Token Lifespan

**Question:** How long do Proton Lumo auth tokens last?

**Research Needed:**

- Extract token and test expiration
- Check for refresh token mechanisms
- Understand session renewal

**Test Plan:**

1. Extract auth token via Playwright
2. Use token in Node.js for 1 hour, 24 hours, 7 days
3. Document when 401 errors occur
4. Reverse-engineer refresh mechanism

### 3. Rate Limiting & Terms of Service

**Question:** Does direct API usage violate Proton's ToS?

**Considerations:**

- Current browser automation also uses their service
- Direct API calls are more efficient (less server load)
- Personal use vs commercial use implications

**Recommendation:** Clarify intended use case (personal project, research, production service)

### 4. Encryption Edge Cases

**Question:** Are all responses encrypted, or only some?

**Observation:** Response chunks have `encrypted: boolean` field

**Test Needed:**

- Send requests with U2L encryption disabled
- Compare response formats
- Understand when encryption is mandatory

### 5. Tool Calls & Function Calling

**Question:** How does Proton handle tool calls in direct API?

**Current State:** DOM extraction from `<pre>` elements

**Research:**

- Check if tool calls appear in SSE stream
- Test with `options: { tools: ['web_search', 'code_interpreter'] }`
- Document API format for function calling

### 6. Web Search Sources

**Question:** How are sources returned in API responses?

**Current State:** Extracted by clicking source icons in DOM

**Research:**

- Check for `sources` field in API response
- Test web search enabled requests
- Document source format

---

## Migration Path: Phased Approach

### Phase 0: Research (Current Phase)

**Goals:**

- ✅ Understand current architecture
- ✅ Explore Proton WebClients codebase
- ✅ Identify reusable components
- ⏳ Test critical unknowns (auth token extraction, API stability)

**Deliverables:**

- This strategy document
- Decision on viability

### Phase 1: Proof of Concept (3-5 days)

**Goals:**

- Extract auth token from browser session
- Implement minimal API client (Strategy C)
- Send single request and receive streaming response
- Verify encryption/decryption works

**Success Criteria:**

- Node.js script sends "Hello" to Lumo
- Receives streaming response
- No browser involved (except initial token extraction)

**Files to Create:**

- `src/proton/crypto/` - Copy encryption utilities
- `src/proton/streaming.ts` - Copy SSE parser
- `src/proton/simple-client.ts` - Minimal API client
- `scripts/extract-auth-token.ts` - Playwright script for token extraction

**Test Command:**

```bash
npm run extract-token  # One-time: extract from browser
node scripts/poc-test.js "What is 2+2?"  # Test direct API
```

### Phase 2: Full Client Integration (5-7 days)

**Goals:**

- Copy full `LumoApiClient` from Proton
- Implement network adapter
- Replace browser calls in chat-completions route
- Handle streaming responses properly

**Files to Modify:**

- [src/api/routes/chat-completions.ts](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/api/routes/chat-completions.ts)
- [src/api/routes/responses.ts](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/api/routes/responses.ts)
- Create `src/proton/` directory structure

**Success Criteria:**

- OpenAI-compatible API works without browser
- Streaming responses format correctly
- Multi-turn conversations work

### Phase 3: Feature Parity (5-7 days)

**Goals:**

- Implement tool call extraction from API
- Implement source extraction from API
- Handle all message types (system, tool, etc.)
- Implement behavior/instructions management

**Success Criteria:**

- All current features work (tools, sources, instructions)
- Test suite passes
- Performance equal or better than DOM automation

### Phase 4: Authentication Robustness (3-5 days)

**Goals:**

- Implement token refresh mechanism
- Handle 401 errors gracefully
- Add token expiration detection
- Document authentication flow

**Success Criteria:**

- Tokens refresh automatically when expired
- No manual intervention needed after initial setup
- Clear documentation for setup

### Phase 5: Production Hardening (5-7 days)

**Goals:**

- Error handling for all edge cases
- Logging and observability
- Fallback mechanisms
- Docker image optimization
- Documentation update

**Success Criteria:**

- Robust error handling
- Clear logging for debugging
- Docker image < 100MB (vs current 800MB)
- Updated README and docs

**Total Estimated Time:** 21-31 days of development

---

## Decision Matrix

### Should We Proceed with Rewrite?

| Factor           | Browser Automation        | Direct API              | Weight | Winner    |
|------------------|---------------------------|-------------------------|--------|-----------|
| **Resource Usage**   | \~800MB Docker image       | \~50MB Docker image      | High   | API ✅     |
| **Performance**      | High latency (browser)    | Low latency (direct)    | High   | API ✅     |
| **Maintenance**      | Selector updates needed   | API changes possible    | Medium | Tie       |
| **Debugging**        | Visual browser inspection | Log-based only          | Medium | Browser ✅ |
| **Scalability**      | Single instance           | Multiple concurrent     | High   | API ✅     |
| **Setup Complexity** | Simple (automated)        | Token extraction needed | Medium | Browser ✅ |
| **Authentication**   | Automatic persistence     | Manual token management | High   | Browser ✅ |
| **Code Complexity**  | Medium (\~600 LOC)         | Medium (\~500 LOC)       | Low    | Tie       |
| **Dependencies**     | Playwright + Chromium     | @proton/crypto          | Medium | API ✅     |
| **Reliability**      | UI breakage risk          | API change risk         | High   | Tie       |
| **ToS Compliance**   | Uses official UI          | Uses internal API       | High   | Browser ✅ |

**Weighted Score:**

- **Browser Automation:** 55/100
- **Direct API Integration:** 65/100

**Recommendation:** Proceed with **Proof of Concept** (Phase 1) to validate critical unknowns before committing to full rewrite.

---

## Risks & Mitigation

### Risk 1: Auth Token Extraction Fails

**Likelihood:** Low **Impact:** High (blocks entire approach) **Mitigation:** Test immediately in Phase 1; fallback to hybrid approach

### Risk 2: API Endpoints Change

**Likelihood:** Medium **Impact:** High (breaks integration) **Mitigation:**

- Monitor Proton's GitHub for updates
- Implement version detection
- Keep browser automation code as fallback

### Risk 3: Terms of Service Violation

**Likelihood:** Low-Medium **Impact:** High (legal/ethical) **Mitigation:**

- Clarify with Proton (if possible)
- Document as personal/research use
- Consider keeping current approach if commercial

### Risk 4: Encryption Complexity

**Likelihood:** Low **Impact:** Medium (debugging difficulty) **Mitigation:**

- Copy Proton's tested encryption code exactly
- Add extensive logging
- Test with encryption disabled first

### Risk 5: Missing Features in API

**Likelihood:** Medium **Impact:** Medium (feature gaps) **Mitigation:**

- Test all features in PoC phase
- Document gaps
- Decide if acceptable trade-off

### Risk 6: Token Refresh Mechanism Unknown

**Likelihood:** Medium **Impact:** High (manual intervention needed) **Mitigation:**

- Implement hybrid approach (fallback to browser for refresh)
- Research Proton's token lifecycle
- Add monitoring for 401 errors

---

## Open Questions for User

Before proceeding to Phase 1 (Proof of Concept), please clarify:

### 1. **Use Case & Risk Tolerance**

**Question:** Is this project for:

- [ ]  Personal use only
- [ ]  Open-source project
- [ ]  Commercial service
- [ ]  Research/educational

**Impact:** Affects ToS risk assessment and authentication approach

### 2. **Authentication Preference**

**Question:** Which authentication approach do you prefer?

- [ ]  **Option A:** Token extraction (simple, requires one-time browser use)
- [ ]  **Option B:** Hybrid approach (minimal browser for auth, API for chat)
- [ ]  **Option C:** Full programmatic auth (complex, higher risk)

**Trade-offs:** Simplicity vs full browser elimination

### 3. **Fallback Strategy**

**Question:** If direct API integration fails or breaks, should we:

- [ ]  Keep browser automation code as fallback (maintain both)
- [ ]  Commit fully to API approach (delete browser code)
- [ ]  Make it configurable (runtime selection)

**Impact:** Code maintenance burden

### 4. **Timeline & Priority**

**Question:** What's your timeline?

- [ ]  Exploratory (no rush, can take time to research)
- [ ]  Moderate (2-4 weeks for full migration)
- [ ]  Urgent (need decision quickly)

**Impact:** Affects whether to do thorough PoC or commit to approach

### 5. **Success Criteria**

**Question:** What would make this rewrite successful for you?

- [ ]  Eliminate browser dependency entirely
- [ ]  Reduce resource usage (Docker image size, memory)
- [ ]  Improve performance (latency, throughput)
- [ ]  Learning experience (understand Proton's API)
- [ ]  All of the above

**Impact:** Defines acceptable trade-offs

---

## Recommended Next Steps

### Immediate Actions (This Week)

1. **Answer Open Questions** (above)
2. **Test Token Extraction:**

   ```bash
   # Use current Playwright setup to extract auth tokens
   npm run extract-token
   # Test token validity over 24-48 hours
   ```
3. **Verify API Endpoint:**

   ```bash
   # Use extracted token to make direct API call
   curl -X POST https://lumo.proton.me/api/v1/ai/chat \
     -H "Authorization: Bearer $TOKEN" \
     -d '{"Prompt": {...}}'
   ```

### Phase 1 PoC (Next 1-2 Weeks)

If token extraction succeeds:

1. Implement minimal API client (Strategy C)
2. Test with simple message: "What is 2+2?"
3. Verify streaming response works
4. Document any gaps or issues
5. **Decision Point:** Proceed with full rewrite or keep current approach?

### Communication Plan

After PoC completion, share:

- [ ]  Token extraction success/failure
- [ ]  API call success/failure
- [ ]  Streaming response quality
- [ ]  Encryption/decryption verification
- [ ]  List of discovered issues
- [ ]  Go/No-Go recommendation

---

## Conclusion & Updated Recommendations

The direct API integration approach is **highly feasible** based on:

1. ✅ Proton's well-architected client code (LumoApiClient is production-ready)
2. ✅ Existing authentication solutions (go-proton-api, proton-bridge)
3. ✅ Clear API patterns and encryption schemes
4. ⚠️ Authentication complexity (SRP, CAPTCHA, 2FA)

### Key Findings from Research

**What's Easier Than Expected:**

- Proton's LumoApiClient is highly reusable (\~1,500 LOC ready to copy)
- Encryption/decryption is well-documented and framework-agnostic
- Stream processing is pure TypeScript with zero dependencies
- API endpoints are well-structured (SSE format)

**What's More Complex Than Expected:**

- Authentication uses SRP (Secure Remote Password) protocol
- CAPTCHA handling requires browser interaction (can't be fully automated)
- Proton has aggressive abuse detection (rate limiting, bot detection)
- Token lifecycle needs investigation (unknown expiration times)

### Recommended Implementation Strategy

**Phase 1: Proof of Concept (1-2 weeks)**

- **Auth:** Token extraction (Option B1) - one-time browser use
- **API Client:** Minimal implementation (Strategy C) - \~200 lines
- **Goal:** Validate end-to-end flow without browser

**Success Criteria:**

1. Extract auth tokens from browser session
2. Send message to Lumo via direct API call
3. Receive streaming response
4. Decrypt encrypted chunks
5. Measure token lifespan (24+ hours)

**Phase 2: Full Integration (2-3 weeks)**

- **Auth:** Hybrid approach (Option B4) - browser fallback for auth/CAPTCHA
- **API Client:** Full LumoApiClient integration (Strategy A)
- **Goal:** Feature parity with current implementation

**Components to Integrate:**

1. Copy from `/tmp/WebClients/applications/lumo/`:
   - `lib/lumo-api-client/core/` → Complete API client
   - `crypto/` utilities → Encryption helpers
   - Type definitions → Full type safety
2. Create adapters:
   - Network adapter (Node.js fetch → Proton Api interface)
   - Auth manager (token extraction + refresh)
3. Replace in lumo-bridge:
   - [src/api/routes/chat-completions.ts](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/api/routes/chat-completions.ts) - Use LumoApiClient
   - [src/api/routes/responses.ts](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/api/routes/responses.ts) - Use LumoApiClient
   - Delete [src/browser/](vscode-webview://02ah3alko044g319nqiu3tf1c4s7v8kfk9tu315v21nudviakaf5/src/browser/) (except auth helper)

**Phase 3: Production Hardening (1-2 weeks)**

- Token refresh mechanism
- Error handling (429, CAPTCHA triggers, network errors)
- Fallback strategies
- Documentation

### What Can Be Eliminated

**Can Remove (After PoC Success):**

- ✅ Playwright browser automation (except auth)
- ✅ 15+ CSS selectors (selector maintenance)
- ✅ DOM mutation observers
- ✅ Browser Docker container (for chat operations)
- ✅ \~700MB of browser dependencies

**Must Keep (For Robustness):**

- ⚠️ Minimal browser for auth (CAPTCHA, initial login)
- ⚠️ Playwright dependency (lighter usage)
- ⚠️ Session state management

**Net Reduction:**

- Docker image: \~800MB → \~150MB (playwright-core only)
- Runtime memory: \~500MB → \~100MB
- Startup time: \~10s → \~2s

### Open Questions (To Answer in PoC)

1. **Token Lifespan:**
   - How long do AccessTokens last? (hours, days, weeks?)
   - How long do RefreshTokens last?
   - What's the refresh mechanism?
2. **Cookie Format:**
   - What are the exact cookie names? (UID, AUTH, SESSION?)
   - Are cookies sufficient, or do we need localStorage data?
3. **API Endpoint URL:**
   - Is it `https://lumo.proton.me/api/v1/ai/chat` or different?
   - Does it match mail.proton.me structure?
4. **Tool Calls & Sources:**
   - Do tool calls appear in SSE stream or require separate extraction?
   - How are web search sources returned?
5. **Rate Limiting:**
   - What triggers abuse detection?
   - How to avoid CAPTCHA during normal usage?

### Risk Assessment

| Risk                         | Likelihood | Impact | Mitigation                                  |
|------------------------------|------------|--------|---------------------------------------------|
| Auth tokens expire quickly   | Medium     | High   | Implement refresh; hybrid approach          |
| CAPTCHA triggered frequently | Low-Medium | Medium | Browser fallback; rate limiting             |
| API endpoints change         | Low        | High   | Monitor WebClients repo; version detection  |
| Missing features in API      | Medium     | Medium | Test thoroughly in PoC                      |
| ToS violation                | Low        | High   | Open-source, personal use, document clearly |

### Decision: Proceed with PoC ✅

**Rationale:**

- High potential for success (proven client code exists)
- Low investment (1-2 weeks for PoC)
- Clear fallback strategy (keep current implementation)
- Significant benefits if successful (eliminate browser overhead)
- Learning experience valuable regardless of outcome

**Next Steps:**

1. ✅ Create PoC branch in git
2. ✅ Extract auth tokens using current browser setup
3. ✅ Implement minimal API client
4. ✅ Test single message → streaming response
5. ✅ Document findings and make go/no-go decision

**Timeline:**

- **This week:** PoC implementation
- **Next week:** Testing and decision
- **Weeks 3-5:** Full integration (if PoC successful)
- **Week 6:** Production hardening

**Status:** ✅ **Phase 1 PoC COMPLETED** (2026-01-13)

---

## Phase 1 PoC Results

### Summary

Direct API integration with Proton Lumo **works successfully**. The PoC validates:
- ✅ Token extraction from browser session
- ✅ Direct API calls (no browser for chat)
- ✅ Full U2L encryption/decryption
- ✅ SSE streaming response parsing

### Implementation

**Files created in `src/proton/`:**
| File | Lines | Purpose |
|------|-------|---------|
| `types.ts` | ~115 | Core types (Turn, GenerationToFrontendMessage, Api, AuthTokens) |
| `streaming.ts` | ~82 | SSE parser (StreamProcessor class) |
| `crypto.ts` | ~220 | AES-GCM encryption via Node.js WebCrypto |
| `keys.ts` | ~35 | Lumo PGP public key |
| `encryption.ts` | ~63 | U2L encryption (encrypt turns, prepare request key) |
| `api-adapter.ts` | ~90 | Fetch wrapper with auth headers |
| `simple-client.ts` | ~180 | Minimal Lumo API client |

**Scripts:**
- `scripts/extract-auth-token.ts` - Token extraction via Playwright
- `scripts/poc-test.ts` - Test script for validation

### Key Findings

**Authentication:**
- UID is embedded in cookie name: `AUTH-{uid}` (not a separate cookie)
- Cookie value is the access token
- Three headers required: `x-pm-uid`, `Authorization: Bearer`, `x-pm-appversion`
- Missing `x-pm-appversion` returns error code 5002

**API Endpoint:**
- Correct: `POST https://lumo.proton.me/api/ai/v1/chat`
- (Note: `/api/v1/ai/chat` in original doc was incorrect path order)

**Encryption:**
- U2L encryption works as documented
- Response chunks correctly decrypt with AEAD
- `openpgp` npm package works for PGP key encryption

### Test Results

```bash
$ npm run poc-test "Hello"
📤 Query: Hello
📥 Response (streaming):
Hello! How can I help you today?
✅ Success!
  Response length: 32 chars
  Chunks received: 8
  Time elapsed: 1.11s
```

### Answers to Open Questions

| Question | Answer |
|----------|--------|
| Token lifespan | TBD - needs longer testing |
| Cookie format | `AUTH-{uid}` = access token, `REFRESH-{uid}` = refresh data (URL-encoded JSON) |
| API endpoint | `POST /api/ai/v1/chat` |
| Rate limiting | Not triggered in testing |

### Next Steps

**Phase 2: Full Integration**
- Replace browser calls in `chat-completions.ts` route
- Implement conversation history (multi-turn)
- Handle tool calls and sources via API
- Implement token refresh mechanism

**See also:** [proton-webclients-analysis.md](proton-webclients-analysis.md) for detailed technical documentation

**Status:** ✅ **Phase 2 COMPLETED** (2026-01-14)

---

## Phase 2 Results: Full API Integration

### Summary

Replaced browser-based DOM automation with direct API calls using `SimpleLumoClient`. The OpenAI-compatible API now uses the Lumo API directly.

### Changes Made

| Action | File | Description |
|--------|------|-------------|
| Modified | `src/api/types.ts` | `EndpointDependencies` now uses `SimpleLumoClient` |
| Modified | `src/api/server.ts` | Removed `BrowserManager`, creates `SimpleLumoClient` with auth tokens |
| Created | `src/api/message-converter.ts` | Converts OpenAI messages to Lumo turns with system message injection |
| Created | `src/api/commands.ts` | Command stubs that return errors in API mode |
| Modified | `src/api/routes/chat-completions.ts` | Uses `SimpleLumoClient.chatWithHistory()` |
| Modified | `src/api/routes/responses/handlers.ts` | Uses `SimpleLumoClient` |
| Modified | `src/api/routes/responses/index.ts` | Uses message converter |
| Modified | `src/api/instructions.ts` | Converted to no-op (instructions in message converter) |
| Modified | `src/index.ts` | Simplified entry point without browser |
| Modified | `src/config.ts` | Made browser/selectors/timeouts optional |
| Deleted | `src/browser/` | Entire directory removed |

### Test Results

```bash
# Non-streaming
$ curl -X POST http://localhost:3003/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"lumo","messages":[{"role":"user","content":"What is 2+2?"}],"stream":false}'
{"id":"chatcmpl-...","choices":[{"message":{"content":"2 + 2 = 4."}}]}

# Streaming
$ curl -N -X POST ... -d '{"stream":true}'
data: {"choices":[{"delta":{"content":"H"}}]}
data: {"choices":[{"delta":{"content":"ello"}}]}
...
data: [DONE]

# Multi-turn
$ curl ... -d '{"messages":[{"role":"user","content":"My name is Mark S."},{"role":"assistant","content":"Hi!"},{"role":"user","content":"What is my name?"}]}'
{"choices":[{"message":{"content":"Your name is Mark S."}}]}

# Commands (stub)
$ curl ... -d '{"messages":[{"role":"user","content":"/new"}]}'
{"choices":[{"message":{"content":"Command /new is not available in API mode..."}}]}
```

### What Works
- ✅ Non-streaming chat completions
- ✅ Streaming chat completions (SSE)
- ✅ Multi-turn conversations (full history)
- ✅ System/developer message injection as `[Personal context: ...]`
- ✅ Health endpoint
- ✅ CLI (`npm run lumo "message"`)

### Temporarily Disabled
- ⏸️ Tool calls (pass `null` until API extraction implemented)
- ⏸️ Slash commands (`/new`, `/private`, `/open`) - return error messages

### Architecture

```
Client Request → Express API → Queue → SimpleLumoClient → Proton API
                                              ↓
                              Encryption/Decryption (Node.js)
                                              ↓
                              Stream Processing (SSE)
```

No browser required for chat operations.

---

## Behavior/Instructions Handling

### How Lumo WebClient Handles "How should Lumo behave?"

**Key Finding:** Personalization is NOT sent as a system message. It's appended to the user's message content.

#### Storage
- Endpoint: `GET/POST/PUT /api/lumo/v1/settings`
- Data is **encrypted** with user's master key
- Stored as `LumoUserSettings.personalization`

#### PersonalizationSettings Structure
```typescript
interface PersonalizationSettings {
    nickname: string;           // "Call me {nickname}."
    jobRole: string;            // "I work as: {jobRole}"
    personality: 'default' | 'business-cat' | 'sassy-cat' | ...;
    traits: string[];           // ['chatty', 'witty', ...]
    lumoTraits: string;         // Free-form text
    additionalContext: string;  // Free-form "How should Lumo behave?"
    enableForNewChats: boolean;
}
```

#### Injection into Request
The personalization prompt is **appended to the first user message**:
```typescript
// From llm/index.ts
const updatedContent = originalContent
  ? `${originalContent}\n\n[Personal context: ${personalizationPrompt}]`
  : `[Personal context: ${personalizationPrompt}]`;
```

### Advantage for lumo-bridge

**Current Limitation (DOM approach):**
- Single global behavior stored in Lumo's settings UI
- All clients share the same instructions
- Clients can overwrite each other's behavior via `setBehaviour()`

**With Direct API Approach:**
- Each request can have its own `[Personal context: ...]`
- No server-side state to conflict with
- Instructions are stateless - per-request, not global
- Multiple users/clients can use same lumo-bridge with different behaviors

```typescript
// Per-request instructions in lumo-bridge
app.post('/v1/chat/completions', async (req, res) => {
  const { messages } = req.body;

  // Extract developer/system message as instructions
  const systemMessage = messages.find(m => m.role === 'system' || m.role === 'developer');
  const userMessage = messages.find(m => m.role === 'user')?.content;

  // Augment user message with instructions (like Lumo does)
  const augmentedMessage = systemMessage
    ? `${userMessage}\n\n[Personal context: ${systemMessage.content}]`
    : userMessage;

  // Send to Lumo API - no server-side behavior state needed
  await lumoClient.chat(augmentedMessage, ...);
});
```

**Benefits:**
- ✅ Different AI tools (Claude Code, Cursor, etc.) can have separate system prompts without conflicts
- ✅ No need to touch Lumo's encrypted settings API
- ✅ No conflicts between clients used by the same user
- ✅ Simpler implementation - just string manipulation

---

## Chat History & `/open <keyword>` Command

### Current Implementation (DOM-based)

The current `openChatByKeyword()` function in [src/browser/actions.ts](src/browser/actions.ts):
1. Expands the sidebar
2. Finds a link in `.chat-history-container a` containing the keyword text
3. Clicks the link to navigate to that chat

```typescript
// Current DOM-based approach
export async function openChatByKeyword(page: Page, keyword: string) {
  const expand = page.locator(chatboxSelectors.expandSidebar).first();
  if (expand) await expand.click({ timeout: 1000 });

  const link = page
    .locator(chatboxSelectors.previousChat, { hasText: keyword })
    .first();

  await link.click({ timeout: 1000 });
  const title = await link.innerText();
  return `Opened first chat with keyword ${keyword}: ${title}`;
}
```

### API-Based Equivalent

**Good news:** The Proton API has full support for chat history access.

#### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/lumo/v1/spaces` | GET | List all spaces (with conversations) |
| `/api/lumo/v1/spaces/{id}` | GET | Get single space with conversations |
| `/api/lumo/v1/conversations/{id}` | GET | Get conversation with messages |

#### Data Structure

From Proton's type definitions:

```typescript
// Conversation has an encrypted title
type Conversation = {
    id: ConversationId;
    spaceId: SpaceId;
    createdAt: string;
    starred?: boolean;
    title: string;  // ← Decrypted title for search
}

// Space contains conversations
type Space = {
    id: SpaceId;
    createdAt: string;
    spaceKey: Base64;  // Key to decrypt conversation titles
}
```

#### How `/open` Would Work via API

```typescript
async function openChatByKeyword(keyword: string): Promise<{ id: string; title: string }> {
    // 1. List all spaces (which include conversations)
    const spacesData = await lumoApi.listSpaces();

    // 2. For each space, decrypt its key and conversation titles
    const allConversations: Array<{ id: string; title: string; spaceId: string }> = [];

    for (const [spaceId, space] of Object.entries(spacesData.spaces)) {
        // Unwrap space key using master key
        const spaceKey = await unwrapSpaceKey(space.wrappedSpaceKey, masterKey);

        // Get conversations for this space
        for (const [convId, conv] of Object.entries(spacesData.conversations)) {
            if (conv.spaceId === spaceId) {
                // Decrypt the title
                const title = await decryptConversationTitle(conv.encrypted, spaceKey);
                allConversations.push({ id: convId, title, spaceId });
            }
        }
    }

    // 3. Search decrypted titles
    const match = allConversations.find(conv =>
        conv.title.toLowerCase().includes(keyword.toLowerCase())
    );

    if (!match) {
        throw new Error(`No chat found with keyword: ${keyword}`);
    }

    // 4. Return conversation ID (caller sets this as active)
    return { id: match.id, title: match.title };
}
```

#### Encryption Details

Conversation titles are encrypted with the space's key:

```typescript
// Decryption flow
1. masterKey (from auth)
   → unwrap spaceKey (AES-KW)
   → derive DEK from spaceKey (HKDF)
   → decrypt title (AES-GCM)

// From Proton's code
export async function getSpaceDek(s: SpaceKeyClear): Promise<AesGcmCryptoKey> {
    const spaceKeyBytes = Uint8Array.fromBase64(s.spaceKey);
    return deriveDataEncryptionKey(spaceKeyBytes);
}
```

### Trade-offs: DOM vs API Approach

| Aspect | DOM Approach | API Approach |
|--------|-------------|--------------|
| **Speed** | Fast (visible text only) | Slower (decrypt all titles) |
| **Accuracy** | Only recent/visible chats | ALL chats searchable |
| **Complexity** | Simple selector + click | Encryption handling required |
| **Offline** | Needs browser | Could cache locally |
| **Reliability** | Depends on UI selectors | Stable API contract |

### Recommended Implementation

For the API-based approach:

1. **Cache decrypted titles** - Fetch and decrypt on startup, update incrementally
2. **Lazy decryption** - Only decrypt titles when searching (if conversation count is high)
3. **Same command interface** - Keep `/open <keyword>` syntax

```typescript
// Optimized implementation with caching
class ConversationCache {
    private cache: Map<string, { id: string; title: string; spaceId: string }> = new Map();
    private lastSync: Date | null = null;

    async search(keyword: string): Promise<{ id: string; title: string } | null> {
        // Refresh cache if stale (e.g., older than 5 minutes)
        if (!this.lastSync || Date.now() - this.lastSync.getTime() > 5 * 60 * 1000) {
            await this.refreshCache();
        }

        // Search cached titles
        for (const conv of this.cache.values()) {
            if (conv.title.toLowerCase().includes(keyword.toLowerCase())) {
                return { id: conv.id, title: conv.title };
            }
        }

        return null;
    }

    private async refreshCache(): Promise<void> {
        const spacesData = await lumoApi.listSpaces();
        // ... decrypt and populate cache
        this.lastSync = new Date();
    }
}
```

### Advantage Over DOM Approach

The API approach is actually **more powerful**:

- ✅ Search ALL conversations, not just visible ones in sidebar
- ✅ Search by conversation content (messages), not just titles
- ✅ Sort by date, filter by starred, etc.
- ✅ No dependency on UI layout or selectors
- ✅ Could implement fuzzy search

### Additional Chat History Features (Future)

With API access, we could add:

| Command | Function |
|---------|----------|
| `/open <keyword>` | Open chat by title keyword |
| `/recent` | List 10 most recent chats |
| `/starred` | List starred/favorite chats |
| `/search <text>` | Search message content |
| `/delete <keyword>` | Delete chat by keyword |

---

## Additional Resources

**Proton Authentication Research:**

- Full authentication flow documented
- SRP implementation available in WebClients
- go-proton-api available as reference
- proton-bridge shows production patterns

**Files for Reference:**

- WebClients SRP: `/tmp/WebClients/packages/srp/lib/`
- Auth API: `/tmp/WebClients/packages/shared/lib/api/auth.ts`
- LumoApiClient: `/tmp/WebClients/applications/lumo/src/app/lib/lumo-api-client/`
- Session management: `/tmp/WebClients/packages/shared/lib/authentication/`

**External Resources:**

- [ProtonMail/go-proton-api](https://github.com/ProtonMail/go-proton-api) - Official Go library
- [ProtonMail/proton-bridge](https://github.com/ProtonMail/proton-bridge) - Production auth patterns
- [emersion/hydroxide](https://github.com/emersion/hydroxide) - Third-party bridge example
- [rclone/rclone](https://rclone.org/protondrive/) - Proton Drive authentication