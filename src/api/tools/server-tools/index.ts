/**
 * ServerTools - Server-side tools callable by Lumo
 *
 * ServerTools are executed by the server, unlike CustomTools which are passed to API clients.
 * They use the same instruction mechanism as CustomTools (JSON in code blocks).
 */

import { registerServerTool } from './registry.js';
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

export { executeServerTool, type ServerToolExecutionResult } from './executor.js';

export { runServerToolLoop, type ServerToolLoopOptions, type ServerToolLoopResult } from './loop.js';

/**
 * Initialize all built-in ServerTools.
 * Called during server startup when enableServerTools is true.
 */
export function initializeServerTools(): void {
  registerServerTool(searchServerTool);
}
