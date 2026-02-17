# How-to use Lumo as a Voice Assistant in Home Assistant

This guide walks you through setting up [Proton Lumo](https://lumo.proton.me/) as a voice assistant in Home Assistant using lumo-tamer.

**What you'll get:** Lumo as your housecat: a privacy-friendly AI assistant that can answer questions and control your smart home devices.

**Time:** 15-30 minutes

**You'll configure:**  
**[Part 1: lumo-tamer](#part-1-set-up-lumo-tamer)** - a proxy server that connects to Proton Lumo  
**[Part 2: Home Assistant](#part-2-configure-home-assistant)** - to use lumo-tamer as a voice assistant

**Skill level:** Moderate  
You should be comfortable with editing configuration files, running terminal commands, and basic Home Assistant administration.

---

## Prerequisites

- **Home Assistant** installed and running
- **A Proton account**
- **A computer or server** to run lumo-tamer (can be the same machine as Home Assistant)

## Part 1: Set up lumo-tamer

Choose your installation method for  lumo-tamer. Docker is recommended if you're familiar with it.

| Method | Requirements |
|--------|--------------|
| [Docker Setup](#docker-setup) | Docker, Git |
| [Native Setup](#native-setup) | Node.js 18+, Go 1.24+, Git |

---

### Docker Setup

#### Step 1: Install

```bash
git clone https://github.com/ZeroTricks/lumo-tamer.git
cd lumo-tamer
docker compose build tamer

# Create secret key to encrypt the token vault (or alternatively, use another secrets manager)
mkdir -p secrets && chmod 700 secrets
openssl rand -base64 32 > secrets/lumo-vault-key
chmod 600 secrets/lumo-vault-key
```

#### Step 2: Authenticate with Proton

```bash
docker compose run --rm -it tamer auth login
```

Enter your Proton email, password, and 2FA code (if enabled).

> **Tip:** If you hit a CAPTCHA, log in to Proton in a regular browser from the same IP first. This often clears the challenge.

#### Step 3: Configure

Add to `config.yaml`:

```yaml
server:
  apiKey: "your-secret-api-key-here"
  customTools:
    enabled: true  # allows Lumo to control your devices
```

> **Security:** Keep your API key private and configure your firewall to only expose lumo-tamer to Home Assistant.

#### Step 4: Start the server

```bash
docker compose up -d tamer
docker compose logs -f tamer
```

#### Step 5: Verify

```bash
curl http://localhost:3003/health
# Should return: {"status":"ok"}
```

**→ Continue to [Part 2: Configure Home Assistant](#part-2-configure-home-assistant)**

---

### Native Setup

#### Step 1: Install dependencies

**On Debian/Ubuntu:**
```bash
sudo apt install -y nodejs golang git
```

**On macOS (Homebrew):**
```bash
brew install node go git
```

**Verify:**
```bash
node --version   # Should show v18.x or higher
go version       # Should show go1.24 or higher
```

#### Step 2: Clone and build

```bash
git clone https://github.com/ZeroTricks/lumo-tamer.git
cd lumo-tamer
npm install && npm run build:all
npm link
```

#### Step 3: Authenticate with Proton

```bash
tamer auth login
```

Enter your Proton email, password, and 2FA code (if enabled).

> **Tip:** If you hit a CAPTCHA, log in to Proton in a regular browser from the same IP first. This often clears the challenge.


By default, lumo-tamer will encrypt fetched tokens with a password saved to your OS keychain. If this is unavailable, you can alternatively create a keyfile and guard it with your life:

```bash
openssl rand -base64 32 > /path/to/your/lumo-vault-key
chmod 600 /path/to/your/lumo-vault-key
```

And add to `config.yaml`:
```yaml
auth:
  vault:
    keyFilePath: "/path/to/your/lumo-vault-key"
```


#### Step 4: Configure


Add to `config.yaml`:

```yaml
server:
  apiKey: "your-secret-api-key-here"
  customTools:
    enabled: true  # allows Lumo to control your devices
```

> **Security:** Keep your API key private. Configure your firewall to only expose lumo-tamer to Home Assistant.

#### Step 5: Start the server

```bash
tamer server
```

#### Step 6: Verify

In a new terminal:

```bash
curl http://localhost:3003/health
# Should return: {"status":"ok"}
```

**→ Continue to [Part 2: Configure Home Assistant](#part-2-configure-home-assistant)**

---

## Part 2: Configure Home Assistant

lumo-tamer acts as an OpenAI compatible server, so we'll use an OpenAI integration in Home Assistant to connect to it. There are two options: the standard [OpenAI](https://www.home-assistant.io/integrations/openai_conversation/) integration, and the [Extended OpenAI Conversation](https://github.com/jekalmin/extended_openai_conversation). Which one you'll need depends on your Home Assistant installation:

| Installation | Method |
|--------------|--------|
| Docker / Core | [Configure OpenAI using an environment variable](#standard-openai-conversation) |
| Home Assistant OS | [Configure Extended OpenAI Conversation](#extended-openai-conversation) |

> **Note:** Extended OpenAI Conversation has its own custom tool support which hasn't been tested thoroughly with lumo-tamer. If you can set environment variables, the standard OpenAI integration is recommended.

---


### Standard OpenAI integration

#### Step 1: Set the OpenAI base URL

Set this environment variable for Home Assistant:

```
OPENAI_BASE_URL=http://YOUR_SERVER_IP:3003/v1
```

- **Docker:** Add `-e OPENAI_BASE_URL=http://YOUR_SERVER_IP:3003/v1` to your docker run command or compose file
- **Core:** Export the variable before starting Home Assistant

#### Step 2: Add the OpenAI integration

1. Go to **Settings** > **Devices & Services**
2. Click **Add Integration**
3. Select **OpenAI**
4. Enter your lumo-tamer API key
5. Click **Submit**

If you see an error, check that:
- lumo-tamer is running
- `OPENAI_BASE_URL` is correct
- The API key matches `config.yaml`

**→ Continue to [Create a voice assistant](#create-a-voice-assistant)**

---

### Extended OpenAI Conversation

Home Assistant OS doesn't support setting environment variables, so we use the [Extended OpenAI Conversation](https://github.com/jekalmin/extended_openai_conversation) integration which allows configuring a custom base URL directly.

#### Step 1: Install HACS (if not already installed)

Follow the [HACS installation guide](https://hacs.xyz/docs/setup/download).

#### Step 2: Install Extended OpenAI Conversation

1. Open HACS in Home Assistant
2. Go to **Integrations**
3. Click **+ Explore & Download Repositories**
4. Search for "Extended OpenAI Conversation" and install it
5. Restart Home Assistant

#### Step 3: Add the integration

1. Go to **Settings** > **Devices & Services**
2. Click **Add Integration**
3. Select **Extended OpenAI Conversation**
4. Configure:
   - **Name:** Lumo (or whatever you like)
   - **API Key:** Your lumo-tamer API key
   - **Base URL:** `http://YOUR_SERVER_IP:3003/v1`
   - Leave other fields empty
5. Click **Submit**, then **Skip** on the next popup

---

### Create a voice assistant

1. Go to **Settings** > **Voice Assistants**
2. Click **Add Assistant**
3. Configure:
   - **Name:** "Lumo" (or whatever you like)
   - **Language:** Your preferred language
   - **Conversation agent:** Select the OpenAI integration you just added
   - **Prefer handling commands locally:** choose your preference
4. Click the **Gear Icon** next to your agent:
   - For standard OpenAI: Make sure **Assist** is checked
   - For Extended OpenAI Conversation, default options should be fine
   - Optionally, in **Instructions / Prompt template**, change personality instructions
   - Click **Submit** to save advanced settings
5. Click **Create** to add your new assistant

### Expose entities

1. Go to **Settings** > **Voice Assistants** > **Expose** tab
2. Select which entities Lumo can access

> **Tip:** Start with a few entities to test, add more later. Custom tool support is experimental - see [Custom Tools](custom-tools.md) for troubleshooting.

---

## Test Your Setup

### Start a conversation

1. Open Assist (top bar or mobile app)
2. Try: "What can you help me with?"

### Test device control

Try:
- "Turn on the living room light"
- "What's the temperature in the bedroom?"
- "Is the front door locked?"

> **Tip:** If you have Home Assistant's built-in intent recognition enabled, simple commands may be handled locally without reaching Lumo. To test Lumo specifically, try something conversational like "Hey Lumo, what lights are on right now?" or "Tell me about my home."

---

## Troubleshooting

### Slow responses

This is a known limitation. To improve response times:
- Reduce the number of exposed entities.
- Enable Home Assistant's built-in intent recognition to handle simple commands locally.

### Device control not working or Lumo saying "I can't do that"

This usually indicates Lumo has trouble understanding the exposed entities and tools.

- Ask Lumo "What devices do you know about?" or "What Home Assistant tools can you use?" to see what it can access.
- Ensure `customTools.enabled: true` in config.yaml
- Check that entities are exposed in HA (**Settings** > **Voice Assistants** > **Expose**)
- Enable debug logging for lumo-tamer (`server.log.level: debug`) and check logs for errors

### Home Assistant still shows "OpenAI" in some messages
This is expected. The integrations refer to OpenAI here and there (e.g., "Error talking to OpenAI"), while they're actually talking to Lumo through lumo-tamer.

---

## Further Reading

- [lumo-tamer README](../README.md)
- [lumo-tamer Custom Tools](custom-tools.md)
- [Home Assistant OpenAI integration](https://www.home-assistant.io/integrations/openai_conversation/)
- [Home Assistant Extended OpenAI Conversation](https://github.com/jekalmin/extended_openai_conversation)
