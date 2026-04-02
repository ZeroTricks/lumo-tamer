/**
 * Command handler for CLI and API modes.
 * Supports commands like /save for syncing conversations.
 */

import { logger } from './logger.js';
import { getCommandsConfig } from './config.js';
import { getConversationStore } from '../conversations/index.js';
import { searchConversations, formatSearchResults } from '../conversations/search.js';
import type { AuthManager } from '../auth/index.js';
import type { Turn } from '../lumo-client/index.js';

/**
 * Check if a message is a command (starts with / or wakeword)
 */
export function isCommand(message?: string): boolean {
  if(!message)
    return false;
  const trimmed = message.trim();
  if (trimmed.startsWith('/')) return true;

  const { wakeword } = getCommandsConfig();
  if (wakeword && trimmed.toLowerCase().startsWith(wakeword.toLowerCase() + ' ')) {
    return true;
  }
  return false;
}

/**
 * Command execution context
 */
export interface CommandContext {
  syncInitialized: boolean;
  conversationId?: string;
  /** AuthManager for logout and token refresh commands */
  authManager?: AuthManager;
  /** Turns from the current request (for /save on stateless requests) */
  turns?: Turn[];
}

export interface CommandResult {
  isCommand: true;
  response: string;
}

/**
 * Check if the last user message is a command and execute it.
 * Returns the command result if executed, or undefined if not a command.
 */
export async function tryExecuteCommand(
  turns: Turn[],
  commandContext: CommandContext
): Promise<CommandResult | undefined> {
  if (!getCommandsConfig().enabled) return undefined;

  const lastUserTurn = [...turns].reverse().find(t => t.role === 'user');
  if (!lastUserTurn?.content || !isCommand(lastUserTurn.content)) return undefined;

  const response = await executeCommand(lastUserTurn.content, { ...commandContext, turns });
  logger.info({ command: lastUserTurn.content, response }, 'Command executed via API');

  return { isCommand: true, response };
}

/**
 * Execute a command.
 *
 * @param command - The command string (e.g., "/save")
 * @param context - Optional execution context
 * @returns Result message
 */
export async function executeCommand(
  command: string,
  context?: CommandContext
): Promise<string> {
    const commandsConfig = getCommandsConfig();
    if (!commandsConfig.enabled) {
        logger.debug({ command }, 'Command ignored (commands.enabled=false)');
        return 'Commands are disabled.';
    }

    // Strip prefix (/ or wakeword)
    let commandText: string;
    if (command.startsWith('/')) {
      commandText = command.slice(1).trim();
    } else {
      const { wakeword } = commandsConfig;
      // Strip "wakeword " prefix (case-insensitive match already done in isCommand)
      commandText = command.slice(wakeword.length).trim();
    }

    // Extract command name and parameters: /command param1 param2 ...
    const match = commandText.match(/^(\S+)(?:\s+(.*))?$/);
    const commandName = match?.[1] || commandText;
    const params = match?.[2] || '';
    const lowerCommand = commandName.toLowerCase();

    logger.info(`Executing command: /${lowerCommand}${params ? ` with params: ${params}` : ''}`);

    switch (lowerCommand) {
      case 'help':
        return getHelpText();

      case 'save':
        return await handleSaveCommand(params, context);

      case 'search':
        return handleSearchCommand(params, context);

      case 'title':
        return handleTitleCommand(params, context);

      case 'logout':
        return await handleLogoutCommand(context);

      case 'refreshtokens':
        return await handleRefreshTokensCommand(context);

      case 'ole':
        return 'ole!';

      // Unsupported commands (would need browser)
      case 'new':
      case 'clear':
      case 'reset':
      case 'private':
      case 'open':
        return `Command /${lowerCommand} is not available.`;

      default:
        logger.warn(`Unknown command: /${commandName}`);
        return `Unknown command: /${commandName}\n\n${getHelpText()}`;
    }
}

/**
 * Get help text for available commands
 */
