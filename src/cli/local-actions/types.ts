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

  /** Confirm dialog options (only used when requiresConfirmation is true) */
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

// Edit block delimiters. If changed, update cli.instructions.forTools in config.defaults.yaml.
export const FILE_PREFIX = '=== FILE:';
export const SEARCH_MARKER = '<<<<<<< SEARCH';
export const DIVIDER = '=======';
export const REPLACE_MARKER = '>>>>>>> REPLACE';

