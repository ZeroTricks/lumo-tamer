/**
 * ServerTools - Server-side tools callable by Lumo
 *
 * ServerTools are executed by the server, unlike CustomTools which are passed to API clients.
 * They use the same instruction mechanism as CustomTools (JSON in code blocks).
 */

import { registerServerTool } from './registry.js';
import { dateServerTool } from './date.js';
import { searchServerTool } from './search.js';

// Re-export types and functions
export {
  registerServerTool,
  getServerTool,
  isServerTool,
  getAllServerToolDefinitions,
  clearServerTools,
  type ServerTool,
  type ServerToolContext,
  type ServerToolHandler,
} from './registry.js';

export {
  executeServerTool,
  executeServerTools,
  buildContinuationTurns,
  type ServerToolExecutionResult,
  type ServerToolResult,
} from './executor.js';

export { chatAndExecute, type ChatAndExecuteOptions, type ChatAndExecuteResult } from './handler.js';

/**
 * Initialize all built-in ServerTools.
 * Called during server startup when enableServerTools is true.
 */
export function initializeServerTools(): void {
  registerServerTool(dateServerTool);
  registerServerTool(searchServerTool);
}
