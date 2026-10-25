  /**
 * Block handler registry for CLI
 *
 * Each block type (edit, read, create, execute) implements BlockHandler.
 * The registry collects them so client.ts and code-block-detector.ts
 * can dispatch generically. Order matters: first match wins.
 * Add new block types here (no changes needed in client.ts).
 */

import { print } from '../../app/terminal.js';
import * as readline from 'readline';
import { BlockHandler, HandledBlock, type CodeBlock } from './types.js';
import { approvalPolicy } from './approval-policy.js';
import { confirmAndApply } from './confirm.js';

import { executeHandler } from './code-executor.js';
import { editHandler } from './edit-applier.js';
import { createHandler } from './file-creator.js';
import { readHandler } from './file-reader.js';
import { searchHandler } from './search-files.js';

export const blockHandlers: BlockHandler[] = [
  searchHandler,
  readHandler,
  editHandler,
  createHandler,
  executeHandler, // last, matches dynamically via config
]

/**
 * Execute code blocks with user confirmation.
 * Returns results for blocks that were executed (not skipped).
 */
export async function executeBlocks(rl: readline.Interface, blocks: CodeBlock[]): Promise<HandledBlock[]> {
  approvalPolicy.resetTurn();
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
      const summary = handler.summarize(block).trim();
      print(summary.replace(/^\[read:/, '[reading:'));
      const result = await handler.apply(block);
      if (result.success) {
        print(summary.replace(/^\[read:/, '[read done:'));
      } else if (handler.formatApplyOutput) {
        print(handler.formatApplyOutput(result));
      }
      results.push({ block, result });
      continue;
    }

    processed++;
    const opts = handler.confirmOptions(block);
    const outcome = await confirmAndApply(rl, {
      ...opts,
      content: handler.preview?.(block) ?? block.content,
      apply: () => handler.apply(block),
      formatOutput: handler.formatApplyOutput,
    });

    if (outcome === 'skip_all') {
      const remaining = actionableCount - processed;
      print(`[Skipped this and ${remaining} remaining block${remaining === 1 ? '' : 's'}]\n`);
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
export function formatResultsMessage(results: HandledBlock[]): string {
  return results.map(({ block, result }) => {
    const handler = blockHandlers.find(h => h.matches(block));
    return handler ? handler.formatResult(block, result) : result.output;
  }).join('\n\n');
}

export function allLocalActionsSucceeded(results: HandledBlock[]): boolean {
  return results.length > 0 && results.every(({ result }) => result.success);
}

export function isObservationResult(item: HandledBlock): boolean {
  return item.result.type === 'read'
    || item.result.type === 'search'
    || item.block.language === 'read'
    || item.block.language === 'search';
}

/** Reads and failures must go back to Lumo. Successful writes stay local. */
export function shouldReturnResultsToLumo(results: HandledBlock[]): boolean {
  if (results.length === 0) return false;
  if (results.some(({ result }) => !result.success)) return true;
  return results.some(isObservationResult);
}

/** Ask Lumo to fix code. Do not mention lumo-tamer or a local filesystem. */
export function formatRepairPrompt(results: HandledBlock[]): string {
  const failed = results.filter(({ result }) => !result.success);
  const output = (failed.length > 0 ? failed : results)
    .map(({ result }) => result.output)
    .join('\n\n');
  return `The program hit this error. Reply with the complete corrected source in one fenced code block. Do not discuss file access or tools.\n\n${output}`;
}

/** Send read output back so Lumo can review the project. */
export function formatObservationPrompt(results: HandledBlock[]): string {
  return `Here is the requested material. Answer the user's last question from it. Do not discuss tools.\n\n${formatResultsMessage(results)}`;
}

export function formatFollowUpPrompt(results: HandledBlock[]): string {
  const failedOnly = results.some(({ result }) => !result.success) && !results.some(isObservationResult);
  return failedOnly ? formatRepairPrompt(results) : formatObservationPrompt(results);
}

