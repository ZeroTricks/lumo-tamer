# lumo-tamer

Use [Proton Lumo](https://lumo.proton.me/) on the command line or integrate it in your favorite AI-enabled app.

[Lumo](https://lumo.proton.me/about) is Proton's privacy-first AI assistant, powered by open-source LLMs running exclusively on Proton-controlled servers. Your prompts and responses are never logged, stored, or used for training. See Proton's [security model](https://proton.me/blog/lumo-security-model) and [privacy policy](https://proton.me/support/lumo-privacy) for details.

lumo-tamer is a lightweight local proxy that talks to Proton's Lumo API using the same protocol as the official web client. All data in transit is encrypted and subject to the same privacy protections as the official client. Think "proton-bridge for Lumo".

## Features

- Server: OpenAI-compatible API
- CLI: Interactive mode, let Lumo help you executing commands, read, create and edit files.
- Sync your conversations with Proton to access them on https://lumo.proton.me or in mobile apps.


## Project Status

This is an unofficial, personal project in early stages of development, not affiliated with or endorsed by Proton. Rough edges are to be expected. Only tested on Linux. Use of this software may violate Proton's terms of service; use at your own risk. See [Full Disclaimer](#full-disclaimer) below.

## Prerequisites

- A Proton account (free works; [Lumo Plus](https://lumo.proton.me/) gives unlimited chats and faster responses)
- Node.js 18+ & npm
- Go 1.24+ (for the `login` auth method)
- Docker (optional, for containerized setup)

## Quick Start

### 1. Install

```bash
git clone https://github.com/ZeroTricks/lumo-tamer.git
cd lumo-tamer
npm install && npm run build:all
# Optionally install globally, so you can use command `tamer` everywhere
npm link
```

For Docker installation, see [Docker](#docker).

### 2. Authenticate

- Run `tamer auth login`
- Enter your Proton credentials and (optionally) 2FA code.

> **Tip:** If you hit a CAPTCHA, try logging in to Proton in any regular browser from the same IP first. This may clear the challenge for subsequent login attempts.

Alternative methods:
- **browser**: Extract tokens from a Chrome session. Required when you want to sync conversations with Lumo's webclient.
- **rclone**: Paste tokens from an rclone configuration with proton-drive.

See [docs/authentication.md](docs/authentication.md) for details and troubleshooting.


### 3. Run

```bash
# One-shot: ask a question directly
tamer "What is 2+2?"

# Interactive mode
tamer
```

Other commands: `tamer server` (start API server), `tamer auth` (authenticate). See [Usage](#usage) for details.



## Configuration (optional)

Add configuration options to `config.yaml`. Use [`config.defaults.yaml`](config.defaults.yaml) for inspiration. Don't edit config.defaults.yaml directly.

Apart from auth settings (which are set by `tamer auth`), all settings are optional. By default, lumo-tamer is conservative: experimental or resource-heavy features are disabled.

Options in sections `log`, `conversations`, `commands` and `tools` can be set globally (used by server & cli), and can be overwritten within `cli` and `server` sections.


For example:
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

This sets the default log output to your terminal at the `info` level, while the CLI logs to a file instead.

### Instructions

Set general and tool-specific instructions for the CLI and server with `cli.instructions.default` / `cli.instructions.forTools` and `server.instructions.default` / `server.instructions.forTools` respectively. Don't start from scratch but copy the defaults from [`config.defaults.yaml`](config.defaults.yaml) as a base and experiment from there.

> **Note:**
> - lumo-tamer injects these instructions into the first message you send (the same way the Lumo's webclient does under the hood). Instructions set in the webclient's personal or project settings will be ignored.
> - Clients connecting to the lumo-tamer server can send their own instructions, which will overwrite `server.instructions.default`.

### Conversation sync

Enable conversation sync in `config.yaml`:

> **Note:** Only supported with the `browser` authentication method. Enabling conversation sync requires additional user secrets; if you enable this after initial setup, re-run `tamer auth browser`.

```yaml
conversations:
  sync:
    enabled: true
    projectName: "lumo-tamer" # project conversations will belong to
    autoSync: true
```

> **Warning:** Projects in Lumo have a limit on the number of conversations. When hit, sync will fail. Deleting conversations won't help. Use a new `projectName` to work around this. See [#16](https://github.com/ZeroTricks/lumo-tamer/issues/16).

### Tools

`config.yaml`:

```yaml
tools:
  # Enable Lumo's native web_search tool (and other external tools: weather, stock, cryptocurrency)
  enableWebSearch: true
```

#### CLI

```yaml
cli:
  tools:
    # enable Lumo to create and edit files, and run commands in your terminal
    enabled: true
    # enable Lumo to read text-based files on your system
    fileReads:
      enabled: true
```
> **Tip:** When you enable CLI tools, consider adapting `cli.instructions.forTools` to reference the languages and shells available in your environment.

#### Server

```yaml
server:
  tools:
    # enable Lumo to use tools provided by your OpenAI client
    enabled: true 
```


> **Warning:** Custom tool support is experimental and can fail in various ways. See [docs/custom-tools.md](docs/custom-tools.md) for details, configuration, and troubleshooting.

## Usage

### CLI

Run `tamer` or `npm run cli`.

Talk to Lumo from the command line like you would via the web interface. To let Lumo execute commands, read, create and edit files, set `cli.tools.enabled: true` in `config.yaml`. The app will always ask for your confirmation before executing commands.

You can ask Lumo to give you a demo of its CLI capabilities, or see this [demo chat](docs/demo-cli-chat.md) for inspiration.

### In-chat commands

A few in-chat commands are supported in both CLI and API mode. Send the command as a message. Realistically, you'll only use `/title` and `/quit`.

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/title <text>` | Set conversation title |
| `/save`, `/sync` | Sync conversations to Proton server (not needed when `conversations.sync.autoSync: true`)|
| `/refreshtokens` | Manually refresh auth tokens  (not needed when `auth.autoRefresh.enabled: true`) |
| `/logout` | Revoke session and delete tokens |
| `/quit` | Exit the app (CLI only) |

### API

Start by setting `server.apiKey` in `config.yaml`
Run `tamer server`

Now, connect your favorite OpenAI-compatible app.

**Warning:** The API implements a subset of OpenAI-compatible endpoints and has only been tested with a handful of clients (Home Assistant and Open WebUI).

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | [OpenAI chat completions](https://platform.openai.com/docs/api-reference/chat/create) |
| `POST /v1/responses` | [OpenAI responses API](https://platform.openai.com/docs/api-reference/responses/create) |
| `GET /v1/models` | List available models (just 'lumo') |
| `GET /health` | Health check |


#### cURL

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

#### Home Assistant

**Setup**

- Pass the environment variable `OPENAI_BASE_URL=http://localhost:3003/v1` when launching Home Assistant.
- Add the OpenAI integration and follow the steps from the [Home Assistant guide](https://www.home-assistant.io/voice_control/assist_create_open_ai_personality/).
- Open HA Assist in your dashboard or phone and chat away.

**Tweak**

- When `conversations.sync` is enabled, set `conversations.deriveIdFromUser: true` to group messages into conversations (uses the `user` field from the request, which HA sets to its conversation ID).
- To let Lumo read the status of your home or control your devices, set `server.tools.enabled: true`. (Experimental, see [Tool Calls](#tool-calls).)
- To improve tool call success rate:
  - Experiment with changing the instructions sent by Home Assistant.
  - Limit the number of exposed entities in Home Assistant's settings.
  - Limit the number of entity aliases.

#### Open WebUI

For your convenience, an Open WebUI service is included in `docker-compose.yml`. Launch `docker compose up open-webui` and open `http://localhost:8080`

> **Note:** Open WebUI will by default prompt Lumo for extra information (to set title and tags). Disable these in Open WebUI's settings to avoid cluttering your debugging experience.




### Docker

It is recommended to run lumo-tamer's server in a Docker container for a more service-like experience.

#### Install

```bash
git clone https://github.com/ZeroTricks/lumo-tamer.git
docker compose build tamer
# use docker swarm secrets for something more secure
mkdir -p secrets && chmod 700 secrets
openssl rand -base64 32 > secrets/lumo-vault-key
chmod 600 secrets/lumo-vault-key
```

#### Authenticate

```docker compose run --rm -it tamer tamer auth```

#### Run
Run server:
```docker compose up tamer```

Running the CLI within Docker is possible but usability may be limited:
- The image is Alpine-based, so your system may not have the commands Lumo tries to run. You can change `cli.instructions.forTools` in `config.yaml` to be more explicit what commands it should use, or you can rebase the `Dockerfile`.
- Mount a directory to give Lumo access to your files:

```bash
docker compose run --rm -it -v ./some-dir:/dir/ tamer tamer
```

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
- **Test more API clients**: Test & improve integration with more API clients such as OpenClaw and nanocoder.
- **Simpler auth**: Make the `login` method support conversation sync so you don't need a browser.
- **On-disk conversation cache**: Encrypted local cache to reduce server load and enable full text search.

## Full Disclaimer

- **Unofficial project.** This project is not affiliated with, endorsed by, or related to Proton AG in any way.
- **Terms of service.** Use of this software may violate Proton's terms of service.
- **Rate limiting and token usage.** Although care was put into making the app behave, it may make many API calls, potentially getting you rate-limited, or burn through your allowed tokens quickly. I have not experienced either of these issues on Lumo Plus.
- **Security.** This app handles Proton user secrets. Although the code is vetted to the best of my knowledge and follows best practices, this is not my area of expertise. Please verify for yourself. Using the app without full conversation sync will only fetch API tokens and will not fetch user (PGP) keys in any way.
- **API compatibility.** The API implements a subset of OpenAI-compatible endpoints and has been tested minimally.
- **AI-assisted development.** This code was written with the extensive use of Claude Code.
- **Tool execution.** Enabling tools gives Lumo the power to execute actions client-side (API or CLI). I am not responsible for Lumo's actions. The CLI will always ask for your confirmation before executing commands.

## License

GPLv3 - See [LICENSE](LICENSE). Includes code from [Proton WebClients](https://github.com/ProtonMail/WebClients).

❤️
