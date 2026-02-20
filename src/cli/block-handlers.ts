  /**
 * Block handler registry for CLI
 *
 * Each block type (edit, read, create, execute) implements BlockHandler.
 * The registry collects them so client.ts and code-block-detector.ts
 * can dispatch generically. Order matters: first match wins.
 * Add new block types here (no changes needed in client.ts).
 */

import { editHandler } from './edit-applier.js';
import { readHandler } from './file-reader.js';
import { createHandler } from './file-creator.js';
import { executeHandler } from './code-executor.js';
import { BlockHandler } from './types.js';

export const blockHandlers: BlockHandler[] = [
  readHandler,
  editHandler,
  createHandler,
  executeHandler, // last, matches dynamically via config
];
