import { RequestQueue } from './queue.js';
import { LumoClient } from '../lumo-client/index.js';
import type { ConversationStore } from '../conversations/index.js';
import type { AuthManager } from '../auth/index.js';

export interface EndpointDependencies {
  queue: RequestQueue;
  lumoClient: LumoClient;
  conversationStore?: ConversationStore;
  syncInitialized?: boolean;
  authManager?: AuthManager;
  vaultPath?: string;
}

// Chat Completions API types

// Tool result message (role: 'tool') - sent by client after executing a tool
export interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

// Assistant message with tool_calls (no content, or null content)
export interface AssistantMessageWithToolCalls {
  role: 'assistant';
  content?: string | null;
  tool_calls: OpenAIToolCall[];
}

// Standard message with role and content
export interface StandardChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// Union type for all possible chat messages in requests
export type ChatMessage =
  | StandardChatMessage
  | AssistantMessageWithToolCalls
  | ToolResultMessage;

// OpenAI tool definition
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// Tool call in response
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIChatRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAITool[];
  user?: string;
  // Custom extension for conversation persistence
  conversation_id?: string;
}

// Extended chat message with optional tool calls (for responses)
export interface ChatMessageWithTools {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessageWithTools;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Streaming tool call delta (used in OpenAI streaming format)
export interface StreamingToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

// Delta in streaming chunks - can have content OR tool_calls
export interface StreamingDelta {
  role?: 'assistant';
  content?: string;
  tool_calls?: StreamingToolCallDelta[];
}

export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: StreamingDelta;
    finish_reason: string | null;
  }>;
}

// Responses API types
export interface FunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type ResponseInputItem =
  | { role: string; content: string }
  | FunctionCallOutput;

export interface OpenAIResponseRequest {
  model?: string;
  input?: string | Array<ResponseInputItem>;
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  // Compatibility alias accepted by some OpenAI-style clients.
  max_tokens?: number;
  store?: boolean;
  metadata?: Record<string, string>;
  tools?: any[];
  // Continuation from previous response (stateless mode)
  previous_response_id?: string;
  // Conversation identifier (per OpenAI spec: string ID or object)
  // Cannot be used with previous_response_id
  conversation?: string | { id: string };
  user?: string;
}

// Output item types for OpenAI Response
export type OutputItem = MessageOutputItem | FunctionCallOutputItem;

export interface MessageOutputItem {
  type: 'message';
  id: string;
  status: 'completed' | 'in_progress';
  role: 'assistant';
  content: Array<{
    type: 'output_text';
    text: string;
    annotations: any[];
  }>;
}

export interface FunctionCallOutputItem {
  type: 'function_call';
  id: string;
  call_id: string;
  status: 'completed' | 'in_progress';
  name: string;
  arguments: string;
}

export interface OpenAIResponse {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'incomplete' | 'queued';
  completed_at: number | null;
  error: { code: string; message: string } | null;
  incomplete_details: { reason: string } | null;
  instructions: string | null;
  max_output_tokens: number | null;
  model: string;
  output: OutputItem[];
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: {
    effort: string | null;
    summary: string | null;
  };
  store: boolean;
  temperature: number;
  text: {
    format: {
      type: string;
    };
  };
  tool_choice: string;
  tools: any[];
  top_p: number;
  truncation: string;
  usage: {
    input_tokens: number;
    input_tokens_details: {
      cached_tokens: number;
    };
    output_tokens: number;
    output_tokens_details: {
      reasoning_tokens: number;
    };
    total_tokens: number;
  } | null;
  user: string | null;
  metadata: Record<string, string>;
}

// Streaming event types for Responses API
export type ResponseStreamEvent =
  | { type: 'response.created'; response: Partial<OpenAIResponse>; sequence_number: number }
  | { type: 'response.in_progress'; response: Partial<OpenAIResponse>; sequence_number: number }
  | { type: 'response.completed'; response: OpenAIResponse; sequence_number: number }
  | { type: 'response.failed'; response: Partial<OpenAIResponse>; sequence_number: number }
  | { type: 'response.output_item.added'; item: any; output_index: number; sequence_number: number }
  | { type: 'response.output_item.done'; item: any; output_index: number; sequence_number: number }
  | { type: 'response.content_part.added'; item_id: string; output_index: number; content_index: number; part: any; sequence_number: number }
  | { type: 'response.content_part.done'; item_id: string; output_index: number; content_index: number; part: any; sequence_number: number }
  | { type: 'response.output_text.delta'; item_id: string; output_index: number; content_index: number; delta: string; sequence_number: number }
  | { type: 'response.output_text.done'; item_id: string; output_index: number; content_index: number; text: string; sequence_number: number }
  | { type: 'response.function_call_arguments.delta'; item_id: string; output_index: number; delta: string; sequence_number: number }
  | { type: 'response.function_call_arguments.done'; item_id: string; output_index: number; arguments: string; name: string; sequence_number: number }
  | { type: 'error'; code: string; message: string; param: string | null; sequence_number: number };
