import { OpenAIResponseRequest, OpenAIResponse, OutputItem } from '../../types.js';
import { getServerConfig } from '../../../app/config.js';

export function createCompletedResponse(
  responseId: string,
  createdAt: number,
  request: OpenAIResponseRequest,
  output: OutputItem[]
): OpenAIResponse {
  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    completed_at: Math.floor(Date.now() / 1000),
    error: null,
    incomplete_details: null,
    instructions: request.instructions || null,
    max_output_tokens: request.max_output_tokens || null,
    model: request.model || getServerConfig().apiModelName,
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: {
      effort: null,
      summary: null,
    },
    store: request.store || false,
    temperature: request.temperature || 1.0,
    text: {
      format: {
        type: 'text',
      },
    },
    tool_choice: 'none',
    tools: [],
    top_p: 1.0,
    truncation: 'auto',
    usage: null,
    user: null,
    metadata: request.metadata || {},
  };
}
