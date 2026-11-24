/**
 * Login (Captcha) Authentication Entry Point
 *
 * Run interactive login using username/password credentials, via the standalone
 * proton-auth CLI (github.com/Arsylk/proton-auth), which can also solve a CAPTCHA
 * challenge through a local browser page.
 * Used by CLI (tamer auth) for the login-captcha authentication method.
 */

import { authConfig } from '../../app/config.js';
import { resolveProjectPath } from '../../app/paths.js';
import { runSrpAuthentication } from '../srp-login.js';

/**
 * Run login-captcha authentication
 *
 * Runs the proton-auth binary for SRP authentication (with CAPTCHA support) and
 * saves tokens to the encrypted vault. Preserves sync data (userKeys, masterKeys)
 * from existing vault if present.
 */
export async function runLoginCaptchaAuthentication(): Promise<void> {
    const binaryPath = resolveProjectPath(authConfig.loginCaptcha.binaryPath);

    // Reuses the same SRP headers as the `login` method; only the binary and
    // CAPTCHA handling differ.
    const args = [
        '--app-version', authConfig.login.appVersion,
        '--user-agent', authConfig.login.userAgent,
        `--captcha-auto-open=${authConfig.loginCaptcha.captchaAutoOpen}`,
        ...authConfig.loginCaptcha.extraArgs,
    ];

    await runSrpAuthentication('login-captcha', binaryPath, args, 'npm run build:login-captcha');
}
