# Authentication

lumo-bridge supports three authentication methods for connecting to Proton Lumo's API.

## rclone Config Extraction

Extracts authentication credentials from an existing [rclone](https://rclone.org/) protondrive configuration.

### Why rclone?

- **Full keyPassword access**: rclone stores the derived mailbox password needed for conversation persistence
- **No browser dependency**: Pure file-based credential extraction
- **CAPTCHA bypass**: rclone handles CAPTCHA interactively during `rclone config`
- **No Go toolchain**: Just parse an existing config file

### Setup

```bash
# 1. Install rclone (if not already installed)
# https://rclone.org/install/

# 2. Configure a Proton Drive remote
rclone config
# Follow prompts: New remote → protondrive → authenticate

# 3. Configure config.yaml
auth:
  method: rclone
  rclonePath: "~/.config/rclone/rclone.conf"  # or custom path
  rcloneRemote: "proton"                       # your remote name
```

### How It Works

rclone's protondrive backend stores credentials in INI format:

```ini
[proton]
type = protondrive
client_uid = abc123...
client_access_token = xyz789...
client_refresh_token = def456...
client_salted_key_pass = base64encodedKeyPassword==
```

The `client_salted_key_pass` is the base64-encoded `keyPassword` - the same value derived by SRP authentication. lumo-bridge decodes this to enable conversation persistence.

### Token Refresh

rclone manages token refresh automatically. When tokens expire:
1. Run any rclone command (e.g., `rclone lsd proton:`)
2. rclone refreshes tokens and updates the config file
3. Restart lumo-bridge to pick up new tokens

---

## SRP Authentication

Uses Proton's official SRP (Secure Remote Password) protocol via [go-proton-api](https://github.com/henrybear327/go-proton-api).

### Why SRP?

- **Direct keyPassword access**: SRP auth derives the mailbox password needed to decrypt user keys for conversation persistence
- **No browser dependency**: Pure API-based authentication
- **Official protocol**: Uses Proton's documented authentication flow
- **Token refresh**: Supports automatic token refresh without re-authentication

### Setup

```bash
# 1. Build the Go binary (requires Go 1.24+)
cd go-auth && go build -o ../bin/proton-auth

# 2. Run authentication (interactive)
./bin/proton-auth -o sessions/auth-tokens.json
# Prompts for: username, password, TOTP (if 2FA enabled)

# 3. Configure config.yaml
auth:
  method: srp
  binaryPath: "./bin/proton-auth"
  tokenCachePath: "sessions/auth-tokens.json"
```

### Flow

```
User runs proton-auth binary
    ↓
Interactive prompts: username, password, TOTP
    ↓
SRP authentication with Proton servers
    ↓
Fetch user salts (time-limited after auth)
    ↓
Derive keyPassword from password + salt
    ↓
Output JSON: {accessToken, refreshToken, uid, keyPassword}
    ↓
Server loads tokens, creates API client
    ↓
Token refresh handled automatically via HTTP
```

### Output Format

The Go binary outputs JSON to the specified file:

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "uid": "...",
  "userID": "...",
  "keyPassword": "...",
  "expiresAt": "2026-01-15T12:00:00Z",
  "extractedAt": "2026-01-14T12:00:00Z"
}
```

### Re-authentication

Tokens are cached and reused. Re-run the binary when:
- Tokens expire (typically 12-24 hours)
- Server returns 401 errors
- You change Proton account password

---

## Browser Token Extraction

Extracts authentication cookies and encryption keys from an existing browser session.

### Setup

```bash
# With browser container running and logged into Lumo
npm run extract-tokens
```

### What It Extracts

When `persistence.enabled: true` in config.yaml:
- **AUTH cookies** for lumo.proton.me and account.proton.me
- **ClientKey** from `/api/auth/v4/sessions/local/key` (decrypts persisted session)
- **keyPassword** derived from persisted session blob
- **User keys** (encrypted PGP private keys) from `/api/core/v4/users`
- **Master keys** (encrypted) from `/api/lumo/v1/masterkeys`

When `persistence.enabled: false`:
- Only AUTH cookies are extracted (faster, no extra API calls)

### How It Works

The extraction uses Playwright to connect to an existing browser session via CDP:

1. Connects to browser via `browser.cdpEndpoint`
2. Extracts cookies and localStorage from Proton domains
3. Finds the active session (matching `ua_uid` in sessionStorage)
4. If persistence enabled:
   - Fetches ClientKey to decrypt the persisted session blob
   - Extracts keyPassword (mailbox password)
   - Fetches user PGP keys via browser context (bypasses scope limitations)
   - Fetches master keys via browser context (bypasses scope limitations)
5. Saves everything to `sessions/auth-tokens.json`

### Multiple Sessions

If the browser has multiple Proton sessions (different accounts), extraction prioritizes:
1. The session matching `ua_uid` (the currently active tab)
2. The AUTH cookie matching the persisted session UID
3. Falls back to the first available lumo.proton.me AUTH cookie

### Limitations

- **Browser dependency**: Requires Playwright and a running browser instance
- **Manual refresh**: Must re-extract when cookies expire (~24h)
- **Session-specific**: Extracted keys are tied to the active browser session

### When to Use

- Primary method for development with full persistence support
- When rclone or SRP auth methods are unavailable

---

## Comparison

| Feature | rclone Config | SRP Auth | Browser Extraction |
|---------|---------------|----------|-------------------|
| keyPassword | Yes | Yes | Yes |
| Conversation sync | Full | Full | Full |
| Browser required | No | No | Yes (initial only) |
| Go toolchain required | No | Yes | No |
| Extraction step | None | `./bin/proton-auth` | `npm run extract-tokens` |
| Token refresh | Automatic | Automatic | Automatic |
| 2FA support | Any (via rclone) | TOTP | Any |
| CAPTCHA handling | Interactive (rclone) | Fails | Interactive |
| Setup complexity | Low | Medium | Low |

### Keys and Tokens

| Key/Token | rclone | SRP | Browser | Purpose |
|-----------|--------|-----|---------|---------|
| `uid` | Yes | Yes | Yes | User identifier for API requests |
| `accessToken` | Yes | Yes | Yes | Authentication for API calls |
| `refreshToken` | Yes | Yes | Yes | Get new access tokens without re-auth |
| `keyPassword` | Yes | Yes | Yes | Decrypt user's PGP private keys |
| `userKeys` | No | No | Yes | Encrypted PGP keys for signing/decryption |
| `masterKeys` | No | No | Yes | Lumo-specific keys for conversation encryption |

**Why these matter:**
- **accessToken**: Required for all API calls. Expires in ~24h.
- **refreshToken**: Allows automatic token refresh without user interaction. All auth methods support this.
- **keyPassword**: Derived from your account password + salt. Needed to decrypt your PGP private keys for end-to-end encryption.
- **userKeys**: Your encrypted PGP private keys. Fetched from `/core/v4/users`. May require specific API scope.
- **masterKeys**: Lumo-specific encryption keys. Fetched from `/lumo/v1/masterkeys`. May require specific API scope.

**Scope considerations:** Browser extraction caches `userKeys` and `masterKeys` because the browser context has full scope. SRP and rclone tokens may face scope restrictions when fetching these keys via API - this is untested until SRP auth works reliably.

### Extraction Steps

| Method | Before Starting Server | On Token Expiry |
|--------|----------------------|-----------------|
| rclone | None - reads config directly | Automatic refresh |
| SRP | `./bin/proton-auth -o sessions/auth-tokens.json` | Automatic refresh |
| Browser | `npm run extract-tokens` | Automatic refresh |

---

## Troubleshooting

### rclone

#### "Section [remote] not found"
Check that `rcloneRemote` in config.yaml matches a section name in your rclone.conf.

```bash
# List available remotes
rclone listremotes
```

#### "Remote is not a protondrive type"
The specified remote is configured for a different backend. Create a new protondrive remote:

```bash
rclone config
# Select: New remote → protondrive
```

#### "Missing required fields"
Your rclone config may be from an older version or authentication failed. Reconnect:

```bash
rclone config reconnect your-remote-name:
```

### SRP Auth

#### "proton-auth binary not found"
Build it: `cd go-auth && go build -o ../bin/proton-auth`

#### "Authentication failed"
- Verify username/password
- Check if 2FA is enabled (will prompt for TOTP)
- Try rclone or browser extraction as fallback

#### "Failed to get salts"
Salts endpoint is only accessible briefly after authentication. Re-run the binary.

#### Token refresh fails
Refresh tokens eventually expire. Re-run `./bin/proton-auth -o sessions/auth-tokens.json`

### Browser Extraction

#### "No browser contexts found"
Ensure the browser container is running and accessible via CDP.

#### "Not logged in"
Log in to Lumo in the browser first, then re-run extraction.

#### "ClientKey fetch succeeded but decryption failed"
The browser session may have changed since login. Log out and log back in, then re-run extraction.

#### "No Lumo AUTH cookie found for master keys fetch"
Multiple browser sessions may exist. Ensure the Lumo tab is active/focused when running extraction.

#### Scope errors during server startup
If keys were cached but server still gets scope errors, the AUTH cookie used may not match the cached keys. Re-run `npm run extract-tokens` to refresh all cached data.




## Token Refresh

All auth methods now support automatic token refresh via the `AuthManager`:

| Method | Refresh Mechanism | Auto-Refresh |
|--------|-------------------|--------------|
| **SRP** | `/auth/refresh` endpoint | Yes |
| **rclone** | `/auth/refresh` endpoint | Yes |
| **Browser** | `/auth/refresh` endpoint | Yes |

### Configuration

```yaml
auth:
  autoRefresh:
    enabled: true        # Enable automatic refresh (default: true)
    intervalHours: 20    # Scheduled refresh interval (default: 20)
    onError: true        # Refresh on 401 errors (default: true)
