/**
 * Types for go-proton-api authentication
 */

// Output from the Go binary
export interface SRPAuthResult {
    accessToken: string;
    refreshToken: string;
    uid: string;
    userID: string;
    keyPassword: string;
    expiresAt?: string;
    error?: string;
    errorCode?: number;
}

// Configuration for SRP authentication
export interface AuthConfig {
    method: 'srp' | 'browser';
    binaryPath: string;
    vaultPath: string;
}

// Extended auth tokens that include keyPassword
export interface SRPAuthTokens {
    accessToken: string;
    refreshToken: string;
    uid: string;
    userID: string;
    keyPassword: string;
    expiresAt: string;
    extractedAt: string;
}
