# Authentication

Authenticating to Proton is not straightforward: different flows depending on user settings (2FA, hardware keys), CAPTCHA challenges, and auth tokens not having the necessary scopes. The good news is you only have to log in once; after that, secrets are securely saved in an encrypted vault and tokens are refreshed automatically.

## Quick Start

```bash
tamer auth
# Select method:
#   1. login   - Enter Proton credentials (recommended)
#   2. browser - Extract from logged-in browser session
#   3. rclone  - Paste rclone config section
```

After successful authentication, `config.yaml` is updated with your selected method.

---

## Login (Recommended)

A secure and lightweight option where you provide your credentials in a prompt. Requires Go. No support for CAPTCHA or conversation sync.

Uses Proton's SRP (Secure Remote Password) protocol via a Go binary built from [go-proton-api](https://github.com/henrybear327/go-proton-api).

### Why Login?

- **No browser dependency**: Pure API-based authentication
- **Direct keyPassword access**: Derives the mailbox password needed for encryption
- **Token refresh**: Supports automatic token refresh

### Setup

1. Build the Go binary:
   ```bash
   # Requires Go 1.24+
   npm run build:login
   ```
2. Run `tamer auth login`
3. Enter username, password, and TOTP code (if 2FA is enabled).

> **Tip:** If you hit a CAPTCHA, try logging in to Proton in any regular browser from the same IP first. This may clear the challenge for subsequent login attempts.

### Config

```yaml
auth:
  method: login
  login:
    binaryPath: "./dist/proton-auth"
    # Headers to help avoid CAPTCHA
    appVersion: "macos-drive@1.0.0-alpha.1+rclone"
    userAgent: "Mozilla/5.0 ..."
```

### Limitations

- **CAPTCHA**: May trigger CAPTCHA on Proton's servers (see tip above)
- **No conversation sync**: Cannot fetch userKeys/masterKeys due to API scope restrictions
- **TOTP only**: Only supports TOTP for 2FA (no security keys)

### Troubleshooting

**"proton-auth binary not found"**
- Build it: `cd src/auth/login/go && go build -o ../../../../dist/proton-auth && cd -`

**"Authentication failed"**
- Verify username/password
- Check if 2FA is enabled (will prompt for TOTP)
- Try browser method as fallback

---

## Browser

Use a Chrome browser with remote debugging enabled to log in. Tokens will be extracted once. This is the only method that supports full conversation sync, and it lets you pass a CAPTCHA in the browser if needed.

### Why Browser?

- **Full conversation sync**: Only method that caches userKeys and masterKeys needed for conversation persistence
- **Any 2FA method**: Works with TOTP, security keys, etc.
- **CAPTCHA support**: Handle CAPTCHAs directly in the browser

### Setup

