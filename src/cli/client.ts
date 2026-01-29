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
import { getToolsConfig, getCommandsConfig } from '../app/config.js';
import { isCommand, executeCommand, type CommandContext } from '../app/commands.js';
import type { AppContext } from '../app/index.js';
import { postProcessTitle } from '../proton-shims/lumo-api-client-utils.js';
import { CodeBlockDetector, type CodeBlock } from './code-block-detector.js';
import { blockHandlers, type BlockResult } from './block-handlers.js';
import { confirmAndApply } from './confirm.js';
import { injectInstructions } from './message-converter.js';

interface LumoResponse {
  response: string;
  blocks: CodeBlock[];
  title?: string;
}

interface HandledBlock {
  block: CodeBlock;
  result: BlockResult;
}

const BUSY_INDICATOR = '...';

function clearBusyIndicator(): void {
  // Backspace over "..."
  process.stdout.write('\b\b\b   \b\b\b');
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
    const toolsConfig = getToolsConfig();
    const detector = toolsConfig.enabled
      ? new CodeBlockDetector((lang) =>
          blockHandlers.some(h => h.matches({ language: lang, content: '' }))
        )
      : null;
    const blocks: CodeBlock[] = [];
    let chunkCount = 0;

    process.stdout.write('Lumo: ' + BUSY_INDICATOR);

    const turns = injectInstructions(this.store.toTurns(this.conversationId));
    const result = await this.app.getLumoClient().chatWithHistory(
      turns,
      (chunk) => {
        if (chunkCount === 0) clearBusyIndicator();
        if (detector) {
          const { text, blocks: newBlocks } = detector.processChunk(chunk);
          process.stdout.write(text);
          blocks.push(...newBlocks);
        } else {
          process.stdout.write(chunk);
        }
        chunkCount++;
      },
      { enableEncryption: true, enableExternalTools: false, requestTitle: options.requestTitle }
    );

    // Finalize detection
    if (detector) {
      const final = detector.finalize();
      if (chunkCount === 0) clearBusyIndicator();
      process.stdout.write(final.text);
      blocks.push(...final.blocks);
    } else {
      if (chunkCount === 0) clearBusyIndicator();
    }
    process.stdout.write('\n\n');

    // Handle title
    if (result.title) {
      const processedTitle = postProcessTitle(result.title);
      this.store.setTitle(this.conversationId, processedTitle);
    }

    return { response: result.response, blocks, title: result.title };
  }

  /**
   * Execute code blocks with user confirmation.
   * Returns results for blocks that were executed (not skipped).
   */
  private async executeBlocks(rl: readline.Interface, blocks: CodeBlock[]): Promise<HandledBlock[]> {
    const results: HandledBlock[] = [];

    // Count actionable blocks for skip-all message (silent blocks don't count)
    const actionableCount = blocks.filter(b => {
      const h = blockHandlers.find(h => h.matches(b));
      return h?.requiresConfirmation;
    }).length;
    let processed = 0;

    for (const block of blocks) {
      const handler = blockHandlers.find(h => h.matches(block));
      if (!handler) continue;

      if (!handler.requiresConfirmation) {
        const result = await handler.apply(block);
        results.push({ block, result });
        continue;
      }

      processed++;
      const opts = handler.confirmOptions(block);
      const outcome = await confirmAndApply(rl, {
        ...opts,
        content: block.content,
        apply: () => handler.apply(block),
        formatOutput: handler.formatApplyOutput,
      });

      if (outcome === 'skip_all') {
        const remaining = actionableCount - processed;
        process.stdout.write(`[Skipped this and ${remaining} remaining block${remaining === 1 ? '' : 's'}]\n\n`);
        break;
      }
      if (outcome !== 'skipped') {
        results.push({ block, result: outcome });
      }
    }

    return results;
  }

  /**
   * Format execution results as a message to send back to Lumo.
   */
  private formatResultsMessage(results: HandledBlock[]): string {
    return results.map(({ block, result }) => {
      const handler = blockHandlers.find(h => h.matches(block));
      return handler ? handler.formatResult(block, result) : result.output;
    }).join('\n\n');
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
    process.stdout.write('\n');
    process.stdout.write('Welcome to lumo-tamer cli\n');
    if (commandsConfig.enabled)
      process.stdout.write('Type /help for commands, /quit to exit.\n');
    process.stdout.write('\n');

    while (true) {
      const input = await prompt();

      if (input === null || input === '/quit') {
        break;
      }

      // Handle commands (e.g., /save, /sync, /deleteallspaces, /title)
      if (isCommand(input)) {
        if (commandsConfig.enabled) {
          const commandContext: CommandContext = {
            syncInitialized: this.app.isSyncInitialized(),
            conversationId: this.conversationId,
            authManager: this.app.getAuthManager(),
          };
          const result = await executeCommand(input, commandContext);
          process.stdout.write(result + '\n\n');
          continue;
        } else {
          logger.debug({ input }, 'Command ignored (commands.enabled=false)');
          // Fall through to treat as regular message
        }
      }

      if (!input.trim()) {
        continue;
      }

      try {
        // Append user message and get response
        this.store.appendUserMessage(this.conversationId, input);

        // Request title for new conversations (first message)
        const existingConv = this.store.get(this.conversationId);
        const requestTitle = existingConv?.title === 'New Conversation';

        let { response, blocks } = await this.sendToLumo({ requestTitle });
        this.store.appendAssistantResponse(this.conversationId, response);

        // Execute blocks until none remain (or user skips all)
        while (blocks.length > 0) {
          const results = await this.executeBlocks(rl, blocks);
          if (results.length === 0) break; // user skipped all

          // Send batch results back to Lumo
          process.stdout.write('─── Sending results to Lumo ───\n\n');
          const batchMessage = this.formatResultsMessage(results);
          this.store.appendUserMessage(this.conversationId, batchMessage);

          ({ response, blocks } = await this.sendToLumo());
          this.store.appendAssistantResponse(this.conversationId, response);
        }
      } catch (error) {
        clearBusyIndicator();
        process.stdout.write('\n');
        logger.error({ error }, 'Request failed');
        this.handleError(error);
      }
    }

    rl.close();

    // Sync on exit if available and commands enabled
    if (this.app.isSyncInitialized() && getCommandsConfig().enabled) {
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
