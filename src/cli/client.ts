/**
 * CLIClient - Interactive command-line interface for Lumo
 *
 * Uses the shared Application layer for auth, persistence, and client access.
 *
 * Usage: npm run dev:cli (or npm run cli for production)
 *        Single query mode: pass query as argv[2]
 *        Interactive mode: no argv
 */

import { executeCommand, isCommand, type CommandContext } from 'app/commands.js';
import { getCliInstructionsConfig, getCommandsConfig, getLocalActionsConfig } from 'app/config.js';
import logger from 'app/logger.js';
import { BUSY_INDICATOR, clearBusyIndicator, print } from 'app/terminal.js';
import type { AppContext } from 'app/types.js';
import { randomUUID } from 'crypto';
import * as readline from 'readline';
import type { AssistantMessageData } from '../lumo-client/index.js';
import { blockHandlers, executeBlocks, formatResultsMessage } from './local-actions/block-handlers.js';
import { CodeBlockDetector, type CodeBlock } from './local-actions/code-block-detector.js';
import { buildCliInstructions } from './message-converter.js';

interface LumoResponse {
  /** Assistant message data ready for persistence */
  message: AssistantMessageData;
  blocks: CodeBlock[];
  title?: string;
}

export class CLIClient {
  private conversationId: string;
  private store;

  constructor(private app: AppContext) {
    this.conversationId = randomUUID();
    this.store = app.getConversationStore();
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

  /**
   * Send current conversation to Lumo and get response with detected code blocks.
   * Handles streaming, detection, and display.
   */
  private async sendToLumo(options: { requestTitle?: boolean } = {}): Promise<LumoResponse> {
    const localActionsConfig = getLocalActionsConfig();
    const detector = localActionsConfig.enabled
      ? new CodeBlockDetector((lang) =>
        blockHandlers.some(h => h.matches({ language: lang, content: '' }))
      )
      : null;
    const blocks: CodeBlock[] = [];
    let chunkCount = 0;

    print('Lumo: ' + BUSY_INDICATOR, false);

    const turns = this.store.toTurns(this.conversationId);
    const instructions = buildCliInstructions();
    const { injectInto } = getCliInstructionsConfig();
    const result = await this.app.getLumoClient().chatWithHistory(
      turns,
      (chunk) => {
        if (chunkCount === 0) clearBusyIndicator();
        if (detector) {
          const { text, blocks: newBlocks } = detector.processChunk(chunk);
          print(text, false);
          blocks.push(...newBlocks);
        } else {
          print(chunk, false);
        }
        chunkCount++;
      },
      { enableEncryption: true, requestTitle: options.requestTitle, instructions, injectInstructionsInto: injectInto }
    );

    // Finalize detection
    if (detector) {
      const final = detector.finalize();
      if (chunkCount === 0) clearBusyIndicator();
      print(final.text, false);
      blocks.push(...final.blocks);
    } else {
      if (chunkCount === 0) clearBusyIndicator();
    }
    print('\n');

    // Handle title (already processed by LumoClient)
    if (result.title) {
      this.store.setTitle(this.conversationId, result.title);
    }

    return {
      message: result.message,
      blocks,
      title: result.title,
    };
  }

  private async singleQuery(query: string): Promise<void> {
    logger.info({ query }, 'Sending query');
    print('');

    const startTime = Date.now();
    let chunkCount = 0;
    print(BUSY_INDICATOR, false);

    try {
      const result = await this.app.getLumoClient().chat(
        query,
        (chunk) => {
          if (chunkCount === 0) clearBusyIndicator();
          print(chunk, false);
          chunkCount++;
        },
        { enableEncryption: true }
      );

      if (chunkCount === 0) clearBusyIndicator();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      print('\n');
      logger.info({ responseLength: result.message.content.length, chunkCount, elapsedSeconds: elapsed }, 'Done');
    } catch (error) {
      clearBusyIndicator();
      print('');
      logger.error({ error }, 'Request failed');
      this.handleError(error);
      process.exit(1);
    }
  }

  private async interactiveMode(): Promise<void> {
    const commandsConfig = getCommandsConfig();

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
    print('');
    print('Welcome to lumo-tamer cli');
    if (commandsConfig.enabled)
      print('Type /help for commands, /quit to exit.');
    print('');
    let goOn = true;

    while (goOn) {
      goOn = await this.handleUserInput(prompt, rl, commandsConfig.enabled);
    }

    rl.close();

    // Sync on exit if available and commands enabled
    if (this.app.isSyncInitialized() && getCommandsConfig().enabled) {
      print('Syncing conversations...');
      const commandContext: CommandContext = { syncInitialized: true };
      try {
        const result = await executeCommand('/save', commandContext);
        print(result);
      } catch {
        // Ignore errors on exit sync
      }
    }

    print('Goodbye!');
  }

  private async handleUserInput(
    prompt: () => Promise<string | null>,
    rl: readline.Interface,
    commandsEnabled: boolean
  ) {
    const input = await prompt();

    if (input === null || input === '/quit') {
      return false;
    }

    // Handle commands (e.g., /save, /sync, /deleteallspaces, /title)
    if (isCommand(input)) {
      if (commandsEnabled) {
        const commandContext: CommandContext = {
          syncInitialized: this.app.isSyncInitialized(),
          conversationId: this.conversationId,
          authManager: this.app.getAuthManager(),
        };
        const result = await executeCommand(input, commandContext);
        print(result + '\n');
        return true;
      } else {
        logger.debug({ input }, 'Command ignored (commands.enabled=false)');
        // Fall through to treat as regular message
      }
    }

    if (!input.trim()) {
      return true;
    }

    try {
      // Append user message and get response
      this.store.appendUserMessage(this.conversationId, input);

      // Request title for new conversations (first message)
      const existingConv = this.store.get(this.conversationId);
      const requestTitle = existingConv?.title === 'New Conversation';

      let lumoResponse = await this.sendToLumo({ requestTitle });
      this.store.appendAssistantResponse(this.conversationId, lumoResponse.message);

      // Execute blocks until none remain (or user skips all)
      while (lumoResponse.blocks.length > 0) {
        const results = await executeBlocks(rl, lumoResponse.blocks);
        if (results.length === 0) break; // user skipped all


        // Send batch results back to Lumo
        print('─── Sending results to Lumo ───\n');
        const batchMessage = formatResultsMessage(results);
        this.store.appendUserMessage(this.conversationId, batchMessage);

        lumoResponse = await this.sendToLumo();
        this.store.appendAssistantResponse(this.conversationId, lumoResponse.message);
      }
    } catch (error) {
      clearBusyIndicator();
      print('');
      logger.error({ error }, 'Request failed');
      this.handleError(error);
    }
    return true;
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

