/**
 * Shim for @proton/shared/lib/apps/helper
 *
 * Replaces: packages/shared/lib/apps/helper.ts
 *
 * Function mapping:
 * - getClientID(): lines 12-21 → original lines 85-105
 *
 * Key difference: Original uses APPS_CONFIGURATION lookup + platform detection.
 * Shim uses hardcoded client IDs for known apps.
 */

/**
 * Get the client ID for a given app name.
 * Used for x-pm-appversion header.
 */
export function getClientID(appName: string): string {
    const clientIds: Record<string, string> = {
        'proton-lumo': 'web-lumo',
        'proton-mail': 'web-mail',
        'proton-calendar': 'web-calendar',
        'proton-drive': 'web-drive',
        'proton-vpn-settings': 'web-vpn-settings',
    };
    return clientIds[appName] || 'web-lumo';
}
