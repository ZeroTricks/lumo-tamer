# Lumo Tools Architecture

## Overview

Lumo supports two types of tool usage:
1. **Native Tools** - Server-side tools executed by Proton Lumo backend
2. **Custom Tools (Legacy)** - JSON tool calls in messages, detected client-side

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

## Custom Tools (Legacy Approach)

### Overview

For tools not provided by Lumo, lumo-tamer supports a legacy approach where:
1. Tool definitions are sent as JSON in the instructions
2. Lumo outputs tool calls as JSON in `<pre>` tags
3. lumo-tamer parses the response and extracts tool calls

### How It Works

When the OpenAI request includes a `tools` array:

1. **Instructions are augmented** with `instructions.forTools` config + tool definitions as JSON
2. **Lumo responds** with tool calls formatted as JSON in `<pre>` tags:
   ```html
   I'll check the weather for you.
   <pre>{"name": "get_weather", "arguments": {"city": "Paris"}}</pre>
   ```
3. **lumo-tamer extracts** tool calls and returns them in OpenAI format

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

### Limitations

- **Less reliable**: Depends on Lumo consistently outputting JSON in `<pre>` tags
- **No streaming tool calls**: Tool calls only detected after full response
- **Prompt engineering required**: Must instruct Lumo to use this format

## Combining Both Approaches

Native tools and custom tools can be enabled simultaneously:

- `tools.enableWebSearch: true` enables Lumo's native `web_search` tool
- Providing `tools` array in request enables legacy custom tool detection
- Both can work together - native tools execute server-side, custom tools are detected client-side

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

### Custom Tool Call (parsed from response)

```typescript
interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}
```

## See Also

- [lumo-api-integration.md](lumo-api-integration.md) - Overall API integration strategy
- [proton-upstream/UPSTREAM.md](../src/proton-upstream/UPSTREAM.md) - Upstream file management
