/**
 * Shim for @proton/shared/lib/fetch/headers
 *
 * Replaces: packages/shared/lib/fetch/headers.ts
 *
 * Function mapping:
 * - getAppVersionHeaders(): lines 12-19 → original lines 30-32
 *
 * Key difference: Original calls getAppVersionStr() which adds '-dev' suffix
 * in non-production. Shim takes parameters directly without env detection.
 *
 * Not shimmed (not used by lumo-tamer):
 * - mergeHeaders(), getAppVersionStr(), getAppVersionHeader()
 * - getUIDHeaders(), getAuthHeaders(), and others (lines 13-92)
 */

/**
 * Get app version headers for Proton API requests.
 * Returns headers that identify the client application and version.
 */
export function getAppVersionHeaders(
    clientID: string,
    appVersion: string
): Record<string, string> {
    return {
        'x-pm-appversion': `${clientID}@${appVersion}`,
    };
}
