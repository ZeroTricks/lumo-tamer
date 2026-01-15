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

## Browser Token Extraction (Legacy)

Extracts authentication cookies from an existing browser session.

### Setup

```bash
# With browser container running
npm run extract-token
```

### Limitations

- **No keyPassword**: Cannot derive the mailbox password needed for conversation persistence
- **No shared conversations**: Conversations created via lumo-bridge won't appear in the Proton web client (and vice versa) because message encryption requires keys that can only be unlocked with keyPassword
- **Browser dependency**: Requires Playwright and a running browser instance
- **Manual refresh**: Must re-extract when cookies expire

### When to Use

- Quick testing without Go toolchain or rclone
- Fallback if other auth methods fail

---

## Comparison

| Feature | rclone Config | SRP Auth | Browser Extraction |
|---------|---------------|----------|-------------------|
| keyPassword | Yes | Yes | No |
| Conversation sync | Full | Full | None |
| Browser required | No | No | Yes |
| Go toolchain required | No | Yes | No |
| Extraction step | None | `./bin/proton-auth` | `npm run extract-token` |
| Token refresh | Manual (rclone) | Automatic | Manual |
| 2FA support | Any (via rclone) | TOTP | Any |
| CAPTCHA handling | Interactive (rclone) | Fails | Interactive |
| Setup complexity | Low | Medium | Low |

### Extraction Steps

| Method | Before Starting Server | On Token Expiry |
|--------|----------------------|-----------------|
| rclone | None - reads config directly | Run `rclone lsd remote:`, restart server |
| SRP | `./bin/proton-auth -o sessions/auth-tokens.json` | Automatic (or re-run binary) |
| Browser | `npm run extract-token` | Re-run `npm run extract-token` |

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
