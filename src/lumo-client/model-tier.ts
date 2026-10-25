/**
 * Maps the inbound OpenAI `model` field to a Lumo tier, and the inbound
 * `reasoning_effort` to a thinking-mode boolean.
 */

import type { LumoModelTier } from './types.js';

/**
 * Normalize a client-supplied model id: lowercase, trimmed, and stripped of any
 * provider prefix (e.g. "proton/lumo-max" -> "lumo-max").
 */
export function normalizeModelId(model?: unknown): string {
    if (typeof model !== 'string') {
        return '';
    }
    const lower = model.trim().toLowerCase();
    const slash = lower.lastIndexOf('/');
    return slash >= 0 ? lower.slice(slash + 1) : lower;
}

/** Canonical inbound reasoning_effort values. */
export const VALID_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const;

/** IDE / OpenAI aliases mapped onto Lumo's on/off thinking mode. */
const REASONING_OFF = new Set(['none', 'auto', 'minimal']);
const REASONING_ON = new Set(['low', 'medium', 'high', 'xhigh', 'extra_high']);

function normalizeReasoningEffort(effort: unknown): string | undefined {
    if (typeof effort !== 'string') return undefined;
    const normalized = effort.trim().toLowerCase();
    return normalized || undefined;
}

/** True if the effort is absent/null or a known (or aliased) string value. */
export function isValidReasoningEffort(effort: unknown): boolean {
    if (effort === undefined || effort === null) return true;
    const normalized = normalizeReasoningEffort(effort);
    return !!normalized && (REASONING_OFF.has(normalized) || REASONING_ON.has(normalized));
}

/** Inbound aliases that Proton's web client sends as `apertus-15`. */
const APERTUS_ALIASES = new Set(['apertus-15', 'apertus', 'apertus-1.5', 'apertus1.5']);

/** Map a normalized model id to a tier. `lumo`/`auto`/unknown-ish -> 'auto'. */
export function modelToTier(normalizedModel: string): LumoModelTier {
    const id = normalizedModel.replace(/\s+/g, '-');
    switch (id) {
        case 'lumo-lite':
            return 'lumo-lite';
        case 'lumo-max':
            return 'lumo-max';
        case 'apertus-15':
        case 'apertus':
        case 'apertus-1.5':
        case 'apertus1.5':
            return 'apertus-15';
        default:
            return 'auto';
    }
}

/** True if the normalized model is in the allowed list (also normalized). */
export function isModelAllowed(normalizedModel: string, allowedModels: string[]): boolean {
    const id = normalizedModel.replace(/\s+/g, '-');
    const allowed = allowedModels.map((m) => normalizeModelId(m).replace(/\s+/g, '-'));
    if (allowed.includes(id)) {
        return true;
    }
    return APERTUS_ALIASES.has(id) && allowed.some((m) => APERTUS_ALIASES.has(m));
}

/**
 * Resolve the inbound reasoning_effort to a thinking-mode boolean.
 * `none` -> false; `low`/`medium`/`high` -> true; absent -> config default.
 */
export function resolveReasoning(
    effort: string | null | undefined,
    defaultHigh: boolean,
): boolean {
    const normalized = normalizeReasoningEffort(effort);
    if (!normalized) {
        return defaultHigh;
    }
    if (REASONING_OFF.has(normalized)) return false;
    if (REASONING_ON.has(normalized)) return true;
    return defaultHigh;
}
