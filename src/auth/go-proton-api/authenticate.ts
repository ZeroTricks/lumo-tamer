/**
 * SRP Authentication Entry Point
 *
 * Run interactive SRP authentication using the go-proton-api binary.
 * Used by CLI (npm run auth) for SRP authentication method.
 */

import { SRPAuthProvider } from '../providers/srp.js';

/**
 * Run SRP authentication
 *
 * Creates provider and initializes (triggering auth if needed).
 */
export async function runSrpAuthentication(): Promise<void> {
    const provider = new SRPAuthProvider();
    await provider.initialize();
}
