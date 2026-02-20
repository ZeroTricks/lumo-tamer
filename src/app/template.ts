/**
 * Instruction utilities shared between API and CLI.
 *
 * - Template interpolation using Handlebars
 */

import Handlebars from 'handlebars';

// ── Template interpolation ────────────────────────────────────────────
/**
 * Interpolate a Handlebars template with variables.
 *
 * Supported syntax:
 * - {{varName}} - variable substitution
 * - {{#if varName}}...{{/if}} - conditional block (included if var is truthy)
 * - {{#if varName}}...{{else}}...{{/if}} - conditional with else branch
 */

export function interpolateTemplate(
  template: string,
  vars: Record<string, string | undefined>
): string {
  const compiled = Handlebars.compile(template, { noEscape: true });
  const result = compiled(vars);

  // Clean up excessive blank lines left by removed blocks
  return result.replace(/\n{3,}/g, '\n\n').trim();
}
