/**
 * Login Authentication Entry Point
 *
 * Run interactive login using username/password credentials.
 * Used by CLI (npm run auth) for login authentication method.
 */

import { LoginAuthProvider } from '../providers/login.js';

/**
 * Run login authentication
 *
 * Creates provider and initializes (triggering auth if needed).
 */
export async function runLoginAuthentication(): Promise<void> {
    const provider = new LoginAuthProvider();
    await provider.initialize();
}
