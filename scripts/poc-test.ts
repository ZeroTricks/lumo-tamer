/**
 * PoC test script for direct Lumo API integration
 *
 * Usage: npm run poc-test "Your question here"
 *        npm run poc-test  (defaults to "What is 2+2?")
 */

import { createApiAdapter, loadAuthTokens, getTokenAgeHours, areTokensExpired } from '../src/proton/api-adapter.js';
import { SimpleLumoClient } from '../src/proton/simple-client.js';
import { protonConfig } from '../src/config.js';
import logger from '../src/logger.js';

async function main(): Promise<void> {
    const query = process.argv[2] || 'What is 2+2?';

    logger.info('=== Lumo API PoC Test ===');

    // Load auth tokens
    logger.info({ tokensPath: protonConfig.tokensPath }, 'Loading auth tokens');
    let tokens;
    try {
        tokens = loadAuthTokens();
    } catch (error) {
        logger.error({ error, tokensPath: protonConfig.tokensPath }, 'Failed to load auth tokens');
        logger.error('Run "npm run extract-token" first to extract tokens from browser.');
        process.exit(1);
    }

    const tokenAge = getTokenAgeHours(tokens);
    logger.info({
        extractedAt: tokens.extractedAt,
        ageHours: tokenAge.toFixed(1),
        cookieCount: tokens.cookies.length,
    }, 'Tokens loaded');

    if (areTokensExpired(tokens)) {
        logger.warn('Some cookies have expired. Re-run extract-token if you get auth errors.');
    }

    // Create API adapter
    logger.info('Creating API adapter...');
    const api = createApiAdapter(tokens);

    // Create Lumo client
    logger.info('Creating Lumo client...');
    const client = new SimpleLumoClient(api);

    // Send query
    logger.info({ query }, 'Sending query');
    process.stdout.write('\n--- Response ---\n');

    const startTime = Date.now();
    let chunkCount = 0;

    try {
        const response = await client.chat(
            query,
            (chunk) => {
                process.stdout.write(chunk);
                chunkCount++;
            },
            {
                enableEncryption: true,
                enableExternalTools: false,
            }
        );

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

        process.stdout.write('\n--- End ---\n\n');
        logger.info({
            responseLength: response.length,
            chunkCount,
            elapsedSeconds: elapsed,
        }, 'Success');
    } catch (error) {
        process.stdout.write('\n--- Error ---\n\n');
        logger.error({ error }, 'Request failed');

        if (error instanceof Error && error.message.includes('401')) {
            logger.error('Hint: Auth tokens may be invalid or expired. Run "npm run extract-token" to refresh.');
        } else if (error instanceof Error && error.message.includes('403')) {
            logger.error('Hint: Access forbidden. Check if account has Lumo access.');
        } else if (error instanceof Error && error.message.includes('404')) {
            logger.error('Hint: API endpoint not found. Check browser DevTools Network tab for the correct endpoint.');
        }

        process.exit(1);
    }
}

main();
