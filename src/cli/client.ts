/**
 * CLIClient - Interactive command-line interface for Lumo
 *
 * Uses the shared Application layer for auth, persistence, and client access.
 *
 * Usage: npm run dev:cli (or npm run cli for production)
 *        Single query mode: pass query as argv[2]
 *        Interactive mode: no argv
 */

import { executeCommand, isCommand, type CommandContext } from '../app/commands.js';
import { getCliEnableReasoning, getCliInstructionsConfig, getCliModelTier, getCliModelTierForIntent, getCommandsConfig, getLocalActionsConfig } from '../app/config.js';
import logger from '../app/logger.js';
import { print } from '../app/terminal.js';
import { cliStatus } from '../app/status-line.js';
import type { Application } from '../app/index.js';
import { randomUUID } from 'crypto';
import * as readline from 'readline';
import type { AssistantMessageData } from '../lumo-client/index.js';
import { Role } from '../lumo-client/types.js';
import { blockHandlers, executeBlocks, formatFollowUpPrompt, formatRepairPrompt, shouldReturnResultsToLumo } from './local-actions/block-handlers.js';
import { FILE_ACTION_NUDGE, ensureActionBlocks, looksLikeAccessRefusal } from './local-actions/promote-blocks.js';
import { CodeBlockDetector, type CodeBlock } from './local-actions/code-block-detector.js';
import { confirm } from './local-actions/confirm.js';
import { executeBlock } from './local-actions/code-executor.js';
import { listSourceFiles } from './local-actions/paths-guard.js';
import {
  buildAgentContext,
  detectAgentIntent,
  snapshotLimitsFromConfig,
  wantsProjectContext,
  type AgentIntent,
} from './local-actions/project-context.js';
import { inferRunCommand } from './local-actions/run-after-write.js';
import { writeJournal } from './local-actions/write-journal.js';
import { loadCliSession, saveCliSession } from './session.js';
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
  private lastIntent: AgentIntent = 'chat';
  private lastFiles: string[] = [];
  private lastError?: string;

  constructor(private app: Application) {
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

    cliStatus.start('Waiting for Lumo');

    const turns = this.store.toTurns(this.conversationId);
    const instructions = buildCliInstructions();
    const { injectInto } = getCliInstructionsConfig();
    try {
      const result = await this.app.getLumoClient().chatWithHistory(
        turns,
        (chunk) => {
          if (chunkCount === 0) {
            cliStatus.stop();
            print('Lumo: ', false);
          }
          if (detector) {
            const { text, blocks: newBlocks, opened, receiving } = detector.processChunk(chunk);
            print(text, false);
            if (opened !== undefined) {
              print(`\n[receiving ${opened || 'code'} — still streaming, not stuck]\n`);
            }
            if (receiving) {
              const kb = Math.max(1, Math.round(receiving.bytes / 1024));
              cliStatus.show(`Receiving ${receiving.language || 'code'} (${kb} KB)`);
            } else {
              cliStatus.stop();
            }
            blocks.push(...newBlocks);
          } else {
            print(chunk, false);
          }
          chunkCount++;
        },
        {
          enableEncryption: true,
          requestTitle: options.requestTitle,
          instructions,
          injectInstructionsInto: injectInto,
          instructionWrapper: 'cli',
          modelTier: getCliModelTierForIntent(this.lastIntent),
          enableReasoning: getCliEnableReasoning(),
          onReasoning: () => {
            if (chunkCount === 0) cliStatus.update('Lumo is thinking');
          },
        }
      );

      // Finalize detection
      if (detector) {
        const final = detector.finalize();
        if (chunkCount === 0) {
          cliStatus.stop();
          print('Lumo: ', false);
        }
        print(final.text, false);
        blocks.push(...final.blocks);
      } else if (chunkCount === 0) {
        cliStatus.stop();
        print('Lumo: ', false);
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
    } finally {
      cliStatus.stop();
    }
  }

  private async singleQuery(query: string): Promise<void> {
    logger.info({ query }, 'Sending query');
    print('');

    const startTime = Date.now();
    let chunkCount = 0;
    cliStatus.start('Waiting for Lumo');

    try {
      const result = await this.app.getLumoClient().chat(
        query,
        (chunk) => {
          if (chunkCount === 0) {
            cliStatus.stop();
            print('Lumo: ', false);
          }
          print(chunk, false);
          chunkCount++;
        },
        {
          enableEncryption: true,
          modelTier: getCliModelTier(),
          enableReasoning: getCliEnableReasoning(),
          onReasoning: () => {
            if (chunkCount === 0) cliStatus.update('Lumo is thinking');
          },
        }
      );

      if (chunkCount === 0) {
        cliStatus.stop();
        print('Lumo: ', false);
      }
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      print('\n');
      logger.info({ responseLength: result.message.content.length, chunkCount, elapsedSeconds: elapsed }, 'Done');
    } catch (error) {
      cliStatus.stop();
      print('');
      logger.error({ error }, 'Request failed');
      this.handleError(error);
      process.exit(1);
    } finally {
      cliStatus.stop();
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
    print('Status: waiting / thinking / reading / writing shows while work is in progress.');
    print('Type /new to start a fresh chat if Lumo gets stuck refusing file access.');
    print('Ask to review this folder, mention @file, or /files /undo.');
    print(`Model: review=${getCliModelTierForIntent('review')} coding=${getCliModelTierForIntent('edit')}${getCliEnableReasoning() ? ' (thinking on)' : ''}`);
    print('');
    this.restoreSession();
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

  private restoreSession(): void {
    const session = loadCliSession(process.cwd());
    if (!session || session.turns.length === 0) return;
    this.conversationId = session.conversationId;
    this.lastFiles = session.lastFiles ?? [];
    this.lastError = session.lastError;
    const existing = this.store.get(this.conversationId);
    if (!existing || existing.messages.length === 0) {
      this.store.getOrCreate(this.conversationId);
      this.store.appendMessages(
        this.conversationId,
        session.turns.map((turn) => ({ role: turn.role as Role, content: turn.content })),
      );
    }
    print(`Resumed last session (${session.turns.length} messages). /new starts fresh.`);
  }

  private persistSession(): void {
    try {
      const conv = this.store.get(this.conversationId);
      saveCliSession({
        cwd: process.cwd(),
        conversationId: this.conversationId,
        lastFiles: this.lastFiles,
        lastError: this.lastError,
        title: conv?.title,
        turns: this.store.toTurns(this.conversationId),
      });
    } catch (error) {
      logger.debug({ error }, 'Could not persist CLI session');
    }
  }

  private attachProjectContext(input: string): string {
    this.lastIntent = detectAgentIntent(input);
    const localActions = getLocalActionsConfig();
    writeJournal.setMaxEntries(localActions.undo.maxEntries);
    if (!localActions.enabled || !localActions.projectContext.enabled || !wantsProjectContext(input)) {
      return input;
    }

    cliStatus.start('Reading project files');
    try {
      const snapshot = buildAgentContext(process.cwd(), input, snapshotLimitsFromConfig(localActions));
      if (snapshot.fileCount === 0) {
        print(`[project: no source files in ${process.cwd()}]\n`);
        return input;
      }
      this.lastFiles = snapshot.files;
      print(`[project: ${snapshot.fileCount} files from ${process.cwd()}]\n`);
      return `${input}\n\nProject files:\n${snapshot.text}`;
    } finally {
      cliStatus.stop();
    }
  }

  private listProjectFiles(): string {
    const files = listSourceFiles(process.cwd(), 80).map((file) => {
      const rel = file.startsWith(process.cwd()) ? file.slice(process.cwd().length + 1) : file;
      return rel;
    });
    const last = this.lastFiles.length > 0 ? `\nLast attached: ${this.lastFiles.join(', ')}` : '';
    return files.length > 0 ? `${files.join('\n')}${last}` : `No source files in ${process.cwd()}`;
  }

  private undoLastWrite(): string {
    if (!getLocalActionsConfig().undo.enabled) {
      return 'Undo is disabled in config.';
    }
    const result = writeJournal.undo();
    if (result.error && result.restored.length === 0) return result.error;
    const restored = result.restored.length > 0 ? `Restored: ${result.restored.join(', ')}` : 'Nothing restored.';
    return result.error ? `${restored}\n${result.error}` : restored;
  }

  private async maybeRunAfterWrite(rl: readline.Interface, files: string[]): Promise<void> {
    const config = getLocalActionsConfig().runAfterWrite;
    if (!config.enabled || files.length === 0) return;
    const command = inferRunCommand(files);
    if (!command) return;
    print(`Suggested run: ${command}`);
    if (config.confirm) {
      const answer = await confirm(rl, 'Run it?', 'execute');
      if (answer !== 'yes' && answer !== 'all_turn') {
        print('[Skipped run]\n');
        return;
      }
    }
    cliStatus.start('Running');
    const result = await executeBlock({ language: 'bash', content: command }, (chunk) => print(chunk, false));
    cliStatus.stop();
    print(`\n[Exit code: ${result.exitCode}]\n`);
    if (!result.success) {
      this.lastError = result.output;
      print('Run failed. Asking Lumo for a code fix.\n');
      this.store.appendUserMessage(this.conversationId, formatRepairPrompt([{
        block: { language: 'bash', content: command },
        result,
      }]));
      const lumoResponse = await this.sendToLumo();
      lumoResponse.blocks = ensureActionBlocks(command, lumoResponse.message.content, lumoResponse.blocks);
      this.store.appendAssistantResponse(this.conversationId, lumoResponse.message);
    }
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

    if (input.trim() === '/new') {
      this.conversationId = randomUUID();
      this.lastFiles = [];
      this.lastError = undefined;
      print('New conversation started. Previous refusals are cleared.\n');
      this.persistSession();
      return true;
    }

    if (input.trim() === '/files') {
      print(this.listProjectFiles() + '\n');
      return true;
    }

    if (input.trim() === '/undo') {
      print(this.undoLastWrite() + '\n');
      return true;
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
      this.store.appendUserMessage(this.conversationId, this.attachProjectContext(input));

      // Request title for new conversations (first message)
      const existingConv = this.store.get(this.conversationId);
      const requestTitle = existingConv?.title === 'New Conversation';

      let lumoResponse = await this.sendToLumo({ requestTitle });
      lumoResponse.blocks = ensureActionBlocks(input, lumoResponse.message.content, lumoResponse.blocks);
      this.store.appendAssistantResponse(this.conversationId, lumoResponse.message);

      if (
        lumoResponse.blocks.length === 0
        && looksLikeAccessRefusal(lumoResponse.message.content)
        && getLocalActionsConfig().enabled
      ) {
        print('Lumo is arguing about file access. Starting a fresh chat with your request only.\n');
        this.conversationId = randomUUID();
        this.store.appendUserMessage(this.conversationId, `${this.attachProjectContext(input)}\n\n${FILE_ACTION_NUDGE}`);
        lumoResponse = await this.sendToLumo({ requestTitle: true });
        lumoResponse.blocks = ensureActionBlocks(input, lumoResponse.message.content, lumoResponse.blocks);
        this.store.appendAssistantResponse(this.conversationId, lumoResponse.message);
      }

      const writtenFiles: string[] = [];
      // Execute blocks until none remain (or user skips all)
      while (lumoResponse.blocks.length > 0) {
        const results = await executeBlocks(rl, lumoResponse.blocks);
        if (results.length === 0) break; // user skipped all

        for (const item of results) {
          const files = (item.result as { files?: string[] }).files ?? [];
          if (item.result.success && (item.result.type === 'create' || item.result.type === 'edit')) {
            writtenFiles.push(...files);
            this.lastFiles = files;
          }
          if (!item.result.success) {
            this.lastError = item.result.output;
          }
        }

        if (!shouldReturnResultsToLumo(results)) {
          print('Finished on your machine. Not sending that back to Lumo.\n');
          break;
        }

        print(results.some(({ result }) => !result.success)
          ? 'Sending results to Lumo.\n'
          : 'Sending project files to Lumo.\n');
        this.store.appendUserMessage(this.conversationId, formatFollowUpPrompt(results));
        lumoResponse = await this.sendToLumo();
        lumoResponse.blocks = ensureActionBlocks(input, lumoResponse.message.content, lumoResponse.blocks);
        this.store.appendAssistantResponse(this.conversationId, lumoResponse.message);
      }

      await this.maybeRunAfterWrite(rl, writtenFiles);
      this.persistSession();
    } catch (error) {
      cliStatus.stop();
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
      } else if (/ENOTFOUND|EAI_AGAIN|fetch failed/i.test(error.message)) {
        logger.error('Hint: Cannot reach lumo.proton.me. Check internet or VPN, then try again.');
      }
    }
  }
}

