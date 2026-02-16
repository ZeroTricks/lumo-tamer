/**
 * Converts CLI conversation turns with instruction injection.
 *
 * CLI equivalent of src/api/message-converter.ts.
 * Builds effective instructions from config and injects them
 * into the first or last user message as [Project instructions: ...].
 */

import type { Turn } from '../lumo-client/index.js';
import { getCliInstructionsConfig, getLocalActionsConfig } from '../app/config.js';
import {
  interpolateTemplate,
  sanitizeInstructions,
  injectInstructionsIntoTurns,
} from '../app/instructions.js';

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
  const result = interpolateTemplate(instructionsConfig.template, {
    localActions: localActionsConfig.enabled ? 'true' : undefined,
    forLocalActions,
    executors,
  });

  // Sanitize to avoid breaking the [Project instructions: ...] wrapper
  return result ? sanitizeInstructions(result) : undefined;
}

/**
 * Inject instructions into a user message of turns.
 *
 * Reads config for injectInto setting, builds CLI instructions,
 * and delegates to shared injectInstructionsIntoTurns.
 */
export function injectInstructions(turns: Turn[]): Turn[] {
  const { injectInto } = getCliInstructionsConfig();
  const instructions = buildEffectiveInstructions();
  return injectInstructionsIntoTurns(turns, instructions, injectInto);
}
