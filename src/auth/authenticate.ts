/**
 * Authentication module for lumo-tamer
 *
 * Usage (via CLI):
 *   tamer auth              - Interactive authentication
 *   tamer auth login        - Use login method directly
 *   tamer auth browser      - Use browser method directly
 *   tamer auth rclone       - Use rclone method directly
 *   tamer auth status       - Show current auth status
 *
 * Prompts for auth method (with config value as default) and runs extraction:
 * - login: Run interactive SRP authentication (requires Go binary)
 * - browser: Extract tokens from browser session via CDP
 * - rclone: Prompt user to paste rclone config section
 *
 * Updates config.yaml with selected values after successful auth.
 */

import * as readline from 'readline';
import { authConfig, authMethodSchema, getConversationsConfig } from '../app/config.js';
import { logger } from '../app/logger.js';
import { runBrowserAuthentication } from './browser/authenticate.js';
import { runRcloneAuthentication } from './rclone/authenticate.js';
import { runLoginAuthentication } from './login/authenticate.js';
import { AuthProvider } from './providers/index.js';
import { printStatus, printSummary, runStatus } from './status.js';
import { updateAuthConfig } from './update-config.js';
import type { AuthMethod } from './types.js';
import { print } from '../app/terminal.js';

const numToMethod: Record<string, AuthMethod> = { '1': 'login', '2': 'browser', '3': 'rclone' };
const methodToNum: Record<AuthMethod, string> = { login: '1', browser: '2', rclone: '3' };

/**
 * Prompt user to select authentication method
 */
async function promptForMethod(defaultMethod: AuthMethod): Promise<AuthMethod> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  print('Select authentication method:');
  print('  1. login   - Enter Proton credentials (requires Go binary)');
  print('  2. browser - Extract from logged-in browser session');
  print('  3. rclone  - Paste rclone config section');
  print('');

  const defaultNum = methodToNum[defaultMethod] || '1';

  return new Promise(resolve => {
    rl.question(`Choice [${defaultNum}]: `, answer => {
      rl.close();
      const input = answer.trim() || defaultNum;

      // Try parsing as number first, then as method name
      const method = numToMethod[input] ?? authMethodSchema.safeParse(input).data ?? 'login';
      resolve(method);
    });
  });
}

interface BrowserAuthResult {
  cdpEndpoint: string;
}

async function authenticateBrowser(): Promise<BrowserAuthResult> {
  const result = await runBrowserAuthentication();

  // Log warnings
  for (const warning of result.warnings) {
    logger.warn(warning);
  }

  // Summary
  const syncEnabled = getConversationsConfig().sync.enabled;
  if (!syncEnabled) {
    logger.info('Sync disabled - encryption keys not fetched');
  } else if (result.tokens.keyPassword) {
    logger.info('Extended auth data extracted - conversation persistence enabled');
  } else {
    logger.warn('Conversation persistence will use local-only encryption');
  }

  return { cdpEndpoint: result.cdpEndpoint };
}

/**
 * Run the auth command with the given arguments.
 * Called from CLI after config/logger are initialized.
 */
export async function runAuthCommand(argv: string[]): Promise<void> {
  const subArg = argv[0];

  // Handle status subcommand
  if (subArg === 'status') {
    return runStatus();
  }

  print('=== lumo-tamer authentication ===\n');

  // Determine method: from arg or interactive prompt
  const methodFromArg = authMethodSchema.safeParse(subArg).data;
  const defaultMethod = authConfig.method;
  const method = methodFromArg ?? await promptForMethod(defaultMethod);

  print(`Auth method: ${method}\n`);

  try {
    let cdpEndpoint: string | undefined;

    switch (method) {
      case 'browser': {
        const result = await authenticateBrowser();
        cdpEndpoint = result.cdpEndpoint;
        break;
      }
      case 'rclone':
        await runRcloneAuthentication();
        break;
      case 'login':
        await runLoginAuthentication();
        break;
      default:
        throw new Error(`Unknown auth method: ${method}`);
    }

    // Flush logger before showing status (pino is async)
    logger.flush();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Update config.yaml with selected values
    updateAuthConfig({
      method,
      cdpEndpoint,
    });

    // Show status after extraction - reload from vault
    const provider = await AuthProvider.create();
    const status = provider.getStatus();
    printStatus(status);
    printSummary(status, {
        supportsPersistence: provider.supportsPersistence(),
        supportsSync: provider.supportsSync(),
    });

    print('\nYou can now run: tamer or tamer server');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, `Authentication failed: ${message}`);
    process.exit(1);
  }
}
