export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: string | null;
  }>;
}

// Responses API types
export interface OpenAIResponseRequest {
  model?: string;
  input?: string | Array<{ role: string; content: string }>;
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  store?: boolean;
  metadata?: Record<string, string>;
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
  output: Array<{
    type: 'message';
    id: string;
    status: 'completed' | 'in_progress';
    role: 'assistant';
    content: Array<{
      type: 'output_text';
      text: string;
      annotations: any[];
    }>;
  }>;
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
  | { type: 'error'; code: string; message: string; param: string | null; sequence_number: number };

export interface BrowserConfig {
  url: string;
  cdpEndpoint: string; // Chrome DevTools Protocol endpoint for remote browser
  enableWebSearch: boolean;
}

export interface ChatboxSelectors {
  input: string;
  messages: string;
  completionIndicator?: string;
  webSearch: string;
}
