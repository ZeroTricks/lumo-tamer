/**
 * Types for rclone protondrive config extraction
 */

/**
 * Raw fields from rclone protondrive config section
 */
export interface RcloneProtonConfig {
    type: string;
    username?: string;
    password?: string;  // obscured by rclone
    client_uid: string;
    client_access_token: string;
    client_refresh_token: string;
    client_salted_key_pass: string;  // base64-encoded keyPassword
}

/**
 * Required fields for authentication
 */
export const REQUIRED_RCLONE_FIELDS = [
    'client_uid',
    'client_access_token',
    'client_refresh_token',
    'client_salted_key_pass',
] as const;
