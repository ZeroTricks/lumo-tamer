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
import { interpolateTemplate } from '../api/instructions.js';

/**
 * Build effective instructions for CLI using template system.
 */
function buildEffectiveInstructions(): string | undefined {
  const instructionsConfig = getCliInstructionsConfig();
  const localActionsConfig = getLocalActionsConfig();

  // Build executor list (comma-separated language tags)
  const executorKeys = Object.keys(localActionsConfig.executors || {});
  const executors = executorKeys.join(', ');

  // Pre-interpolate forLocalActions with executors
  const forLocalActions = interpolateTemplate(instructionsConfig.forLocalActions, { executors });

  // Interpolate main template
  return interpolateTemplate(instructionsConfig.template, {
    localActions: localActionsConfig.enabled ? 'true' : undefined,
    forLocalActions,
    executors,
  });
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
