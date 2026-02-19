/**
 * Update config.yaml with auth settings after successful authentication
 *
 * Uses the 'yaml' package to preserve comments and formatting.
 */

import { z } from 'zod';
import { isMap } from 'yaml';
import { logger } from '../app/logger.js';
import { authMethodSchema } from '../app/config.js';
import { updateConfigYaml } from '../app/config-file.js';

/** Schema for validating config updates */
const authConfigUpdatesSchema = z.object({
  method: authMethodSchema.optional(),
  cdpEndpoint: z.string().optional(),
});

export type AuthConfigUpdates = z.infer<typeof authConfigUpdatesSchema>;

/**
 * Update auth-related values in config.yaml
 *
 * Preserves existing comments and formatting.
 * Creates file if it doesn't exist.
 */
export function updateAuthConfig(updates: AuthConfigUpdates): void {
  const validated = authConfigUpdatesSchema.parse(updates);

  if (!validated.method && !validated.cdpEndpoint) {
    return;
  }

  updateConfigYaml((doc) => {
    // Ensure auth section exists
    if (!isMap(doc.contents)) {
      doc.contents = doc.createNode({});
    }
    if (!doc.getIn(['auth'])) {
      doc.setIn(['auth'], {});
    }

    if (validated.method) {
      doc.setIn(['auth', 'method'], validated.method);
    }
    if (validated.cdpEndpoint) {
      // Ensure auth.browser section exists
      if (!doc.getIn(['auth', 'browser'])) {
        doc.setIn(['auth', 'browser'], {});
      }
      doc.setIn(['auth', 'browser', 'cdpEndpoint'], validated.cdpEndpoint);
    }
  });

  logger.debug({ updates }, 'Updated config.yaml');
}