function getHelpText(): string {
  const { wakeword } = getCommandsConfig();
  const wakewordHint = wakeword ? `\n\nAlternatively, use "${wakeword} <command>" instead of "/<command>"` : '';
  return `Available commands:
  /help              - Show this help message
  /title <text>      - Set conversation title
  /save [title]      - Save stateless request to conversation (optionally set title)
  /search <query>    - Search conversation titles and messages
  /refreshtokens     - Manually refresh auth tokens
  /logout            - Revoke session and delete tokens
  /quit              - Exit CLI (CLI mode only)${wakewordHint}`;
}

/**
 * Handle /title command - set conversation title manually
 *
 * Inspired by WebClients ConversationHeader.tsx title editing
 */
function handleTitleCommand(params: string, context?: CommandContext): string {
  if (!params.trim()) {
    return 'Usage: /title <new title>';
  }
  if (!context?.conversationId) {
    return 'No active conversation to rename.';
  }
  const store = getConversationStore();
  if (!store) {
    return 'Conversation store not available.';
  }
  // Enforce max length (same as postProcessTitle)
  const title = params.trim().substring(0, 100);
  store.setTitle(context.conversationId, title);
  return `Title set to: ${title}`;
}

/**
 * Handle /save command - save current conversation
 * Optionally set title first with /save <title>
 *
 * For stateless requests (no conversationId), creates a new conversation
 * from the provided messages. Sync happens automatically via Redux sagas
 * when using the primary store.
 */
async function handleSaveCommand(params: string, context?: CommandContext): Promise<string> {
  try {
    if (!context?.syncInitialized) {
      return 'Sync not initialized. Persistence may be disabled or KeyManager not ready.';
    }

    const store = getConversationStore();
    if (!store) {
      return 'Conversation store not available.';
    }

    let conversationId = context?.conversationId;
    let wasCreated = false;

    // Handle stateless requests - create conversation from turns
    if (!conversationId) {
      if (!context?.turns || context.turns.length === 0) {
        return 'No messages to save.';
      }

      const result = store.createFromTurns(context.turns, params.trim() || undefined);
      conversationId = result.conversationId;
      wasCreated = true;
    } else {
      // Stateful request - optionally set title
      if (params.trim()) {
        const title = params.trim().substring(0, 100);
        store.setTitle(conversationId, title);
      }
    }

    const conversation = store.get(conversationId);
    if (!conversation) {
      return 'Conversation not found.';
    }

    const title = conversation.title ?? 'Unknown';

    if (wasCreated) {
      return `Created conversation: ${title}`;
    }
    return `Saved conversation: ${title}`;
  } catch (error) {
    logger.error({ error }, 'Failed to execute /save command');
    return `Save failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

/**
 * Handle /refreshtokens command - manually trigger token refresh
 */
async function handleRefreshTokensCommand(context?: CommandContext): Promise<string> {
  try {
    if (!context?.authManager) {
      return 'Token refresh not available - missing auth context.';
    }

    await context.authManager.refreshNow();
    return 'Tokens refreshed successfully.';
  } catch (error) {
    logger.error({ error }, 'Failed to execute /refreshtokens command');
    return `Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

/**
 * Handle /search command - search conversations by title and content
 */
function handleSearchCommand(params: string, context?: CommandContext): string {
  const query = params.trim();
  if (!query) {
    return 'Usage: /search <query>\nSearches conversation titles and message content.';
  }

  const store = getConversationStore();
  if (!store) {
    return 'Conversation store not available.';
  }

  // Exclude current conversation from results (it would always be at the top)
  const results = searchConversations(store, query, 20, context?.conversationId);
  return formatSearchResults(results, query);
}

/**
 * Handle /logout command - revoke session and delete tokens
 */
async function handleLogoutCommand(context?: CommandContext): Promise<string> {
  try {
    if (!context?.authManager) {
      return 'Logout not available - missing auth context.';
    }

    // Perform logout (stops refresh timer, revokes session, deletes tokens)
    await context.authManager.logout();

    // Schedule graceful shutdown (high timeout to ensure response is sent)
    setTimeout(() => {
      logger.info('Shutting down after logout...');
      process.exit(0);
    }, 500);

    return 'Logged out successfully. Session revoked and tokens deleted.\nShutting down...';
  } catch (error) {
    logger.error({ error }, 'Failed to execute /logout command');
    return `Logout failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

