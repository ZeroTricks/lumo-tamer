/**
 * Wrapper for calling the proton-auth Go binary
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { authConfig } from '../../app/config.js';
import type { SRPAuthResult } from './types.js';

/**
 * Run the proton-auth Go binary to perform SRP authentication.
 * The binary prompts interactively for credentials.
 *
 * @param binaryPath - Path to the proton-auth binary
 * @param outputPath - Optional path to write the auth result JSON
 * @returns Promise resolving to the auth result
 */
export async function runProtonAuth(
    binaryPath: string,
    outputPath?: string
): Promise<SRPAuthResult> {
    // Verify binary exists
    if (!existsSync(binaryPath)) {
        throw new Error(
            `proton-auth binary not found at ${binaryPath}. ` +
            `Build it with: cd go-auth && go build -o ../bin/proton-auth`
        );
    }

    return new Promise((resolve, reject) => {
        const args: string[] = [];

        if (outputPath) {
            args.push('-o', outputPath);
        }

        // Pass SRP-specific headers to the Go binary (to avoid CAPTCHA)
        // These are separate from protonConfig.appVersion used for API calls
        args.push('--app-version', authConfig.login.appVersion);
        args.push('--user-agent', authConfig.login.userAgent);

        // Spawn the process with stdio inherited for interactive prompts
        // but capture stdout for JSON output
        const proc = spawn(binaryPath, args, {
            stdio: ['inherit', 'pipe', 'inherit'],
        });

        let stdout = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.on('error', (err) => {
            reject(new Error(`Failed to spawn proton-auth: ${err.message}`));
        });

        proc.on('close', (code) => {
            if (code !== 0 && !stdout.trim()) {
                reject(new Error(`proton-auth exited with code ${code}`));
                return;
            }

            try {
                // If outputPath was specified, stdout might be empty
                // because JSON goes to file. In that case, return success.
                if (outputPath && !stdout.trim()) {
                    // Read from the output file would happen in auth-manager
                    resolve({
                        accessToken: '',
                        refreshToken: '',
                        uid: '',
                        userID: '',
                        keyPassword: '',
                    });
                    return;
                }

                const result = JSON.parse(stdout) as SRPAuthResult;

                if (result.error) {
                    reject(new Error(`Authentication failed: ${result.error}`));
                    return;
                }

                resolve(result);
            } catch (parseErr) {
                reject(new Error(`Failed to parse auth result: ${parseErr}`));
            }
        });
    });
}
