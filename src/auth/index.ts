/**
 * Auth module exports
 */

export { AuthManager } from './manager.js';
export { runProtonAuth } from './go-proton-api/proton-auth-cli.js';
export { parseRcloneConfig } from './rclone/index.js';
export type { AuthConfig, SRPAuthResult, SRPAuthTokens } from './go-proton-api/types.js';
export type { RcloneProtonConfig } from './rclone/index.js';
