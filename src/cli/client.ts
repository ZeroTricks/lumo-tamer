/**
 * CLIClient - Interactive command-line interface for Lumo
 *
 * Uses the shared Application layer for auth, persistence, and client access.
 *
 * Usage: npm run dev:cli (or npm run cli for production)
 *        Single query mode: pass query as argv[2]
 *        Interactive mode: no argv
 */

import * as readline from 'readline';
import { randomUUID } from 'crypto';
import { logger } from '../app/logger.js';
import { isCommand, executeCommand, type CommandContext } from '../app/commands.js';
import type { AppContext } from '../app/index.js';
import { postProcessTitle } from '../proton-shims/lumo-api-client-utils.js';

const BUSY_INDICATOR = '...';

function clearBusyIndicator(): void {
  // Backspace over "..."
  process.stdout.write('\b\b\b   \b\b\b');
}

export class CLIClient {
  private conversationId: string;

  constructor(private app: AppContext) {
    this.conversationId = randomUUID();
  }

  async run(): Promise<void> {
    // Check if query provided as argument
    const query = process.argv[2];
    if (query && !query.startsWith('-')) {
      await this.singleQuery(process.argv.slice(2).join(' '));
    } else {
      await this.interactiveMode();
    }
  }

  private async singleQuery(query: string): Promise<void> {
    logger.info({ query }, 'Sending query');
    process.stdout.write('\n');

    const startTime = Date.now();
    let chunkCount = 0;
    process.stdout.write(BUSY_INDICATOR);

    try {
      const result = await this.app.getLumoClient().chat(
        query,
        (chunk) => {
          if (chunkCount === 0) clearBusyIndicator();
          process.stdout.write(chunk);
          chunkCount++;
        },
        { enableEncryption: true, enableExternalTools: false }
      );

      if (chunkCount === 0) clearBusyIndicator();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      process.stdout.write('\n\n');
      logger.info({ responseLength: result.response.length, chunkCount, elapsedSeconds: elapsed }, 'Done');
    } catch (error) {
      clearBusyIndicator();
      process.stdout.write('\n');
      logger.error({ error }, 'Request failed');
      this.handleError(error);
      process.exit(1);
    }
  }

  private async interactiveMode(): Promise<void> {
    const store = this.app.getConversationStore();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = (): Promise<string | null> => {
      return new Promise((resolve) => {
        rl.question('You: ', (answer) => {
          resolve(answer);
        });
        rl.once('close', () => resolve(null));
      });
    };

    // Welcome message
    process.stdout.write('\n');
    process.stdout.write('Welcome to Lumo Bridge CLI\n');
    process.stdout.write('Type /help for commands, /quit to exit.\n');
    process.stdout.write('\n');

    while (true) {
      const input = await prompt();

      if (input === null || input === '/quit') {
        break;
      }

      // Handle commands (e.g., /save, /sync, /deleteallspaces, /title)
      if (isCommand(input)) {
        const commandContext: CommandContext = {
          syncInitialized: this.app.isSyncInitialized(),
          conversationId: this.conversationId,
        };
        try {
          const result = await executeCommand(input, commandContext);
          process.stdout.write(result + '\n\n');
        } catch (error) {
          // Unknown command - show help
          process.stdout.write(`Unknown command. Available: /save, /title, /quit\n\n`);
        }
        continue;
      }

      if (!input.trim()) {
        continue;
      }

      // Append user message to conversation store
      store.appendMessages(this.conversationId, [{
        role: 'user',
        content: input,
      }]);

      process.stdout.write('Lumo: ' + BUSY_INDICATOR);
      let chunkCount = 0;

      try {
        const turns = store.toTurns(this.conversationId);

        // Request title for new conversations (first message)
        const existingConv = store.get(this.conversationId);
        const requestTitle = existingConv?.title === 'New Conversation';

        const result = await this.app.getLumoClient().chatWithHistory(
          turns,
          (chunk) => {
            if (chunkCount === 0) clearBusyIndicator();
            process.stdout.write(chunk);
            chunkCount++;
          },
          { enableEncryption: true, enableExternalTools: false, requestTitle }
        );

        if (chunkCount === 0) clearBusyIndicator();
        process.stdout.write('\n\n');

        // Save generated title if present
        if (result.title) {
          const processedTitle = postProcessTitle(result.title);
          store.setTitle(this.conversationId, processedTitle);
          logger.debug({ title: processedTitle }, 'Set generated title');
        }

        // Append assistant response to store
        store.appendAssistantResponse(this.conversationId, result.response);
      } catch (error) {
        clearBusyIndicator();
        process.stdout.write('\n');
        logger.error({ error }, 'Request failed');
        this.handleError(error);
        // Remove failed user message from store by starting a new conversation
        // (ConversationStore doesn't have a pop method, so we just note the error)
      }
    }

    rl.close();

    // Sync on exit if available
    if (this.app.isSyncInitialized()) {
      process.stdout.write('Syncing conversations before exit...\n');
      const commandContext: CommandContext = { syncInitialized: true };
      try {
        const result = await executeCommand('/save', commandContext);
        process.stdout.write(result + '\n');
      } catch {
        // Ignore errors on exit sync
      }
    }

    process.stdout.write('Goodbye!\n');
  }

  private handleError(error: unknown): void {
    if (error instanceof Error) {
      if (error.message.includes('401')) {
        logger.error('Hint: Auth tokens may be invalid or expired. Run extraction script to refresh.');
      } else if (error.message.includes('403')) {
        logger.error('Hint: Access forbidden. Check if account has Lumo access.');
      } else if (error.message.includes('404')) {
        logger.error('Hint: API endpoint not found.');
      }
    }
  }
}
