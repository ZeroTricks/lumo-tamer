/**
 * Instructions processing utilities
 *
 * - Template interpolation using Handlebars
 * - Replace patterns for cleaning client instructions
 */

import Handlebars from 'handlebars';
import { logger } from '../app/logger.js';
import { getServerInstructionsConfig } from '../app/config.js';

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
 * Also validates replace patterns (server-only).
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

  // Also validate replace patterns (only used in server mode)
  validateReplacePatternsOnce();
}

// ── Replace patterns ──────────────────────────────────────────────────

export interface ReplacePattern {
  pattern: string;
  replacement?: string;
}

/**
 * Apply replace patterns to text (case-insensitive regex).
 * Each pattern can have an optional replacement; if omitted, matches are stripped.
 */
export function applyReplacePatterns(text: string, patterns: ReplacePattern[]): string {
  if (!patterns || patterns.length === 0) return text;
  let result = text;
  for (const { pattern, replacement } of patterns) {
    try {
      const regex = new RegExp(pattern, 'gi');
      result = result.replace(regex, replacement ?? '');
    } catch {
      // Invalid regex pattern - skip it (already warned at config load)
    }
  }
  // Clean up multiple consecutive newlines/spaces left by removals
  return result.replace(/\n{3,}/g, '\n\n').replace(/  +/g, ' ').trim();
}

// ── Replace patterns validation ───────────────────────────────────────

let replacePatternsValidated = false;

/**
 * Validate replace patterns are valid regex. Warns once on first use.
 * Called from validateTemplateOnce (server-only).
 */
function validateReplacePatternsOnce(): void {
  if (replacePatternsValidated) return;
  replacePatternsValidated = true;

  const patterns = getServerInstructionsConfig().replacePatterns ?? [];
  for (const { pattern } of patterns) {
    try {
      new RegExp(pattern, 'gi');
    } catch (e) {
      logger.warn(`Invalid regex in instructions.replacePatterns: "${pattern}" - ${(e as Error).message}`);
    }
  }
}
