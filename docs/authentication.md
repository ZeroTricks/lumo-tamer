# Authentication

lumo-bridge supports three authentication methods for connecting to Proton Lumo's API.

## rclone Config Extraction (Recommended)

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
| Browser required | No | No | Yes |
| Go toolchain required | No | Yes | No |
| Extraction step | None | `./bin/proton-auth` | `npm run extract-tokens` |
| Token refresh | Manual (rclone) | Automatic | Manual |
| 2FA support | Any (via rclone) | TOTP | Any |
| CAPTCHA handling | Interactive (rclone) | Fails | Interactive |
| Setup complexity | Low | Medium | Low |

### Extraction Steps

| Method | Before Starting Server | On Token Expiry |
|--------|----------------------|-----------------|
| rclone | None - reads config directly | Run `rclone lsd remote:`, restart server |
| SRP | `./bin/proton-auth -o sessions/auth-tokens.json` | Automatic (or re-run binary) |
| Browser | `npm run extract-tokens` | Re-run `npm run extract-tokens` |

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




## Current Token Refresh Status
- SRP auth method: Has automatic refresh via AuthManager.refresh() in manager.ts:99-138. It calls /auth/refresh endpoint to get new access tokens.
- rclone auth method: No automatic refresh. You need to run rclone lsd remote: externally to trigger rclone's token refresh, then restart the server.
- Browser extraction: No automatic refresh. Requires manual re-extraction when tokens expire.

### Would It Be Hard to Add?
For browser method, yes - it would be complex because:

- Browser tokens are session cookies with limited lifetime
- The refresh endpoint likely requires the same scopes we're bypassing
- We'd need to maintain Proton's refresh token flow, which involves cryptographic challenges

For rclone method, moderate - we could detect 401 errors and shell out to rclone lsd to trigger refresh, then reload config.

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