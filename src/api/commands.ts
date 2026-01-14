/**
 * Command handler stubs for API mode.
 * Commands that require browser interaction are not available.
 */

const KNOWN_COMMANDS = [
  'new',
  'clear',
  'reset',
  'private',
  'open',
  'behave',
  'defaultbehaviour',
];

export interface CommandResult {
  text: string;
  error: boolean;
}

/**
 * Check if a message is a command (starts with /)
 */
export function isCommand(message: string): boolean {
  return message.trim().startsWith('/');
}

/**
 * Execute a command. In API mode, all commands return an error
 * explaining that browser interaction is required.
 */
export function executeCommand(command: string): CommandResult {
  const trimmed = command.trim();
  const cmdMatch = trimmed.match(/^\/(\S+)/);
  const cmdName = cmdMatch?.[1]?.toLowerCase() || '';

  if (KNOWN_COMMANDS.includes(cmdName)) {
    return {
      text: `Command /${cmdName} is not available in API mode. Commands require browser interaction which has been disabled.`,
      error: true,
    };
  }

  return {
    text: `Unknown command: /${cmdName}`,
    error: true,
  };
}
