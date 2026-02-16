/**
 * Command handler for CLI and API modes.
 * Supports commands like /save for syncing conversations.
 */

import { logger } from './logger.js';
import { getCommandsConfig } from './config.js';
import { getSyncService, getConversationStore, getAutoSyncService } from '../conversations/index.js';
import type { AuthManager } from '../auth/index.js';

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
      case 'sync':
        return await handleSaveCommand(context);

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
  /save, /sync       - Sync conversations to Proton server
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
 * Handle /save command - sync conversations to server
 */
async function handleSaveCommand(context?: CommandContext): Promise<string> {
  try {
    if (!context?.syncInitialized) {
      return 'Sync not initialized. Persistence may be disabled or KeyManager not ready.';
    }

    const syncService = getSyncService();
    const syncedCount = await syncService.sync();

    const stats = syncService.getStats();
    return `Synced ${syncedCount} conversation(s) to server.\n` +
           `Project: ${stats.spaceId ?? 'none'}\n` +
           `Mapped conversations: ${stats.mappedConversations}\n` +
           `Mapped messages: ${stats.mappedMessages}`;
  } catch (error) {
    logger.error({ error }, 'Failed to execute /save command');
    return `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
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
 * Handle /logout command - revoke session and delete tokens
 */
async function handleLogoutCommand(context?: CommandContext): Promise<string> {
  try {
    if (!context?.authManager) {
      return 'Logout not available - missing auth context.';
    }

    // Stop auto-sync if running
    const autoSync = getAutoSyncService();
    autoSync?.stop();

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

