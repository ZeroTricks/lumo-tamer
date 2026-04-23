/**
 * Builds CLI instructions for LumoClient.
 *
 * Instructions are injected by LumoClient at the last moment,
 * not persisted in the conversation store.
 */

import { getCliInstructionsConfig, getLocalToolsConfig } from '../app/config.js';
import { interpolateTemplate } from '../app/template.js';

/**
 * Build effective instructions for CLI using template system.
 */
export function buildCliInstructions(): string | undefined {
  const instructionsConfig = getCliInstructionsConfig();
  const localToolsConfig = getLocalToolsConfig();

  // Build executor list (comma-separated language tags)
  const executorKeys = Object.keys(localToolsConfig.executors || {});
  const executors = executorKeys.join(', ');

  // Pre-interpolate forLocalTools with executors
  const forLocalTools = interpolateTemplate(instructionsConfig.forLocalTools, { executors });

  // Interpolate main template
  const result = interpolateTemplate(instructionsConfig.template, {
    localTools: localToolsConfig.enabled ? 'true' : undefined,
    forLocalTools,
    executors,
  });

  return result;
}
