/**
 * Login Authentication Entry Point
 *
 * Run interactive login using username/password credentials.
 * Used by CLI (tamer auth) for login authentication method.
 */

import { authConfig } from '../../app/config.js';
import { resolveProjectPath } from '../../app/paths.js';
import { runSrpAuthentication } from '../srp-login.js';

/**
 * Run login authentication
 *
 * Runs the Go binary for SRP authentication and saves tokens to encrypted vault.
 * Preserves sync data (userKeys, masterKeys) from existing vault if present.
 */
export async function runLoginAuthentication(): Promise<void> {
    const binaryPath = resolveProjectPath(authConfig.login.binaryPath);

    // Pass SRP-specific headers to the Go binary (to avoid CAPTCHA)
    // These are separate from APP_VERSION_HEADER used for API calls
    const args = ['--app-version', authConfig.login.appVersion, '--user-agent', authConfig.login.userAgent];

    await runSrpAuthentication('login', binaryPath, args, 'npm run build:login');
}
