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
import { confirmAndApply } from './confirm.js';

import { executeHandler } from './code-executor.js';
import { editHandler } from './edit-applier.js';
import { createHandler } from './file-creator.js';
import { readHandler } from './file-reader.js';

export const blockHandlers: BlockHandler[] = [
  readHandler,
  editHandler,
  createHandler,
  executeHandler, // last, matches dynamically via config
]

;/**
 * Execute code blocks with user confirmation.
 * Returns results for blocks that were executed (not skipped).
 */
export async function executeBlocks(rl: readline.Interface, blocks: CodeBlock[]): Promise<HandledBlock[]> {
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
      if (!result.success && handler.formatApplyOutput) {
        print(handler.formatApplyOutput(result));
      }
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

