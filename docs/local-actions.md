# Local Actions (CLI)

This document covers CLI local actions: file operations and code execution.

For API custom tool integration, see [custom-tools.md](custom-tools.md).

---

## Status

The CLI is a proof of concept. Local actions work, but the UI is basic and it's hard to keep track of conversations and actions. Development focus is on making API custom tools more reliable, enabling third-party clients like [Nanocoder](https://github.com/AbanteAI/nanocoder) that offer better local actions, richer instructions, and a cleaner interface.

---

## Quick Start

1. Enable local actions in `config.yaml`:
   ```yaml
   cli:
     localActions:
       enabled: true
   ```

2. Start the CLI:
   ```bash
   tamer
   ```

3. Lumo can now read files, make edits, and execute code on your machine. You can ask Lumo to give you a demo of its CLI capabilities, or see this [demo chat](demo-cli-chat.md) for inspiration.

---

## Configuration

### Enable Local Actions

```yaml
cli:
  localActions:
    # Enable code block detection (```bash, ```read, ```edit, etc.)
    # WARNING: When enabled, Lumo can trigger actions on your machine!
    enabled: true
```

### File Reads

```yaml
cli:
  localActions:
    # ```read blocks: Lumo can read local files without user confirmation
    fileReads:
      # Enable ```read blocks
      # Note: if disabled, Lumo can still ask to read files using shell tools (e.g., cat)
      enabled: true
      # Max file size in KB. Files larger than this are skipped with an error.
      maxFileSizeKB: 512
```

### Code Executors

```yaml
cli:
  localActions:
    # Maps language tag -> [command, ...args]. Code is appended as last arg.
    executors:
      bash: ["bash", "-c"]
      python: ["python", "-c"]
      sh: ["sh", "-c"]
      # Uncomment to enable more:
      # zsh: ["zsh", "-c"]
      # powershell: ["powershell", "-Command"]
      # node: ["node", "-e"]
      # perl: ["perl", "-e"]
```

### Instructions

```yaml
cli:
  instructions:
    template: |
      You are a command line assistant. Your output will be read in a terminal. Keep the formatting to a minimum and be concise.

      {{#if localActions}}
      {{forLocalActions}}
      {{/if}}

    # Injected as {{forLocalActions}} when localActions.enabled=true
    forLocalActions: |
      You can read, edit and create files, and you can execute {{executors}} commands on the user's machine.
      To execute code, use a code block like ```python. The user will be prompted to execute it and the result will be returned to you.
      To read files, use a ```read block with one file path per line. Contents will be returned automatically.
      To create a new file, use a ```create block. The user will be prompted to confirm.
      To edit an existing file, use a ```edit block (one file per block). Read the file first if needed.
```

### Native Tools (CLI)

The CLI also supports Lumo's native tools:

```yaml
cli:
  # Enable Lumo's native web_search tool (and other external tools)
  enableWebSearch: true
```

## Troubleshooting

**"Command not found" for code execution**
- Check that the executor is configured in `cli.localActions.executors`
- Verify the command exists on your system (e.g., `python` vs `python3`)

**File reads failing**
- Check `fileReads.maxFileSizeKB` - large files are rejected
- Verify file path is correct (relative to working directory)

**Edits not applying**
- Lumo must match the exact text in `<<<<<<< SEARCH`
- Read the file first so Lumo sees current content

---

## How It Works

Lumo outputs code blocks with specific language tags. The CLI detects these and executes them locally:

1. `CodeBlockDetector` detects triple-backtick code blocks in Lumo's response
2. `BlockHandler.matches()` checks the language tag to find the right handler
3. Handler executes (with confirmation if required)
4. Results are sent back to Lumo as follow-up messages

The language tag is the dispatch mechanism - no JSON parsing involved.

### Read Files

Lumo reads files without prompting:

````
```read
README.md
src/config.ts
```
````

File contents are returned to Lumo automatically.

### Edit Files

Lumo proposes edits, you confirm:

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

You'll see a diff and be prompted to accept or reject.

### Create Files

Lumo proposes new files, you confirm:

````
```create
=== FILE: src/new-feature.ts
export function newFeature() {
  return "Hello!";
}
```
````

### Execute Code

Lumo runs commands, you confirm:

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

### User Confirmation

| Block Type | Confirmation Required |
|------------|----------------------|
| `read` | No - automatic |
| `edit` | Yes - shows diff |
| `create` | Yes - shows content |
| Code execution | Yes - shows command |

---

## Key Files

| File | Purpose |
|------|---------|
| `src/cli/code-block-detector.ts` | Detects code blocks in streaming response |
| `src/cli/block-handlers.ts` | Handler registry and base class |
| `src/cli/handlers/file-reader.ts` | `read` block handler |
| `src/cli/handlers/edit-applier.ts` | `edit` block handler |
| `src/cli/handlers/file-creator.ts` | `create` block handler |
| `src/cli/handlers/code-executor.ts` | Code execution handler |
