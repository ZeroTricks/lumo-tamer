/**
 * Builds CLI instructions for LumoClient.
 *
 * Instructions are injected by LumoClient at the last moment,
 * not persisted in the conversation store.
 */

import { getCliInstructionsConfig, getLocalActionsConfig } from '../app/config.js';
import { interpolateTemplate, sanitizeInstructions } from '../app/instructions.js';

/**
 * Build effective instructions for CLI using template system.
 */
export function buildCliInstructions(): string | undefined {
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
