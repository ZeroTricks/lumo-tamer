/**
 * Builds CLI instructions for LumoClient.
 *
 * Instructions are injected by LumoClient at the last moment,
 * not persisted in the conversation store.
 */

import { getCliInstructionsConfig, getLocalActionsConfig } from '../app/config.js';
import { interpolateTemplate } from '../app/template.js';

/**
 * Build effective instructions for CLI using template system.
 */
export function buildCliInstructions(): string | undefined {
  const localActionsConfig = getLocalActionsConfig();
  // When tamer is writing files itself, do not instruct Lumo about a filesystem.
  // That text makes Lumo refuse and argue instead of writing code.
  if (localActionsConfig.enabled) return undefined;

  const instructionsConfig = getCliInstructionsConfig();
  const executorKeys = Object.keys(localActionsConfig.executors || {});
  const executors = executorKeys.join(', ');
  const forLocalActions = interpolateTemplate(instructionsConfig.forLocalActions, { executors });
  const result = interpolateTemplate(instructionsConfig.template, {
    localActions: undefined,
    forLocalActions,
    executors,
  });

  return result?.trim() ? result : undefined;
}
