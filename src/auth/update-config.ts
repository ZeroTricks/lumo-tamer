/**
 * Update config.yaml with auth settings after successful authentication
 */

import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolveProjectPath } from '../app/paths.js';
import { logger } from '../app/logger.js';
import { authMethodSchema } from '../app/config.js';

/** Schema for validating config updates */
const authConfigUpdatesSchema = z.object({
    method: authMethodSchema.optional(),
    cdpEndpoint: z.string().optional(),
});

export type AuthConfigUpdates = z.infer<typeof authConfigUpdatesSchema>;

/**
 * Update auth-related values in config.yaml
 *
 * Uses simple string replacement to preserve formatting and comments.
 * Validates inputs using Zod before writing.
 */
export function updateAuthConfig(updates: AuthConfigUpdates): void {
    // Validate inputs
    const validated = authConfigUpdatesSchema.parse(updates);

    if (!validated.method && !validated.cdpEndpoint) {
        return;
    }

    const configPath = resolveProjectPath('config.yaml');

    if (!existsSync(configPath)) {
        const stub = [
            'auth:',
            `  method: "${validated.method ?? 'browser'}"`,
            '  browser:',
            `    cdpEndpoint: "${validated.cdpEndpoint}"`,
            '',
        ].join('\n');
        writeFileSync(configPath, stub);
        logger.debug({ updates }, 'Created config.yaml with auth stub');
        return;
    }

    let content = readFileSync(configPath, 'utf8');
    let changed = false;

    if (validated.method) {
        const newContent = content.replace(
            /^(\s*method:\s*)"?(\w+)"?/m,
            `$1"${validated.method}"`
        );
        if (newContent !== content) {
            content = newContent;
            changed = true;
        }
    }

    if (validated.cdpEndpoint) {
        const newContent = content.replace(
            /^(\s*cdpEndpoint:\s*)"?([^"\n]+)"?/m,
            `$1"${validated.cdpEndpoint}"`
        );
        if (newContent !== content) {
            content = newContent;
            changed = true;
        }
    }

    if (changed) {
        writeFileSync(configPath, content);
        logger.debug({ updates }, 'Updated config.yaml');
    }
}