1. Launch a browser with remote debugging:
   - Use your own Chrome(-based) browser: `chrome --remote-debugging-port=9222`. You'll probably need to add more arguments, like `--user-data-dir=<custom dir> --remote-debugging-address=0.0.0.0 --remote-debugging-allowed-origins=*`. See [Chrome DevTools Protocol documentation](https://chromedevtools.github.io/devtools-protocol/) for more information.
   - Or use the provided Docker image: `docker compose up lumo-tamer-browser` (access browser GUI at http://localhost:3001)
2. Once the browser is running, log in to https://lumo.proton.me in it.
3. Run `tamer auth browser`.
4. Enter the CDP endpoint when prompted (ie. `http://localhost:9222`, or `http://browser:9222` when using both  `lumo-tamer` and `lumo-tamer-browser` docker containers).

### Limitations

- **CDP setup complexity**: Setting up Chrome DevTools Protocol can be tricky: getting the right command-line arguments, network access, and port forwarding to work may take some time.
- **Browser needed again on token expiry**: If tokens can't be refreshed (e.g. session revoked), you need a running browser to re-authenticate.
- **Docker container size**: The provided Docker browser container is ~1 GB, which is a lot just for authentication.

### Config

```yaml
auth:
  method: browser
  browser:
    cdpEndpoint: "http://localhost:9222"  # or "http://browser:9222" for Docker
```

### Troubleshooting

**"No browser contexts found. Is the browser running?"**
- Verify the browser is running and the CDP endpoint is reachable: `curl http://localhost:9222/json/version`
- If the browser is on a different machine, you may need to forward the port, e.g. with socat: `socat TCP-LISTEN:9222,fork TCP:<remote-host>:<remote-port>`
- Check firewall/network settings

**"Login timeout. Please log in and try again."**
- The browser was reached but you're not logged in to Lumo. Log in to https://lumo.proton.me in the browser, then re-run `tamer auth browser`.

**"No AUTH-\* cookie found for lumo.proton.me"**
- The browser is on the Lumo page but has no valid auth cookies. Try logging out and back in within the browser.

**"Browser session is not authenticated"**
- The browser session exists but the AUTH cookie is missing or expired. Log in again in the browser.

**`tamer auth` succeeds but `tamer` or `tamer-server` fails**
- Your browser may be maintaining multiple active sessions, confusing the extraction logic. Log out of Proton, clear all browser data for all proton.me domains (account, root, lumo), then log in again and re-run `tamer auth browser`.

---

## Rclone

Use rclone to log in and copy the tokens from its config file. No conversation sync.

### Why Rclone?

- **No Go toolchain**: Just paste config from existing rclone setup
- **CAPTCHA bypass**: rclone handles CAPTCHA during `rclone config`
- **Full keyPassword**: rclone stores the derived mailbox password

### Setup

1. Install rclone
2. Add a "proton drive" remote named "lumo-tamer" as described here: https://rclone.org/protondrive/. If you hit a CAPTCHA, try logging in to Proton in any regular browser from the same IP first. See [rclone remote setup](https://rclone.org/remote_setup/) for extra ways to login into rclone.
3. Test if rclone succeeds: `rclone about lumo-tamer:`
4. Find your rclone config file: `~/.config/rclone/rclone.conf` (Linux/macOS) or `%APPDATA%\rclone\rclone.conf` (Windows)
5. Copy the tokens under lumo-tamer manually or `grep -A 6 "lumo-tamer" rclone.conf`
6. Run `tamer auth rclone`.
7. Paste your rclone config section when prompted.

> **Warning:** This method reuses tokens/keys that are stored insecurely by rclone. Use it as a fallback if the other two methods don't work. If you already use rclone for Proton Drive, add a separate remote for lumo-tamer, as lumo-tamer will refresh tokens and invalidate the ones used by rclone.

### Config Format

Paste the INI section from your rclone config:

```ini
[lumo-tamer]
type = protondrive
client_uid = abc123...
client_access_token = xyz789...
client_refresh_token = def456...
client_salted_key_pass = base64encodedKeyPassword==
```

### Limitations

- **No conversation sync**: Cannot fetch userKeys/masterKeys due to API scope restrictions
- **Manual paste**: Must paste config section each time (not auto-read from file)

### Troubleshooting

**"Remote is not a protondrive type"**
- Ensure you're pasting a protondrive section, not another remote type

**"Missing required fields"**
- Your rclone config may need refresh: `rclone config reconnect lumo-tamer:`

---

## Comparison

| Feature | Login | Browser | Rclone |
|---------|-------|---------|--------|
| Conversation sync | No | Yes | No |
| keyPassword | Yes | Yes | Yes |
| Token refresh | Automatic | Automatic | Automatic |
| 2FA support | TOTP only | Any | Any (via rclone) |
| CAPTCHA handling | May fail | Browser handles | rclone handles |
| Extra tools needed | Go binary | Browser + CDP | rclone |
| Setup complexity | Medium | Medium | Low |

### Conversation Sync

Only **browser** auth supports conversation sync because:
- Browser tokens have full API scope (including `/lumo/*` endpoints)
- Browser extraction caches `userKeys` and `masterKeys` which bypass scope checks
- Login and rclone tokens lack the `lumo` scope needed for the spaces API

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

### Troubleshooting

Don't reuse the same tokens (browser or rclone) across different machines. Refreshing tokens will invalidate tokens on other machines.

---

## Auth Status

Check current authentication status:

```bash
npm run auth-status
```

Shows:
- Current auth method
- Token validity
- Conversation sync support status
- Any warnings

---

## Logout

Use the `/logout` command in any chat (CLI or API).

```bash
# API
curl -X POST http://localhost:3003/v1/auth/logout \
  -H "Authorization: Bearer your-api-key"
```

This revokes the session on Proton's servers and deletes the local token cache.
