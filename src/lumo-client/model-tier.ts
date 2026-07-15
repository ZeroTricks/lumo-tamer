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

/** Valid inbound reasoning_effort values (plus absent/null meaning "use default"). */
export const VALID_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const;

/** True if the effort is absent/null or one of the valid string values. */
export function isValidReasoningEffort(effort: unknown): boolean {
    return effort === undefined || effort === null
        || (typeof effort === 'string' && (VALID_REASONING_EFFORTS as readonly string[]).includes(effort));
}

/** Map a normalized model id to a tier. `lumo`/`auto`/unknown-ish -> 'auto'. */
export function modelToTier(normalizedModel: string): LumoModelTier {
    switch (normalizedModel) {
        case 'lumo-lite':
            return 'lumo-lite';
        case 'lumo-max':
            return 'lumo-max';
        default:
            return 'auto';
    }
}

/** True if the normalized model is in the allowed list (also normalized). */
export function isModelAllowed(normalizedModel: string, allowedModels: string[]): boolean {
    return allowedModels.some((m) => normalizeModelId(m) === normalizedModel);
}

/**
 * Resolve the inbound reasoning_effort to a thinking-mode boolean.
 * `none` -> false; `low`/`medium`/`high` -> true; absent -> config default.
 */
export function resolveReasoning(
    effort: string | null | undefined,
    defaultHigh: boolean,
): boolean {
    if (effort === undefined || effort === null) {
        return defaultHigh;
    }
    return effort !== 'none';
}
