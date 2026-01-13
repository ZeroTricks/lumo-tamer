/**
 * Lumo CLI - Interactive command-line interface for Lumo
 *
 * Usage: npm run lumo "Your question"   # Single query
 *        npm run lumo                    # Interactive mode
 */

import * as readline from 'readline';
import {
    createApiAdapter,
    loadAuthTokens,
    getTokenAgeHours,
    areTokensExpired,
    SimpleLumoClient,
    type Turn,
} from './lumo-client/index.js';
import { protonConfig } from './config.js';
import logger from './logger.js';

const BUSY_INDICATOR = '...';

function clearBusyIndicator(): void {
    // Backspace over "..."
    process.stdout.write('\b\b\b   \b\b\b');
}

function initClient(): SimpleLumoClient {
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

    const api = createApiAdapter(tokens);
    return new SimpleLumoClient(api);
}

async function singleQuery(client: SimpleLumoClient, query: string): Promise<void> {
    logger.info({ query }, 'Sending query');
    process.stdout.write('\n');

    const startTime = Date.now();
    let chunkCount = 0;
    process.stdout.write(BUSY_INDICATOR);

    try {
        const response = await client.chat(
            query,
            (chunk) => {
                if (chunkCount === 0) clearBusyIndicator();
                process.stdout.write(chunk);
                chunkCount++;
            },
            { enableEncryption: true, enableExternalTools: false }
        );

        if (chunkCount === 0) clearBusyIndicator();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        process.stdout.write('\n\n');
        logger.info({ responseLength: response.length, chunkCount, elapsedSeconds: elapsed }, 'Done');
    } catch (error) {
        clearBusyIndicator();
        process.stdout.write('\n');
        logger.error({ error }, 'Request failed');
        handleError(error);
        process.exit(1);
    }
}

async function interactiveMode(client: SimpleLumoClient): Promise<void> {
    const history: Turn[] = [];

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const prompt = (): Promise<string | null> => {
        return new Promise((resolve) => {
            rl.question('You: ', (answer) => {
                resolve(answer);
            });
            rl.once('close', () => resolve(null));
        });
    };

    logger.info('Interactive mode. Type /quit to exit.');
    process.stdout.write('\n');

    while (true) {
        const input = await prompt();

        if (input === null || input === '/quit') {
            break;
        }

        if (!input.trim()) {
            continue;
        }

        history.push({ role: 'user', content: input });

        process.stdout.write('Lumo: ' + BUSY_INDICATOR);
        let chunkCount = 0;
        try {
            const response = await client.chatWithHistory(
                history,
                (chunk) => {
                    if (chunkCount === 0) clearBusyIndicator();
                    process.stdout.write(chunk);
                    chunkCount++;
                },
                { enableEncryption: true, enableExternalTools: false }
            );
            if (chunkCount === 0) clearBusyIndicator();
            process.stdout.write('\n\n');
            history.push({ role: 'assistant', content: response });
        } catch (error) {
            clearBusyIndicator();
            process.stdout.write('\n');
            logger.error({ error }, 'Request failed');
            handleError(error);
            // Remove failed user message from history
            history.pop();
        }
    }

    rl.close();
    logger.info('Goodbye!');
}

function handleError(error: unknown): void {
    if (error instanceof Error) {
        if (error.message.includes('401')) {
            logger.error('Hint: Auth tokens may be invalid or expired. Run "npm run extract-token" to refresh.');
        } else if (error.message.includes('403')) {
            logger.error('Hint: Access forbidden. Check if account has Lumo access.');
        } else if (error.message.includes('404')) {
            logger.error('Hint: API endpoint not found.');
        }
    }
}

async function main(): Promise<void> {
    const client = initClient();

    // Check if query provided as argument
    const query = process.argv[2];
    if (query && !query.startsWith('-')) {
        await singleQuery(client, process.argv.slice(2).join(' '));
    } else {
        await interactiveMode(client);
    }
}

main();
