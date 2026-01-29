/**
 * Block handler interface and registry for CLI
 *
 * Each block type (edit, read, create, execute) implements BlockHandler.
 * The registry collects them so client.ts and code-block-detector.ts
 * can dispatch generically. Order matters: first match wins.
 * Add new block types here — no changes needed in client.ts.
 */

import { editHandler } from './edit-applier.js';
import { readHandler } from './file-reader.js';
import { createHandler } from './file-creator.js';
import { executeHandler } from './code-executor.js';

export interface CodeBlock {
  language: string | null; // "bash", "python", null for untagged
  content: string;
}

export interface BlockResult {
  type: string;
  success: boolean;
  output: string;
}

export interface BlockHandler {
  /** Does this handler own this block? */
  matches(block: CodeBlock): boolean;

  /** One-line summary for streaming display */
  summarize(block: CodeBlock): string;

  /** Needs user confirmation? (false = silent apply, like read) */
  requiresConfirmation: boolean;

  /** Confirm dialog options — only used when requiresConfirmation is true */
  confirmOptions(block: CodeBlock): {
    label: string;
    prompt: string;
    verb: string;
    errorLabel: string;
  };

  /** Apply the block, return result */
  apply(block: CodeBlock): Promise<BlockResult>;

  /** User-facing output shown after successful apply (optional) */
  formatApplyOutput?(result: BlockResult): string;

  /** Format result as message to send back to Lumo */
  formatResult(block: CodeBlock, result: BlockResult): string;
}

export const blockHandlers: BlockHandler[] = [
  readHandler,
  editHandler,
  createHandler,
  executeHandler, // last — matches dynamically via config
];
