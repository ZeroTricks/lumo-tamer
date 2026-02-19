# lumo-tamer

```
                        ┌─────────────────┐     ┌─────────────────┐
┌─────────────────┐     │   lumo-tamer    │◄───►│  Home Assistant │
│  Proton Lumo    │     │                 │     └─────────────────┘
│                 │     │   Translation   │     ┌─────────────────┐
│  Your favorite  │◄───►│   Encryption    │◄───►│  Open WebUI     │
│  private AI     │     │   Tooling       │     └─────────────────┘
│                 │     │                 │     ┌─────────────────┐
└─────────────────┘     │                 │◄───►│   CLI           │ 
                        └─────────────────┘     └─────────────────┘
```

Use [Proton Lumo](https://lumo.proton.me/) in your favorite AI-enabled app or on the command line.

[Lumo](https://lumo.proton.me/about) is Proton's privacy-first AI assistant, powered by open-source LLMs running exclusively on Proton-controlled servers. Your prompts and responses are never logged, stored, or used for training. See Proton's [security model](https://proton.me/blog/lumo-security-model) and [privacy policy](https://proton.me/support/lumo-privacy) for details.

lumo-tamer is a lightweight local proxy that talks to Proton's Lumo API using the same protocol as the official web client. All data in transit is encrypted and subject to the same privacy protections as the official client. Think "proton-bridge for Lumo".

## Features

- OpenAI-compatible API server with experimental tool support.
- Interactive CLI, let Lumo help you execute commands, read, create and edit files.
- Sync your conversations with Proton to access them on https://lumo.proton.me or in mobile apps.


## Project Status

This is an unofficial, personal project in early stages of development, not affiliated with or endorsed by Proton. Rough edges are to be expected. Only tested on Linux. Use of this software may violate Proton's terms of service; use at your own risk. See [Full Disclaimer](#full-disclaimer) below.

## Prerequisites

- A Proton account (free works; [Lumo Plus](https://lumo.proton.me/) gives unlimited daily chats)
- Node.js 18+ & npm
- Go 1.24+ (for the `login` auth method)
- Docker (optional, for containerized setup)

## Quick Start

### 1. Install

```bash
git clone https://github.com/ZeroTricks/lumo-tamer.git
cd lumo-tamer
npm install && npm run build:all
# Optionally install command `tamer` globally
# If you don't, replace "tamer" with "npx lumo-tamer" in all commands
npm link
```

For Docker installation, see [Docker](#docker).

### 2. Authenticate

- Run `tamer auth login`
- Enter your Proton credentials and (optionally) 2FA code.

<details>
<summary><strong>I'm asked to enter a CAPTCHA</strong></summary>

Log in to Proton in a regular browser from the same IP first. This often clears the challenge. If you're still hit with a CAPTCHA challenge after, you might want to try an [alternative auth method](docs/authentication.md).
</details>

<details>
<summary><strong>Why do I have to enter my password?</strong></summary>

Proton's security model doesn't allow for a simple OAuth authentication. Your credentials are not saved or logged, and security tokens are stored encrypted.
Alternatively, you can authenticate via:
- **browser**: Extract tokens from a Chrome session. Required when you want to sync conversations with Lumo's webclient.
- **rclone**: Paste tokens from an rclone configuration with proton-drive.

See [docs/authentication.md](docs/authentication.md) for details and troubleshooting.

</details>

<details>
<summary><strong>I get an error saying no secure key storage is available.</strong></summary>

By default, lumo-tamer will encrypt fetched tokens with a password saved to your OS keychain. If this is unavailable (for example on headless environments), you can alternatively create a keyfile and guard it with your life:

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
</details>




### 3. Run

```bash
# One-shot: ask a question directly
tamer "What is 2+2?"

# Interactive CLI
tamer

# Start server
tamer server
```


## Usage

### Server

Set an API key in `config.yaml`:
```yaml
server:
  apiKey: my-super-secret-key
  port: 3003            #Optional, change listening port
  bodyLimit: "500kb"    #Optional, adjust bodyLimit for larger client payloads
```

Then run:
```bash
tamer server
```

Then, point your favorite OpenAI-compatible app to `https://yourhost:3003/v1` and provide your API key.
See [API clients](#api-clients) for some inspiration.

> **Security:** Keep your API key private and make sure lumo-tamer is only accessible from your local network, not the internet.

> **Tip:** Run `tamer server` as a docker service or use a tool like nohup to run it in the background.

### CLI

Talk to Lumo from the command line like you would via the web interface:
```bash
tamer                   # use Lumo interactively
tamer "make me laugh"   # one-time prompt
```

To give Lumo access to your files and let it execute commands locally, set `cli.localActions.enabled: true` in `config.yaml` (see [Local Actions](#local-actions-cli)).  
You can ask Lumo to give you a demo of its capabilities, or see this [demo chat](docs/demo-cli-chat.md).

### In-chat commands

Both CLI and API accept a few in-chat commands. Realistically, you'll only use `/title` and `/quit`.

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/title <text>` | Set conversation title |
| `/save`, `/sync` | Sync conversations to Proton server (not needed when `conversations.sync.autoSync: true`)|
| `/refreshtokens` | Manually refresh auth tokens  (not needed when `auth.autoRefresh.enabled: true`) |
| `/logout` | Revoke session and delete tokens |
| `/quit` | Exit the app (CLI only) |

## Configuration

Add configuration options to `config.yaml`. Find all options in [`config.defaults.yaml`](config.defaults.yaml), but don't edit this file directly.

Below is a non-exhaustive overview of the most common config sections and their options. Except for some auth settings (which are set by `tamer auth`), all settings are optional. By default, lumo-tamer is conservative: experimental or resource-heavy features are disabled. 

### Global options

Options in sections `log`, `conversations` and `commands` can be set globally (used by server and CLI), and can optionally be overwritten within `cli` and `server`.  
For example: set the default log output to your terminal at the `info` level, while the CLI logs to a file instead.
```yaml
log:
  # Levels: trace, debug, info, warn, error, fatal
  level: "info"
  # "stdout" or "file"
  target: "stdout"

cli:
  log:
    filePath: "lumo-tamer-cli.log"
```

### Web Search

Enable Lumo's native web search (and other external tools: weather, stock, cryptocurrency):

```yaml
server:
  enableWebSearch: true

cli:
  enableWebSearch: true
```

### Instructions

Customize instructions with `server.instructions.template` and `cli.instructions.template`. See [`config.defaults.yaml`](config.defaults.yaml) for more options.

Instructions from API clients will be inserted in the main template. If you can, put instructions on personal preferences within your API client and only use `server.instructions` to define the internal interaction between Lumo and lumo-tamer.


> **Note:** Under the hood, lumo-tamer injects instructions into normal messages (the same way it is done in Lumo's webclient). Instructions set in the webclient's personal or project settings will be ignored and left unchanged.

### Custom Tools (Server)

Let Lumo use tools provided by your OpenAI-compatible client.

```yaml
server:
  customTools:
    enabled: true
```

> **Warning:** Custom tool support is experimental and can fail in various ways. Experiment with `server.instructions` settings to improve results. See [Custom Tools](docs/custom-tools.md) for details, tweaking, and troubleshooting. 


### Local Actions (CLI)

Let Lumo read, create and edit files, and execute commands on your machine:

```yaml
cli:
  localActions:
    enabled: true
    fileReads:
      enabled: true
    executors:
      bash: ["bash", "-c"]
      python: ["python", "-c"]
```

The CLI always asks for confirmation before executing commands or applying file changes. File reads are automatic.  
Configure available languages for your system in `executors`. By default, `bash`, `python`, and `sh` are enabled.  
See [Local Actions](docs/local-actions.md) for further configuration and troubleshooting.

### Conversation Sync

```yaml
conversations:
  sync:
    enabled: true
    projectName: "lumo-tamer" # project conversations will belong to
    autoSync: true
```
> **Note:** Only supported with the `browser` authentication method. Enabling conversation sync requires additional user secrets; if you enable this after initial setup, re-run `tamer auth browser`.

> **Warning:** Projects in Lumo have a limit on the number of conversations per project. When hit, sync will fail. Deleting conversations won't help. Use a new `projectName` to work around this. See [#16](https://github.com/ZeroTricks/lumo-tamer/issues/16).


## API clients

The server implements a subset of OpenAI-compatible endpoints and has so far been tested with a handful of clients only.

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | [OpenAI chat completions](https://platform.openai.com/docs/api-reference/chat/create) |
| `POST /v1/responses` | [OpenAI responses API](https://platform.openai.com/docs/api-reference/responses/create) |
| `GET /v1/models` | List available models ('lumo') |
| `GET /health` | Health check |
| `GET /metrics` | [Prometheus metrics](docs/development.md#metrics) |

Following API clients have been tested and are known to work.

### Home Assistant

See the [full guide](docs/howto-home-assistant.md). TLDR:

- Pass the environment variable `OPENAI_BASE_URL=http://yourhost:3003/v1` to Home Assistant.
- Add the OpenAI integration and create a new Voice Assistant that uses it.
- To let Lumo control your devices, set `server.customTools.enabled: true` in `config.yaml` (Experimental, see [Custom Tools](docs/custom-tools.md)).
- Open HA Assist in your dashboard or phone and chat away.

### OpenClaw
Add Lumo to `models.providers` in your OpenClaw config. [Example](docs/openclaw.md).


### Nanocoder
Status: very experimental.

Nanocoder sends many instructions and relies on Lumo calling **a lot** of tools. Lumo will misroute many tool calls and will retry by calling tools with wrong parameters. Basic usage works, but don't expect a fully working coding assistant experience.

### Open WebUI

For your convenience, an Open WebUI service is included in `docker-compose.yml`. Launch `docker compose up open-webui` and open `http://localhost:8080`

> **Note:** Open WebUI will by default prompt Lumo for extra information (to set title and tags). Disable these in Open WebUI's settings to avoid cluttering your debugging experience.

### cURL

```bash
curl http://localhost:3003/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "lumo",
    "messages": [{"role": "user", "content": "Tell me a joke."}],
    "stream": true
  }'
```

### Untested API clients

Many clients are untested with lumo-tamer but should work if they only use the `/v1/responses` or `/v1/chat/completions` endpoints. As a rule of thumb: basic chatting will probably work, but the more a client relies on custom tools, the more the experience is degraded.  
To test an API client, increase log levels on both the client and lumo-tamer: `server.log.level: debug` and check for errors.

Please share your experiences with new API clients (both issues and successes) in [the project discussions](https://github.com/ZeroTricks/lumo-tamer/discussions/new?category=general)!


### Docker

It is recommended to run lumo-tamer's server in a Docker container for a more service-like experience.

#### Install

```bash
git clone https://github.com/ZeroTricks/lumo-tamer.git
cd lumo-tamer
docker compose build tamer
# Create secret key to encrypt the token vault (or alternatively, use another secrets manager)
mkdir -p secrets && chmod 700 secrets
openssl rand -base64 32 > secrets/lumo-vault-key
chmod 600 secrets/lumo-vault-key
```

#### Configure

Create `config.yaml` with your settings. See [Configuration](#configuration) for all options.

#### Authenticate

```bash
docker compose run --rm -it tamer auth login
```

Enter your Proton email, password, and 2FA code (if enabled).

<details>
<summary><strong>I'm asked to enter a CAPTCHA</strong></summary>

Log in to Proton in a regular browser from the same IP first. This often clears the challenge. If you're still hit with a CAPTCHA challenge after, you might want to try an [alternative auth method](docs/authentication.md).
</details>

<details>
<summary><strong>Why do I have to enter my password?</strong></summary>

Proton's security model doesn't allow for a simple OAuth authentication. Your credentials are not saved or logged, and security tokens are stored encrypted. [Read further](docs/authentication.md#security) for more information or other authentication methods.
</details>

#### Run
Server:
```bash
docker compose up tamer # starts server by default
```
CLI:
```bash
docker compose run --rm -it -v ./some-dir:/dir/ tamer cli
```

> **Note:** Running the CLI within Docker may not be very useful:
> - Lumo will not have access to your files unless you mount a directory.
> - The image is Alpine-based, so your system may not have the commands Lumo tries to run. You can change config options `cli.localActions.executors` and `cli.instructions.forLocalActions` to be more explicit what commands Lumo should use, or you can rebase the `Dockerfile`.



## Further Reading

See [docs/](docs/) for detailed documentation:

- [Authentication](docs/authentication.md): Auth methods, setup and troubleshooting
- [Conversations](docs/conversations.md): Conversation persistence and sync
- [Custom Tools](docs/custom-tools.md): Tool support for API clients
- [Local Actions](docs/local-actions.md): CLI file operations and code execution
- [Development](docs/development.md): Development setup and workflow
- [Upstream Files](docs/upstream.md): Proton WebClients files, shims and path aliases

## Roadmap

- **Getting feedback**: I'm curious how people use lumo-tamer and what they run into.
- **Test more API clients**: Test new & improve existing integrations with API clients.
- **Better auth**: Make the `login` method support conversation sync; find out if SimpleLogin's OAuth can be used.

## Full Disclaimer

- **Unofficial project.** This project is not affiliated with, endorsed by, or related to Proton AG in any way.
- **Terms of service.** Use of this software may violate Proton's terms of service.
- **Rate limiting and token usage.** Although care was put into making the app behave, it may make many API calls, potentially getting you rate-limited, or burn through your allowed tokens quickly. I have not experienced either of these issues on Lumo Plus.
- **Security.** This app handles Proton user secrets. Although the code is vetted to the best of my knowledge and follows best practices, this is not my area of expertise. Please verify for yourself. Using the app without full conversation sync will only fetch API tokens and will not fetch the user's PGP keys in any way.
- **AI-assisted development.** This code was written with the extensive use of Claude Code.
- **Tool execution.** Enabling tools gives Lumo the power to execute actions client-side (API or CLI). I am not responsible for Lumo's actions. lumo-tamer does not prevent prompt injection.

## License

GPLv3 - See [LICENSE](LICENSE). Includes code from [Proton WebClients](https://github.com/ProtonMail/WebClients).

❤️