```

### How It Works

All auth methods store a `refreshToken` and use Proton's `/auth/refresh` endpoint to get new access tokens without re-authentication. This happens:
- On a schedule (every `intervalHours`)
- On 401 errors (if `onError: true`)

For browser auth, the `REFRESH-{uid}` cookie is extracted during initial token extraction. This cookie contains the refresh token in JSON format, allowing subsequent token refresh without needing the browser.

### Manual Refresh

You can manually trigger a refresh via:
- **Chat command**: `/refreshtokens`
- **API**: `POST /v1/auth/refresh`
- **Programmatic**: `authManager.refreshNow()`

### Technical Details

The refresh endpoint returns new tokens via `Set-Cookie` headers (not in the JSON body):
- `AUTH-{uid}` cookie contains the new access token
- `REFRESH-{uid}` cookie contains the new refresh token (JSON-encoded)

lumo-bridge parses these cookies and updates the token cache file.

**Known limitation:** Consecutive token refreshes without an API call in between will fail with "Invalid refresh token". The new refresh token is correctly extracted and stored, but Proton's servers reject it until an actual API request has been made. This doesn't affect normal usage since refresh typically happens on 401 errors (which means an API call was made) or on the 20-hour auto-refresh schedule.

### Would Cached Keys Still Work After Refresh?
Yes - the cached userKeys and masterKeys remain valid after token refresh because:

- userKeys are encrypted with your mailbox password (derived from account password), not the access token
- masterKeys are encrypted with your PGP keys, which are decrypted using keyPassword
- Only the AUTH-{uid} cookie (access token) expires and gets refreshed - the UID stays the same
- The keyPassword is derived from your account password, which doesn't change

So after a token refresh:

- New access token ✓ (refreshed)
- Same UID ✓ (unchanged)
- Same keyPassword ✓ (unchanged)
- Cached userKeys ✓ (still valid - encrypted with same password)
- Cached masterKeys ✓ (still valid - encrypted with same PGP keys)

The only scenario where cached keys become invalid is if you change your Proton password - that would regenerate the keyPassword and potentially re-encrypt your private keys.

---

## Logout

Proper logout involves two steps:
1. **Revoke session on Proton servers**: `DELETE /core/v4/auth`
2. **Delete local token cache**: Remove `sessions/auth-tokens.json`

### How to Logout

**CLI**: Use the `/logout` command
```
/logout
```

**API**: `POST /v1/auth/logout`
```bash
curl -X POST http://localhost:3003/v1/auth/logout \
  -H "Authorization: Bearer your-api-key"
```

**Programmatic**:
```typescript
import { logout } from './auth/index.js';

await logout({
  api: authProvider.createApi(),
  tokenCachePath: 'sessions/auth-tokens.json',
  revokeRemote: true,  // Call Proton's revoke API
  deleteLocal: true,   // Delete token file
});
```

### What Happens on Logout

1. The session is revoked on Proton's servers (access token becomes invalid)
2. The local token file is deleted
3. Server needs to be restarted (or tokens need to be re-extracted)

### Just Deleting the Token File

If you just delete `sessions/auth-tokens.json` without calling the revoke API:
- The access token remains valid on Proton's side until it expires (~24h)
- Server will crash when trying to load tokens
- This is less secure but simpler for local development