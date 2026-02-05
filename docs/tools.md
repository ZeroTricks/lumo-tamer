# Lumo Tools Architecture

## Terminology

Three types of tool calls in lumo-tamer:

| Type | Definition | Pipeline | Example |
|------|-----------|----------|---------|
| **Native** | Lumo-native, server-side execution | SSE `tool_call`/`tool_result` targets | `web_search`, `proton_info` |
| **Custom** | Client-defined, client-side execution | Instructed as text JSON in message | `get_weather`, `HassTurnOff` |
| **Confused** | Custom tool Lumo mistakenly routes as native | SSE `tool_call` target, always fails | `GetLiveContext` via native pipeline |
| **CLI** | CLI-only, code block with language tag | `CodeBlockDetector` + `BlockHandler` | `read`, `edit`, `create`, bash |

## Native Tools

### Available Tool Types

| Tool Name | Type | Description |
|-----------|------|-------------|
| `proton_info` | Internal | Proton product information (always enabled) |
| `web_search` | External | Web search via Proton's backend |
| `weather` | External | Weather data |
| `stock` | External | Stock prices |
| `cryptocurrency` | External | Cryptocurrency prices |

### How Native Tools Work

All native tools are **executed server-side** by Proton Lumo's backend:

```
Client Request → Lumo API (Backend)
                        ↓
                 LLM decides when to use tool
                        ↓
                 Backend executes tool
                        ↓
                 Returns via SSE stream:
                 - tool_call target (what LLM requested)
                 - tool_result target (execution result)
                 - message target (LLM's response)
```

### Request Format

Tools are specified in the API request:

```typescript
{
  Prompt: {
    type: 'generation_request',
    turns: [...],
    options: {
      tools: ['proton_info', 'web_search', 'weather', 'stock', 'cryptocurrency']
    },
    targets: ['message']
  }
}
```

### SSE Response Format

When native tools are used, the SSE stream includes special targets:

```
data: {"type":"ingesting","target":"message"}
data: {"type":"token_data","target":"message","content":"Let me search for that."}

data: {"type":"ingesting","target":"tool_call"}
data: {"type":"token_data","target":"tool_call","content":"{\"name\":\"web_search\",\"arguments\":{\"query\":\"latest AI news\"}}"}

data: {"type":"ingesting","target":"tool_result"}
data: {"type":"token_data","target":"tool_result","content":"{\"results\":[{\"title\":\"...\",\"url\":\"...\"}]}"}

data: {"type":"ingesting","target":"message"}
data: {"type":"token_data","target":"message","content":"Based on the search results..."}
data: {"type":"done"}
```

### Configuration

Enable/disable external tools via `config.yaml`:

```yaml
tools:
  enableWebSearch: true  # Controls web_search, weather, stock, cryptocurrency
```

### Limitations

- **No custom tools**: The LLM is trained on a fixed set of tools
- **Server-side only**: All tool execution happens on Proton's backend
- **No client-side hooks**: Cannot intercept or override tool execution

## Custom Tools

### Overview

For tools not provided natively by Lumo, lumo-tamer supports client-defined tools:
1. Tool definitions are sent as JSON in the system instructions
2. Lumo outputs tool calls as JSON in code fences or raw JSON in the message text
3. lumo-tamer detects and extracts tool calls, returning them in OpenAI format

### How It Works

When the OpenAI request includes a `tools` array:

1. **Instructions are augmented** with `instructions.forTools` config + tool definitions as JSON
2. **Lumo responds** with tool calls as JSON, typically in code fences or raw JSON:
   ````
   I'll check the weather for you.
   ```json
   {"name": "get_weather", "arguments": {"city": "Paris"}}
   ```
   ````
3. **`StreamingToolDetector`** detects tool calls during streaming (code fence and raw JSON formats)
4. **`tool-parser.ts`** extracts tool calls from non-streaming responses
5. Tool calls are returned in OpenAI format (`tool_calls` / `function_call`)

### Request Format (OpenAI)

```json
{
  "model": "lumo",
  "messages": [{"role": "user", "content": "What's the weather in Paris?"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get weather for a city",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {"type": "string"}
        }
      }
    }
  }]
}
```

### Response Format (OpenAI)

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "I'll check the weather for you.",
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\": \"Paris\"}"
        }
      }]
    }
  }]
}
```

### Configuration

Configure the instructions prepended to tool definitions:

```yaml
instructions:
  forTools: |
    Use the tools below to accomplish tasks.
    To use them you MUST output the JSON to me, unlike the proton_info or web search tools.
    You have the power to execute these functions by providing the JSON directly to me...
