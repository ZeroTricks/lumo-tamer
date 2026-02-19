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
    // Ensure root is a map
    if (!isMap(doc.contents)) {
      doc.contents = doc.createNode({});
    }

    // Ensure auth section is a map (not a scalar like "auth: browser")
    const authNode = doc.getIn(['auth'], true);
    if (!authNode || !isMap(authNode)) {
      doc.setIn(['auth'], doc.createNode({}));
    }

    if (validated.method) {
      doc.setIn(['auth', 'method'], validated.method);
    }
    if (validated.cdpEndpoint) {
      // Ensure auth.browser section is a map
      const browserNode = doc.getIn(['auth', 'browser'], true);
      if (!browserNode || !isMap(browserNode)) {
        doc.setIn(['auth', 'browser'], doc.createNode({}));
      }
      doc.setIn(['auth', 'browser', 'cdpEndpoint'], validated.cdpEndpoint);
    }
  });

  logger.debug({ updates }, 'Updated config.yaml');
}
