# Using Lumo as an AI Assistant in Home Assistant

This guide walks you through setting up [Proton Lumo](https://lumo.proton.me/) as a voice assistant in Home Assistant using lumo-tamer.

**What you'll get:** Lumo as your housecat: a privacy-friendly AI assistant that can answer questions and control your smart home devices.

**Skill level:** Basic - you should be comfortable with:
- Editing configuration files
- Running commands in a terminal
- Basic Home Assistant administration

## Prerequisites

- **Home Assistant** installed and running
- **A Proton account**
- **A computer or server** to run lumo-tamer (can be the same machine as Home Assistant)

## Choose Your Setup

| Method | Requirements | Recommended for |
|--------|--------------|-----------------|
| [Docker Setup](#docker-setup) | Docker, Git | Most users, easier updates |
| [Native Setup](#native-setup) | Node.js 18+, Go 1.24+, Git | Development, customization |

---

## Docker Setup

### Step 1: Install

```bash
git clone https://github.com/ZeroTricks/lumo-tamer.git
cd lumo-tamer
docker compose build tamer

# Create secret key to encrypt the token vault (or alternatively, use another secrets managemer )
mkdir -p secrets && chmod 700 secrets
openssl rand -base64 32 > secrets/lumo-vault-key
chmod 600 secrets/lumo-vault-key
```

### Step 2: Authenticate with Proton

```bash
docker compose run --rm -it tamer auth login
```

Enter your Proton email, password, and 2FA code (if enabled).

> **Tip:** If you hit a CAPTCHA, log in to Proton in a regular browser from the same IP first. This often clears the challenge.

### Step 3: Configure

```bash
cp config.defaults.yaml config.yaml
```

Edit `config.yaml` and set an API key:

```yaml
server:
  apiKey: "your-secret-api-key-here"
```

> **Security:** Keep your API key private and configure your firewall to only expose lumo-tamer to Home Assistant.

### Step 4: Start the server

```bash
docker compose up -d tamer
docker compose logs -f tamer
```

### Step 5: Verify

```bash
curl http://localhost:3003/health
# Should return: {"status":"ok"}
```

**→ Continue to [Configure Home Assistant](#configure-home-assistant)**

---

## Native Setup

### Step 1: Install dependencies

**On Debian/Ubuntu:**
```bash
sudo apt install -y nodejs golang git
```

**On macOS (with Homebrew):**
```bash
brew install node go git
```

**Verify:**
```bash
node --version   # Should show v18.x or higher
go version       # Should show go1.24 or higher
```

### Step 2: Clone and build

```bash
git clone https://github.com/ZeroTricks/lumo-tamer.git
cd lumo-tamer
npm install && npm run build:all
```

### Step 3: Authenticate with Proton

```bash
npm run cli -- auth login
```

Enter your Proton email, password, and 2FA code (if enabled).

> **Tip:** If you hit a CAPTCHA, log in to Proton in a regular browser from the same IP first. This often clears the challenge.


By default, lumo-tamer will encrypt fetched tokens with a password saved to your OS keychain. If this is unavailable, you can alternatively create a keyfile and guard it with your life.

```bash
openssl rand -base64 32 > /path/to/your/lumo-vault-key
chmod 600 /path/to/your/lumo-vault-key
```

```yaml
auth:
  vault:
    keyFilePath: "/path/to/your/lumo-vault-key"
```


### Step 4: Configure

```bash
cp config.defaults.yaml config.yaml
```

Edit `config.yaml` and set an API key:

```yaml
server:
  apiKey: "your-secret-api-key-here"
```

> **Security:** Keep your API key private. Configure your firewall to only expose lumo-tamer to Home Assistant.

### Step 5: Start the server

```bash
npm run server
```

### Step 6: Verify

In a new terminal:

```bash
curl http://localhost:3003/health
# Should return: {"status":"ok"}
```

**→ Continue to [Configure Home Assistant](#configure-home-assistant)**

---

## Configure Home Assistant

### Step 1: Set the OpenAI base URL

Home Assistant's OpenAI integration needs to know where to find lumo-tamer. Set this environment variable:

```
OPENAI_BASE_URL=http://YOUR_SERVER_IP:3003/v1
```

How to set it depends on your HA installation:
- **Home Assistant OS:** Use an add-on that supports environment variables <<check>>
- **Docker:** Add `-e OPENAI_BASE_URL=http://YOUR_SERVER_IP:3003/v1` to your docker run command or compose file
- **Core:** Export the variable before starting Home Assistant

### Step 2: Add the OpenAI integration

1. Go to **Settings** > **Devices & Services**
2. Click **Add Integration**
3. Search for "OpenAI" and select **OpenAI Conversation**
4. Enter your lumo-tamer API key
5. Click **Submit**

If you see an error, check that:
- lumo-tamer is running
- `OPENAI_BASE_URL` is correct
- The API key matches `config.yaml`

### Step 3: Create a voice assistant

1. Go to **Settings** > **Voice Assistants**
2. Click **Add Assistant**
3. Configure:
   - **Name:** "Lumo" (or your preference)
   - **Conversation agent:** OpenAI Conversation
   - **Language:** Your preferred language
4. Click **Create**

### Step 4: Set a personality (optional)

1. Click the **gear icon** next to your assistant
2. In **Prompt template**, add:

```
You are a helpful home assistant. Be concise and friendly.
When controlling devices, confirm what you did.
```

3. Click **Save**

<<add note on other config options (new and existing)>>

---

## Enable Device Control (Optional)

### Step 1: Enable in lumo-tamer

Edit `config.yaml`:

```yaml
server:
  customTools:
    enabled: true
```

Restart lumo-tamer.

> **Warning:** Custom tool support is experimental. See [Custom Tools](custom-tools.md) for troubleshooting.

### Step 2: Configure Home Assistant permissions

1. Go to **Settings** > **Voice Assistants**
2. Click the gear icon next to your assistant
3. Set **Control Home Assistant** to **Assist**

### Step 3: Expose entities

1. Go to **Settings** > **Voice Assistants** > **Expose** tab
2. Select which entities Lumo can access

> **Tip:** Start with a few entities to test, add more later.

---

## Test Your Setup

### Start a conversation

1. Open Assist (top bar or mobile app)
2. Try: "What can you help me with?"

<<HA will still use "OpenAI" in some messages, ie "Error talking to OpenAI", or "OpenAI response error">>

### Test device control (if enabled)

Try:
- "Turn on the living room light"
- "What's the temperature in the bedroom?"
- "Is the front door locked?"

<<if local intent thing is on, intentionally say something that the thingy will not understand>>

---

## Troubleshooting

### "Unable to connect" or "Invalid API key"
- Verify lumo-tamer is running: `curl http://YOUR_SERVER_IP:3003/health`
- Check `OPENAI_BASE_URL` is correct
- Confirm API keys match

### Slow responses
<<known, reduce exposed entities, enable local thingy>>

### Device control not working
- Ensure `customTools.enabled: true` in config.yaml
- Check entities are exposed in HA
- Enable debug logging: `server.log.level: debug`

### Lumo says "I can't do that"
<<misrouted tool calls should be caught>>

---

## Further Reading

- [lumo-tamer README](../README.md)
- [Custom Tools](custom-tools.md)
- [Home Assistant OpenAI integration](https://www.home-assistant.io/integrations/openai_conversation/)
- [Home Assistant Voice Assistants](https://www.home-assistant.io/voice_control/)