```

### Detection pipeline

- **Streaming**: `StreamingToolDetector` (state machine detecting code fences and raw JSON) delegates brace-depth tracking to `JsonBraceTracker`
- **Non-streaming**: `tool-parser.ts` extracts tool calls from the full response text

### Limitations

- **Less reliable than native**: Depends on Lumo consistently outputting valid JSON
- **Prompt engineering required**: Must instruct Lumo to output JSON for these tools

## Confused Tool Calls

### The Problem

Sometimes Lumo routes a custom tool through the native SSE pipeline instead of outputting it as text. This always fails server-side because the backend doesn't know how to execute client-defined tools. Proton sees these as tool errors.

### SSE Stream for a Confused Call

```
data: {"type":"token_data","target":"tool_call","content":"{\"name\":\"GetLiveContext\",\"arguments\":{}}"}
data: {"type":"token_data","target":"tool_result","content":"{\"error\":true}"}
data: {"type":"token_data","target":"message","content":"I don't have access to that tool..."}
```

The tool_call contains the custom tool name, tool_result is always `{"error":true}`, and the message is Lumo's fallback apology text.

### How lumo-tamer Bounces These

Instead of silently converting the failed call, lumo-tamer bounces confused calls back to Lumo with a corrective instruction. This teaches Lumo within the conversation to output custom tool calls as JSON text.

1. **Detection**: `LumoClient.processStream()` tracks SSE `tool_call` targets. When a tool name is not in `KNOWN_NATIVE_TOOLS`, it's identified as confused.
2. **Suppression**: `onChunk` stops firing immediately - the client suppresses Lumo's fallback text ("I don't have access...") internally.
3. **Bounce**: `chatWithHistory()` appends the failed assistant response + a corrective user message (from `instructions.forToolBounce` config) to the conversation turns and makes a second call.
4. **Result**: Lumo re-outputs the tool call as JSON text in the bounce response. This flows through normal `StreamingToolDetector` / `tool-parser.ts` detection.

API handlers are completely unaware of confused calls - the bounce happens inside `LumoClient`.

### Streaming Sequence

```
Handler -> LumoClient.chatWithHistory(turns, onChunk, options)
  LumoClient -> Lumo: first call
  Lumo -> LumoClient: confused tool_call (name not in KNOWN_NATIVE_TOOLS)
  LumoClient: sets suppressChunks=true, stops calling onChunk
  Lumo -> LumoClient: tool_result error + fallback text (onChunk not called)
  LumoClient: stream ends, confused flag set
  LumoClient -> Lumo: bounce call (passes onChunk through)
  Lumo -> LumoClient: text with JSON tool call -> onChunk fires -> handler streams it
  LumoClient: returns bounce ChatResult
Handler: StreamingToolProcessor detected/emitted tool call via onChunk
```

### Configuration

The bounce instruction template in `config.defaults.yaml`:

```yaml
instructions:
  forToolBounce: |
    You tried to call a custom tool using your built-in tool system, but custom tools
    must be called by outputting JSON text. Please output the tool call as JSON, like this:
    {toolCall}
```

The `{toolCall}` placeholder is replaced at runtime with the actual confused tool call JSON.

### Key code

- `src/lumo-client/client.ts` - `isConfusedToolCall()`, `buildBounceInstruction()`, bounce in `chatWithHistory()`
- `src/api/native-tool-parser.ts` - `parseNativeToolCallJson()`, `isErrorResult()`
- `src/api/json-brace-tracker.ts` - SSE target JSON extraction
- Mock scenario: `confusedToolCall`

## CLI Tools

The CLI (`src/cli/`) uses a simpler approach than the API's custom tools. Instead of JSON tool calls, Lumo outputs **code blocks** with specific language tags that the CLI detects and executes locally.

### Block types

| Language tag | Handler | Description |
|-------------|---------|-------------|
| `read` | `file-reader.ts` | Read file contents, return to Lumo |
| `edit` | `edit-applier.ts` | Search/replace edits on files |
| `create` | `file-creator.ts` | Create new files |
| Configured executors | `code-executor.ts` | Run code (bash, python, etc.) |

### How it works

1. `CodeBlockDetector` detects triple-backtick code blocks in the streaming response
2. `BlockHandler.matches()` checks the language tag to find the right handler
3. Some handlers require user confirmation (edit, create, execute), others don't (read)
4. Handler results are formatted and sent back to Lumo as follow-up messages

No JSON parsing, no tool call format, no confusion possible. The language tag is the only dispatch mechanism. New block types are added in `block-handlers.ts`.

## Combining Approaches

Native tools and custom tools can be enabled simultaneously:

- `tools.enableWebSearch: true` enables Lumo's native `web_search` tool (config)
- Providing `tools` array in OpenAI request enables custom tool detection
- Both work together: native tools execute server-side, custom tools are detected client-side
- Confused tool calls are automatically bounced back to Lumo for correction

## Data Structures

### Native Tool Call (from SSE)

```typescript
type ToolCallData = WebSearchToolCallData;

type WebSearchToolCallData = {
  name: 'web_search';
  arguments: WebSearchArguments
};

type WebSearchArguments = {
  query: string;
};
```

### Native Tool Result (from SSE)

```typescript
type ToolResultData = WebSearchToolResultData | ToolResultError;

type WebSearchToolResultData = {
  results: SearchItem[];
};

type SearchItem = {
  title: string;
  description?: string;
  url: string;
  extra_snippets?: string[];
};

type ToolResultError = {
  error: boolean;
};
```

### Custom Tool Call (parsed from response text)

```typescript
// src/api/tool-parser.ts
interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}
```

## See Also

- [lumo-api-integration.md](lumo-api-integration.md) - Overall API integration strategy
- [proton-upstream/UPSTREAM.md](../src/proton-upstream/UPSTREAM.md) - Upstream file management
