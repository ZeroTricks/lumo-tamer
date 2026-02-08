/**
 * Converts CLI conversation turns with instruction injection.
 *
 * CLI equivalent of src/api/message-converter.ts.
 * Builds effective instructions from config and injects them
 * into the first user message as [Personal context: ...].
 */

import type { Turn } from '../lumo-client/index.js';
import { getCliInstructionsConfig, getLocalActionsConfig } from '../app/config.js';
import { isCommand } from '../app/commands.js';

/**
 * Build effective instructions for CLI.
 * Combines default instructions with forTools when tools are enabled.
 */
function buildEffectiveInstructions(): string | undefined {
  const instructionsConfig = getCliInstructionsConfig();
  const localActionsConfig = getLocalActionsConfig();

  let instructions = instructionsConfig?.fallback;

  // Append forTools instructions when local actions enabled
  if (localActionsConfig.enabled && instructionsConfig?.forTools) {
    instructions = instructions
      ? `${instructions}\n\n${instructionsConfig.forTools}`
      : instructionsConfig.forTools;
  }

  return instructions;
}

/**
 * Inject instructions into the first user message of turns.
 * Uses the same pattern as API: [Personal context: ...]
 */
export function injectInstructions(turns: Turn[]): Turn[] {
  const instructions = buildEffectiveInstructions();
  if (!instructions) return turns;

  return turns.map((turn, index) => {
    // Find first user message that isn't a command
    const isFirstUser = turn.role === 'user' &&
      !turns.slice(0, index).some(t => t.role === 'user' && !isCommand(t.content || ''));

    if (isFirstUser && turn.content && !isCommand(turn.content)) {
      return {
        ...turn,
        content: `${turn.content}\n\n[Personal context: ${instructions}]`,
      };
    }
    return turn;
  });
}
