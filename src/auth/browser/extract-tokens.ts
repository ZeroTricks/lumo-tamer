/**
 * CLI script for browser token extraction
 *
 * Usage: npm run extract-tokens
 *
 * This script extracts auth tokens from an existing browser session
 * and saves them to sessions/auth-tokens.json.
 */

// Initialize config mode and logger before other imports
import { initConfig } from '../../app/config.js';
initConfig('cli');

import { initLogger, logger } from '../../app/logger.js';
// Always log to stdout for CLI scripts - users need to see the output
initLogger({ level: 'info', target: 'stdout', filePath: '' });

import { authConfig } from '../../app/config.js';
import { resolveProjectPath } from '../../app/paths.js';
import { extractAndSaveTokens } from './extractor.js';

const outputPath = resolveProjectPath(authConfig.tokenCachePath);

async function main(): Promise<void> {
    try {
        const result = await extractAndSaveTokens(outputPath);

        // Log warnings
        for (const warning of result.warnings) {
            logger.warn(warning);
        }

        // Summary
        if (result.tokens.persistedSession?.blob && result.tokens.persistedSession?.clientKey) {
            logger.info('Extended auth data extracted - conversation persistence enabled');
        } else if (result.tokens.persistedSession?.blob) {
            logger.warn('Conversation persistence may not work without ClientKey');
        } else {
            logger.warn('Conversation persistence will use local-only encryption');
        }

        logger.info('You can now run: npm run dev');
        process.exit(0);
    } catch (error) {
        logger.error({ error }, 'Extraction failed');
        process.exit(1);
    }
}

main();
