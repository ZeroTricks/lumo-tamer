import { describe, it, expect } from 'vitest';
import { normalizeModelId, modelToTier, isModelAllowed, resolveReasoning, isValidReasoningEffort } from '../../src/lumo-client/model-tier.js';

describe('normalizeModelId', () => {
    it('lowercases, trims, and strips a provider prefix', () => {
        expect(normalizeModelId('  Lumo-Max ')).toBe('lumo-max');
        expect(normalizeModelId('proton/lumo-max')).toBe('lumo-max');
        expect(normalizeModelId(undefined)).toBe('');
    });
    it('returns empty string for non-string input (no throw)', () => {
        expect(normalizeModelId(42 as unknown)).toBe('');
        expect(normalizeModelId({} as unknown)).toBe('');
        expect(normalizeModelId(null)).toBe('');
    });
});

describe('isValidReasoningEffort', () => {
    it('accepts valid values and absent/null', () => {
        for (const e of ['none', 'low', 'medium', 'high', undefined, null]) {
            expect(isValidReasoningEffort(e)).toBe(true);
        }
    });
    it('rejects invalid values (including wrong case and non-strings)', () => {
        for (const e of ['NONE', 'HIGH', 'typo', '', 5, {}]) {
            expect(isValidReasoningEffort(e)).toBe(false);
        }
    });
});

describe('modelToTier', () => {
    it('maps model ids to tiers', () => {
        expect(modelToTier('lumo')).toBe('auto');
        expect(modelToTier('lumo-lite')).toBe('lumo-lite');
        expect(modelToTier('lumo-max')).toBe('lumo-max');
        expect(modelToTier('something-else')).toBe('auto');
    });
});

describe('isModelAllowed', () => {
    const allowed = ['lumo', 'lumo-lite', 'lumo-max'];
    it('accepts allowed models (normalized) and rejects others', () => {
        expect(isModelAllowed('lumo-max', allowed)).toBe(true);
        expect(isModelAllowed(normalizeModelId('proton/lumo'), allowed)).toBe(true);
        expect(isModelAllowed('gpt-4', allowed)).toBe(false);
    });
});

describe('resolveReasoning', () => {
    it('maps reasoning_effort to a thinking-mode boolean', () => {
        expect(resolveReasoning('none', false)).toBe(false);
        expect(resolveReasoning('low', false)).toBe(true);
        expect(resolveReasoning('medium', false)).toBe(true);
        expect(resolveReasoning('high', false)).toBe(true);
    });
    it('falls back to the config default when absent', () => {
        expect(resolveReasoning(undefined, false)).toBe(false);
        expect(resolveReasoning(undefined, true)).toBe(true);
        expect(resolveReasoning(null, true)).toBe(true);
    });
});
