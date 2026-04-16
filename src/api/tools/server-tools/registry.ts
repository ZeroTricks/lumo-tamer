/**
 * Server Tool Registry
 *
 * Manages server-side tools (ServerTools) that Lumo can call.
 * ServerTools are executed by the server, unlike CustomTools which are passed to API clients.
 */

import { OpenAITool } from 'src/api/types.js';
import type { ConversationStore } from '../../../conversations/index.js';
import type { ConversationId } from '../../../conversations/types.js';

// ── Types ─────────────────────────────────────────────────────────────

/** Context passed to ServerTool handlers. */
export interface ServerToolContext {
  conversationStore?: ConversationStore;
  conversationId?: ConversationId;
}

/** ServerTool handler function. Returns result as string. */
export type ServerToolHandler = (
  args: Record<string, unknown>,
  context: ServerToolContext
) => Promise<string>;

/** A ServerTool with its definition and handler. */
export interface ServerTool {
  definition: OpenAITool;
  handler: ServerToolHandler;
  /** Optional check if tool should be registered. If undefined, tool is always available. */
  isAvailable?: () => boolean;
}

/**
 * Prefix to avoid name collisions between server and client tool names, while not confusing Lumo about distinction between native and custom tools.
 * NOTE: This prefix is used at server tool definition time and not appended/stripped dynamically, like customTools.prefix
 * Final server tool function names look like:
 * customTools.prefix + serverToolPrefix + name
 * ie. user:lumo_search
 */ 
export const serverToolPrefix = "lumo_"

// ── Registry ──────────────────────────────────────────────────────────

const registry = new Map<string, ServerTool>();

/**
 * Register a ServerTool.
 * @param tool The ServerTool definition and handler
 */
export function registerServerTool(tool: ServerTool): void {
  const name = tool.definition.function.name;
  if (registry.has(name)) {
    throw new Error(`ServerTool "${name}" is already registered`);
  }
  registry.set(name, tool);
}

/**
 * Get a ServerTool by name.
 * @param name Tool name (without prefix)
 * @returns The ServerTool or undefined if not found
 */
export function getServerTool(name: string): ServerTool | undefined {
  return registry.get(name);
}

/**
 * Check if a tool name is a registered ServerTool.
 * @param name Tool name (without prefix)
 */
export function isServerTool(name: string): boolean {
  return registry.has(name);
}

/**
 * Get all registered ServerTool definitions.
 * Used for merging into instructions.
 */
export function getAllServerToolDefinitions(): OpenAITool[] {
  return Array.from(registry.values()).map(t => t.definition);
}

/**
 * Clear all registered ServerTools.
 * Mainly for testing.
 */
export function clearServerTools(): void {
  registry.clear();
}
