# Authentication

lumo-bridge supports three authentication methods. Run `npm run auth` to authenticate interactively.

## Quick Start

```bash
npm run auth
# Select method:
#   1. browser - Extract from logged-in browser session (recommended)
#   2. login   - Enter Proton credentials
#   3. rclone  - Paste rclone config section
```

After successful authentication, config.yaml is updated with your selected method.

---

## Browser Token Extraction (Recommended)

Extracts authentication cookies and encryption keys from an existing browser session via Chrome DevTools Protocol (CDP).

### Why Browser?

- **Full persistence support**: Only method that caches userKeys and masterKeys for conversation sync
- **Any 2FA method**: Works with TOTP, security keys, etc.
- **No extra tools**: Just needs a running browser with Lumo logged in

### Setup

```bash
# 1. Have a browser running with Lumo logged in (accessible via CDP)
# 2. Run authentication
npm run auth
# Select: 1. browser
# Enter CDP endpoint when prompted (default: http://localhost:9222)
```

### What It Extracts

- **AUTH cookies** for lumo.proton.me and account.proton.me
- **refreshToken** from REFRESH cookie (for automatic token refresh)
- **keyPassword** derived from persisted session blob
- **User keys** (encrypted PGP private keys) - cached for scope bypass
- **Master keys** (Lumo encryption keys) - cached for scope bypass

### Config

```yaml
auth:
  method: browser
  browser:
    cdpEndpoint: "http://localhost:9222"  # or your remote browser
```

---

## Login Authentication

Uses Proton's SRP (Secure Remote Password) protocol via a Go binary built from [go-proton-api](https://github.com/henrybear327/go-proton-api).

### Why Login?

- **No browser dependency**: Pure API-based authentication
- **Direct keyPassword access**: Derives the mailbox password needed for encryption
- **Token refresh**: Supports automatic token refresh

### Setup

```bash
# 1. Build the Go binary (requires Go 1.24+)
cd go-auth && go build -o ../bin/proton-auth

# 2. Run authentication
npm run auth
# Select: 2. login
# Enter username, password, TOTP (if 2FA enabled)
```

### Config

```yaml
auth:
  method: login
  login:
    binaryPath: "./bin/proton-auth"
    # Headers to help avoid CAPTCHA
    appVersion: "macos-drive@1.0.0-alpha.1+rclone"
    userAgent: "Mozilla/5.0 ..."
```

### Limitations

- **CAPTCHA**: May trigger CAPTCHA on Proton's servers (use browser method as fallback)
- **No persistence support**: Cannot fetch userKeys/masterKeys due to API scope restrictions
- **TOTP only**: Only supports TOTP for 2FA (no security keys)

---

## rclone Config Extraction

Extracts credentials from an existing [rclone](https://rclone.org/) protondrive configuration.

### Why rclone?

- **No Go toolchain**: Just paste config from existing rclone setup
- **CAPTCHA bypass**: rclone handles CAPTCHA during `rclone config`
- **Full keyPassword**: rclone stores the derived mailbox password

### Setup

```bash
# 1. Have rclone configured with a protondrive remote
rclone config
# Follow prompts: New remote → protondrive → authenticate

# 2. Run authentication
npm run auth
# Select: 3. rclone
# Paste your rclone config section when prompted
```

### Config Format

Paste the INI section from `~/.config/rclone/rclone.conf`:

```ini
[proton]
type = protondrive
client_uid = abc123...
client_access_token = xyz789...
client_refresh_token = def456...
client_salted_key_pass = base64encodedKeyPassword==
```

### Limitations

- **No persistence support**: Cannot fetch userKeys/masterKeys due to API scope restrictions
- **Manual paste**: Must paste config section each time (not auto-read from file)

---

## Comparison

| Feature | Browser | Login | rclone |
|---------|---------|-------|--------|
| Persistence support | Yes | No | No |
| keyPassword | Yes | Yes | Yes |
| Token refresh | Automatic | Automatic | Automatic |
| 2FA support | Any | TOTP only | Any (via rclone) |
| CAPTCHA handling | Browser handles | May fail | rclone handles |
| Extra tools needed | Browser + CDP | Go binary | rclone |
| Setup complexity | Medium | Medium | Low |

### Persistence Support

Only **browser** auth supports Proton conversation persistence because:
- Browser tokens have full API scope (including `/lumo/*` endpoints)
- Browser extraction caches `userKeys` and `masterKeys` which bypass scope checks
- Login and rclone tokens lack the `lumo` scope needed for spaces API

---

## Token Refresh

All auth methods support automatic token refresh:

```yaml
auth:
  autoRefresh:
    enabled: true        # Enable automatic refresh (default: true)
    intervalHours: 20    # Scheduled refresh interval (default: 20)
    onError: true        # Refresh on 401 errors (default: true)
```

### How It Works

All methods store a `refreshToken` and use Proton's `/auth/refresh` endpoint:
- On a schedule (every `intervalHours`)
- On 401 errors (if `onError: true`)

### Manual Refresh

- **CLI command**: `/refreshtokens`
- **API**: `POST /v1/auth/refresh`

---

## Auth Status

Check current authentication status:

```bash
npm run auth-status
```

Shows:
- Current auth method
- Token validity
- Persistence support status
- Any warnings

---

## Troubleshooting

### Browser

**"No browser contexts found"**
- Ensure browser is running and CDP endpoint is accessible
- Check firewall/network settings

**"Not logged in"**
- Log in to Lumo in the browser first, then re-run `npm run auth`

### Login

**"proton-auth binary not found"**
- Build it: `cd go-auth && go build -o ../bin/proton-auth`

**"Authentication failed"**
- Verify username/password
- Check if 2FA is enabled (will prompt for TOTP)
- Try browser method as fallback

### rclone

**"Remote is not a protondrive type"**
- Ensure you're pasting a protondrive section, not another remote type

**"Missing required fields"**
- Your rclone config may need refresh: `rclone config reconnect your-remote:`

---

## Logout

```bash
# CLI
/logout

# API
curl -X POST http://localhost:3003/v1/auth/logout \
  -H "Authorization: Bearer your-api-key"
```

This revokes the session on Proton's servers and deletes the local token cache.
