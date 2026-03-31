# Tools

This document covers all tool-related features in lumo-tamer.

---

## Terminology

| Term | Description |
|------|-------------|
| **Native tools** | Tools executed by Lumo/Proton via SSE. Internal (`proton_info`) are always enabled; external (`web_search`, `weather`, `stock`, `cryptocurrency`) are configurable. |
| **Custom tools** | Non-native tools called via JSON text output. Prefixed with `tools.prefix` (default: `user:`). |
| **Server tools** | Custom tools executed by lumo-tamer itself (e.g., `user:lumo_search`). |
| **Client tools** | Custom tools defined by API clients (e.g., Home Assistant), returned for client-side execution. |
| **Local tools** | CLI-only code block handlers for file operations and code execution. |
| **Misrouted** | When Lumo incorrectly routes a custom tool through its native pipeline. |

### Tool Flow

```
API Request
    |
    v
+-- Native tools --> Proton executes server-side
|
+-- Custom tools (JSON in response)
    |
    +-- Server tools --> lumo-tamer executes, loops back
    |
    +-- Client tools --> Returned to API client for execution

CLI Request
    |
    +-- Native tools --> Proton executes server-side
    |
    +-- Local tools --> CLI detects code blocks, executes locally
```

---

## Configuration

### Server Tools Config

```yaml
server:
  tools:
    # Enable Lumo's native external tools (web_search, weather, stock, cryptocurrency)
    # Internal native tools (proton_info) are always enabled.
    native:
      enabled: false

    # Prefix for custom tool names (client + server tools)
    # Applied to definitions sent to Lumo, stripped from responses.
    prefix: "user:"

    # Server-side tools (search, etc.) executed by lumo-tamer
    server:
      enabled: false

    # Client tool detection - returns tool calls to API clients
    client:
      enabled: false
```

### CLI Tools Config

```yaml
cli:
  tools:
    # Enable Lumo's native external tools
    native:
      enabled: false

    # Local tools: code block detection and execution
    local:
      enabled: false
      fileReads:
        enabled: true
        maxFileSize: "360kb"
      executors:
        bash: ["bash", "-c"]
        python: ["python", "-c"]
        sh: ["sh", "-c"]
```

---

## Native Tools

Lumo has built-in tools executed server-side by Proton:

| Tool | Description |
|------|-------------|
| `proton_info` | Proton product information (always enabled) |
| `web_search` | Web search via Proton's backend |
| `weather` | Weather data |
| `stock` | Stock prices |
| `cryptocurrency` | Cryptocurrency prices |

Enable external native tools:

```yaml
server:
  tools:
    native:
      enabled: true

cli:
  tools:
    native:
      enabled: true
```

---

## Client Tools (API)

Client tools allow API clients (Home Assistant, Open WebUI, etc.) to provide tools that Lumo can call.

### Warning

Client tool support is experimental. Tool calls can fail because of:

- **Too many tools**: Lumo gets confused with many tools or long instructions.
- **Misrouted calls**: Lumo routes custom tools through its native pipeline, which fails. lumo-tamer bounces these back, adding latency.
- **Wrong tool/arguments**: Lumo sets wrong tool names or arguments.
- **Detection failures**: JSON code blocks not properly detected.

**Privacy note**: When Lumo misroutes a tool call, the tool name and arguments are sent to Proton's servers unencrypted.

### Quick Start

1. Enable client tools:
   ```yaml
   server:
     tools:
       client:
         enabled: true
   ```

2. Configure your API client to use tools as normal.

3. lumo-tamer intercepts Lumo's responses, detects tool calls, and returns them in OpenAI format.

### How It Works

1. **Tool definitions are prefixed** with `tools.prefix` (e.g., `get_weather` becomes `user:get_weather`)
2. **Instructions are assembled** from template with tool definitions as JSON
3. **Instructions are injected** into a user message
4. **Lumo outputs tool calls** as JSON in code fences:
   ````
   I'll check the weather for you.
   ```json
   {"name": "user:get_weather", "arguments": {"city": "Paris"}}
   ```
   ````
5. **lumo-tamer detects and extracts** tool calls, strips the prefix, returns in OpenAI format
6. **Your client executes** the tool and sends results back

### Misrouted Tool Calls

Sometimes Lumo routes a custom tool through its native SSE pipeline instead of outputting JSON text.

1. lumo-tamer detects the misrouted call (tool name not in known native tools)
2. Suppresses Lumo's error response
3. Bounces the call back with `instructions.forToolBounce`
4. Lumo re-outputs the tool call as JSON text
5. Normal detection extracts the tool call

