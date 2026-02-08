/**
 * Template interpolation using Handlebars.
 *
 * Supported syntax:
 * - {{varName}} - variable substitution
 * - {{#if varName}}...{{/if}} - conditional block (included if var is truthy)
 * - {{#if varName}}...{{else}}...{{/if}} - conditional with else branch
 *
 * Note: We use Handlebars for robust template parsing. While it supports
 * more features (loops, partials, etc.), we only use basic conditionals.
 */
import Handlebars from 'handlebars';
import { logger } from '../../app/logger.js';

export function interpolateTemplate(
  template: string,
  vars: Record<string, string | undefined>
): string {
  const compiled = Handlebars.compile(template, { noEscape: true });
  const result = compiled(vars);

  // Clean up excessive blank lines left by removed blocks
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// ── Template validation ───────────────────────────────────────────────

/**
 * Important template variables that should be present for full functionality.
 * Each has a warning message explaining the consequence of omission.
 */
const TEMPLATE_VARIABLE_WARNINGS: Record<string, string> = {
  clientInstructions: 'Instructions provided by API client will not be forwarded',
  tools: 'Tool definitions will not be included in instructions',
  fallback: 'No fallback instructions when client provides no system message',
};

let templateValidated = false;

/**
 * Validate template contains important variables. Warns once on first use.
 */
export function validateTemplateOnce(template: string): void {
  if (templateValidated) return;
  templateValidated = true;

  for (const [varName, warning] of Object.entries(TEMPLATE_VARIABLE_WARNINGS)) {
    // Check for {{varName}} or {{#if varName}}
    const pattern = new RegExp(`\\{\\{#?(?:if\\s+)?${varName}\\}\\}`);
    if (!pattern.test(template)) {
      logger.warn(`Template missing {{${varName}}}. ${warning}`);
    }
  }
}
