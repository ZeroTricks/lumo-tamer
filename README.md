# lumo-tamer

Use Proton Lumo on the command line or integrate it in your favorite AI-enabled app.

## Features

- Server: OpenAI-compatible API
- CLI: Interactive mode, let Lumo help you executing commands, read, create and edit files.
- Sync your conversations with Proton to access them on https://lumo.proton.me or in mobile apps.


## Project Status

This is an unofficial, personal project in early stages of development, not affiliated with or endorsed by Proton. Rough edges are to be expected. Only tested on Linux. Use of this software may violate Proton's terms of service; use at your own risk. See [Full Disclaimer](#full-disclaimer) below.

## Prerequisites

- Node.js 18+ & npm
- Go 1.24+ (optional, only for the `login` auth method)
- Docker (optional, for containerized setup)

## Quick Start

### 1. Install

```bash
git clone https://github.com/ZeroTricks/lumo-tamer.git
cd lumo-tamer
npm install
npm run build
# Optionally install globally, so you can use command `tamer` everywhere
npm link
```

A [`Makefile`](Makefile) is included as a convenience wrapper. Run `make help` to see available shortcuts.

For Docker installation, see [Docker](#docker).

### 2. Authenticate

Authenticating to Proton is not straightforward: different flows depending on user settings (2FA, hardware keys), CAPTCHA challenges, and auth tokens not having the necessary scopes. The good news is you only have to log in "once"; after that, secrets are securely saved in an encrypted vault and tokens are refreshed automatically.

Choose one of three methods:

#### Browser
Use a Chrome browser with remote debugging enabled to log in. Tokens will be extracted "once". This is the only method that supports full conversation sync, and it lets you pass a CAPTCHA in the browser if needed.

To launch a browser with remote debugging:

- Use your own Chrome(-based) browser with remote debugging enabled: `chrome --remote-debugging-port=9222`. You'll probably need to add more command line arguments, like `--user-data-dir=<custom dir> --remote-debugging-address=0.0.0.0 --remote-debugging-allowed-origins=*` See [Chrome DevTools Protocol documentation](https://chromedevtools.github.io/devtools-protocol/) for more information.
- Use the provided Docker image: `docker compose up lumo-tamer-browser` (access browser GUI at http://localhost:3001)

Once the browser is running, use it to log in to https://lumo.proton.me .

#### Login
A secure and lightweight option where you provide your credentials in a prompt. Requires Go. No support for CAPTCHA or conversation sync.

> **Tip:** If you hit a CAPTCHA, try logging in to Proton in any regular browser from the same IP first. This may clear the challenge for subsequent login attempts.

```bash
# Requires Go 1.24+
cd src/auth/login/go && go build -o ../../../../dist/proton-auth && cd -
```

#### Rclone
Use rclone to log in and copy the tokens from its config file. No conversation sync.

> **Warning:** This method reuses tokens/keys that are stored insecurely by rclone. Use it as a fallback if the other two methods don't work. If you already use rclone for Proton Drive, add a separate remote for lumo-tamer, as lumo-tamer will refresh tokens and invalidate the ones used by rclone.

1. Install rclone
2. Add a "proton drive" remote named "lumo-tamer" as described here: https://rclone.org/protondrive/. If you hit a CAPTCHA, try logging in to Proton in any regular browser from the same IP first.
3. Test if rclone succeeds: `rclone about lumo-tamer:`
4. Find your rclone config file: `~/.config/rclone/rclone.conf` (Linux/macOS) or `%APPDATA%\rclone\rclone.conf` (Windows)
5. Copy the tokens under lumo-tamer manually or `grep -A 6 "lumo-tamer" rclone.conf`


Whichever method you choose, run `tamer-auth` and follow the steps.

Read more tips on setup and troubleshooting in [docs/authentication.md](docs/authentication.md).


### 3. Run

```bash
# One-shot: ask a question directly
tamer "What is 2+2?"

# Interactive mode
tamer
```

Other commands: `tamer-server` (start API server), `tamer-auth` (authenticate). See [Usage](#usage) for details.



## Configuration (optional)

Add configuration options to `config.yaml`. Use [`config.defaults.yaml`](config.defaults.yaml) for inspiration. Don't edit config.defaults.yaml directly.

Apart from auth settings (which are set by `tamer-auth`), all settings are optional. By default, lumo-tamer is conservative: experimental or resource-heavy features are disabled.

Options in sections `log`, `conversations`, `commands` and `tools` can be set globally (server & cli), and can be overwritten within `cli` and `server`.


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
> - Clients connecting to the lumo-tamer server can send their own instructions, which will overwrite (or be appended to, depending on `server.instructions.append`) `server.instructions.default`.

### Conversation sync

> **Note:** Only supported with the `browser` authentication method. Enabling conversation sync requires additional user secrets; if you enable this after initial setup, re-run `tamer-auth`.

Enable conversation sync in `config.yaml`:

```yaml
conversations:
  deriveIdFromFirstMessage: true
  sync:
    enabled: true
    spaceName: "lumo-tamer" # this is the project conversations will belong to
    autoSync: true
```

> **Warning:** Having too many conversations in your project will slow down app/server startup and may cause rate limiting. Clean up your conversations regularly or use a new spaceName.

### Tools

`config.yaml`:

```yaml
tools:
  # Enable Lumo's native web_search tool (and other external tools: weather, stock, cryptocurrency)
  enableWebSearch: true
```

```yaml
cli:
  tools:
    # enable Lumo to create and edit files, and run commands in your terminal
    enabled: true
    # enable Lumo to read text-based files on your system
    enableFileReads: true 
```
> **Tip:** When you enable CLI tools, consider adapting `cli.instructions.forTools` to reference the languages and shells available in your environment.

```yaml
server:
  tools:
    # enable Lumo to use tools provided by your OpenAI client
    enabled: true 
```


> **Warning:** Server-side tool support is experimental. Under the hood, lumo-tamer instructs Lumo to send tool calls as JSON, which it then detects and translates into real tool calls. This can fail because:
> - Too many tools are provided by the API client.
> - Lumo tries to call tools server-side, which fails, so Lumo reports tools as unavailable. If this happens, try manually asking it to output the JSON.
> - Lumo sets the wrong tool name or arguments.
> - JSON code blocks are not properly detected or parsed by lumo-tamer.
>
> This requires some trial and error. Experiment with `server.instructions.forTools` to improve results.

## Usage

### CLI

Run `tamer` or `npm run cli`.

Use Lumo from the command line. To let Lumo execute commands, read, create and edit files, set `cli.tools.enabled: true` in `config.yaml`. The app will always ask for your confirmation before executing commands.

See this [demo chat](docs/demo-cli-chat.md) session for inspiration.

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
Run `tamer-server`

Now, connect your favorite OpenAI-compatible app.

**Warning:** The API implements a subset of OpenAI-compatible endpoints and has only been tested with a handful of clients.

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
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "stream": true
  }'
```

#### Home Assistant

**Setup**

- Pass the environment variable `OPENAI_BASE_URL=http://localhost:3003/v1` when launching Home Assistant.
- Add the OpenAI integration and follow the steps from the [Home Assistant guide](https://www.home-assistant.io/voice_control/assist_create_open_ai_personality/).
- Open HA Assist in your dashboard or phone and chat away.

**Tweak**

- When `conversations.sync` is enabled, you may want to set `conversations.deriveIdFromFirstMessage: true` to group messages properly.
- To let Lumo read the status of your home or control your devices, set `server.tools.enabled: true`.
- To improve tool success rate:
  - Experiment with the instructions sent by Home Assistant.
  - Limit the number of exposed entities in Home Assistant's settings.
  - Limit the number of entity aliases.

#### Open WebUI

For your convenience, an Open WebUI service is included in `docker-compose.yml`. Fill in the API key you configured earlier in `OPENAI_API_KEYS` and launch `docker compose up open-webui`.

> **Note:** Open WebUI will by default prompt Lumo for extra information (to set title and tags). Disable these in Open WebUI's settings to avoid cluttering your debugging experience.




### Docker

It is recommended to run lumo-tamer's server in a Docker container for a more service-like experience.

#### Install

```bash
git clone https://github.com/ZeroTricks/lumo-tamer.git
docker compose build app
# use docker swarm secrets for something more secure
mkdir -p secrets && chmod 700 secrets
openssl rand -base64 32 > secrets/lumo-vault-key
chmod 600 secrets/lumo-vault-key
```

#### Authenticate

```docker compose run --rm -it app tamer-auth```

#### Run
Run server:
```docker compose up app```

Running the CLI within Docker is possible but usability may be limited:
- The image is Alpine-based, so your system may not have the commands Lumo tries to run. You can change `cli.instructions.forTools` in `config.yaml` to be more explicit what commands it should use, or you can rebase the `Dockerfile`.
- Mount a directory to give Lumo access to your files:

```bash
docker compose run --rm -it -v ./some-dir:/dir/ app tamer
```

## Further Reading

See [docs/](docs/) for detailed documentation:

- [Authentication](docs/authentication.md): Auth methods, setup and troubleshooting
- [Conversations](docs/conversations.md): Conversation persistence and sync
- [Development](docs/development.md): Development setup and workflow
- [Upstream Files](docs/upstream.md): Proton WebClients files, shims and path aliases

## Roadmap

- **Getting feedback** I'm curious how people use lumo-tamer and what they run into.
- **More API endpoints** Expand OpenAI compatibility.
- **Simpler auth** Make the `login` method support conversation sync so you don't need a browser.
- **On-disk conversation cache** Encrypted local cache to reduce server load and enable full text search.

## Full Disclaimer

- **Unofficial project.** This project is not affiliated with, endorsed by, or related to Proton AG in any way.
- **Terms of service.** Use of this software may violate Proton's terms of service.
- **Rate limiting and token usage.** Although care was put into making the app behave, it may make many API calls, potentially getting you rate-limited, or burn through your allowed tokens quickly. I have not experienced either of these issues on Lumo Plus.
- **Security.** This app handles Proton user secrets. Although the code is vetted to the best of my knowledge and follows best practices, this is not my area of expertise. Please verify for yourself. Using the app without full conversation sync will only fetch API tokens and will not fetch user (PGP) keys in any way.
- **API compatibility.** The API implements a subset of OpenAI-compatible endpoints and has been tested minimally.
- **AI-assisted development.** This code was written with the extensive use of Claude Code. It's 2026, get over it.
- **Tool execution.** Enabling tools gives Lumo the power to execute actions client-side (API or CLI). I am not responsible for Lumo's actions. The CLI will always ask for your confirmation before executing commands.

## License

GPLv3 - See [LICENSE](LICENSE). Includes code from [Proton WebClients](https://github.com/ProtonMail/WebClients).

❤️