This is transparent to API clients.

### Instructions Template

Customize how instructions are sent to Lumo:

```yaml
server:
  instructions:
    # Template variables: tools, clientInstructions, forTools, fallback, prefix
    template: |
      {{#if tools}}
      {{forTools}}
      {{/if}}

      {{#if clientInstructions}}
      {{clientInstructions}}
      {{else}}
      {{fallback}}
      {{/if}}

      {{#if tools}}
      Below are all the custom tools you can use...
      {{tools}}
      {{/if}}

    forTools: |
      === CUSTOM TOOL PROTOCOL ===
      The tools below are CUSTOM tools, prefixed with `{{prefix}}`.
      You MUST call them by outputting JSON in a code block...
      === END PROTOCOL ===

    # Where to inject: "first" or "last" user message
    injectInto: "first"

    # Sent when Lumo misroutes a tool call
    forToolBounce: |
      You tried to call a custom tool using your built-in tool system...
```

### Troubleshooting

**Tool calls not detected**
- Ensure `tools.client.enabled: true`
- Check that Lumo outputs valid JSON in code fences
- Review `instructions.forTools`

**Wrong tool names**
- Check `tools.prefix` - it's added to definitions and stripped from responses

**Lumo says "I don't have access to that tool"**
- This is a misrouted call being bounced - should resolve automatically

---

## Server Tools

Server tools are custom tools executed by lumo-tamer itself, not passed to API clients.

### Available Server Tools

| Tool | Description |
|------|-------------|
| `lumo_search` | Search conversation history by title and message content |

### Enable

```yaml
server:
  tools:
    server:
      enabled: true
```

Server tools are prefixed with both `tools.prefix` and an internal `lumo_` prefix (e.g., `user:lumo_search`).

---

## Local Tools (CLI)

Local tools allow the CLI to execute code blocks and file operations on your machine.

### Status

The CLI is a proof of concept. Local tools work, but the UI is basic. Development focus is on API custom tools and third-party clients like [Nanocoder](https://github.com/AbanteAI/nanocoder).

### Quick Start

1. Enable local tools:
   ```yaml
   cli:
     tools:
       local:
         enabled: true
   ```

2. Start the CLI:
   ```bash
   tamer
   ```

3. Lumo can now read files, make edits, and execute code. See [demo chat](demo-cli-chat.md) for examples.

### Configuration

```yaml
cli:
  tools:
    local:
      enabled: true
      fileReads:
        enabled: true
        maxFileSize: "512kb"
      executors:
        bash: ["bash", "-c"]
        python: ["python", "-c"]
        sh: ["sh", "-c"]
```

### User Confirmation

| Action | Confirmation Required |
|--------|----------------------|
| `read` | No - automatic |
| `edit` | Yes - shows diff |
| `create` | Yes - shows content |
| Code execution | Yes - shows command |

### How It Works

Lumo outputs code blocks with specific language tags. The CLI detects these and executes them locally:

1. `CodeBlockDetector` detects triple-backtick code blocks
2. `BlockHandler.matches()` checks the language tag
3. Handler executes (with confirmation if required)
4. Results are sent back to Lumo

### Read Files

````
```read
README.md
src/config.ts
```
````

File contents are returned automatically.

### Edit Files

````
```edit
=== FILE: src/config.ts
<<<<<<< SEARCH
const timeout = 5000;
=======
const timeout = 10000;
>>>>>>> REPLACE
```
````

### Create Files

````
```create
=== FILE: src/new-feature.ts
export function newFeature() {
  return "Hello!";
}
```
````

### Execute Code

````
```bash
ls -la
```
````

````
```python
print("Hello from Python!")
```
````

Only languages configured in `executors` are allowed.

### Troubleshooting

**"Command not found" for code execution**
- Check that the executor is configured in `cli.tools.local.executors`
- Verify the command exists on your system (e.g., `python` vs `python3`)

**File reads failing**
- Check `fileReads.maxFileSize`
- Verify file path is correct

**Edits not applying**
- Lumo must match the exact text in `<<<<<<< SEARCH`
- Read the file first so Lumo sees current content

---

## Key Code

| File | Purpose |
|------|---------|
| `src/api/instructions.ts` | Instruction template assembly |
| `src/api/tools/streaming-tool-detector.ts` | JSON tool call detection in streams |
| `src/api/tools/server-tools/` | Server tool registry, executor, loop |
| `src/lumo-client/client.ts` | Misrouted tool bounce logic |
| `src/cli/local-actions/` | Local tool handlers (read, edit, create, execute) |
