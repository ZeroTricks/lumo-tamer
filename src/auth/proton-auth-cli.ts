/**
 * Wrapper for calling a proton-auth Go binary (shared by login and login-captcha)
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import type { SRPAuthResult } from './types.js';

/**
 * Run a proton-auth Go binary to perform SRP authentication.
 * The binary prompts interactively for credentials.
 *
 * @param binaryPath - Path to the proton-auth binary
 * @param extraArgs - Extra CLI flags to pass to the binary (method-specific)
 * @param outputPath - Optional path to write the auth result JSON
 * @returns Promise resolving to the auth result
 */
export async function runProtonAuth(
    binaryPath: string,
    extraArgs: string[] = [],
    outputPath?: string,
    buildHint?: string
): Promise<SRPAuthResult> {
    // On Windows, Go builds produce proton-auth.exe; try that if the configured path doesn't exist.
    if (process.platform === 'win32' && !existsSync(binaryPath) && !binaryPath.endsWith('.exe')) {
        binaryPath += '.exe';
    }

    // Verify binary exists
    if (!existsSync(binaryPath)) {
        throw new Error(
            `proton-auth binary not found at ${binaryPath}.` +
            (buildHint ? ` Build it with: ${buildHint}` : '')
        );
    }

    return new Promise((resolve, reject) => {
        const args: string[] = [];

        if (outputPath) {
            args.push('-o', outputPath);
        }

        args.push(...extraArgs);

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
                    reject(new Error(result.error));
                    return;
                }

                resolve(result);
            } catch (parseErr) {
                reject(new Error(`Failed to parse auth result: ${parseErr}`));
            }
        });
    });
}
