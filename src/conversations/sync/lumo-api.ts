/**
 * LumoApi Adapter
 *
 * Wraps upstream LumoApi with lumo-tamer's authenticated Api.
 *
 * Usage:
 *   const lumoApi = createLumoApi(authenticatedApi, uid);
 *   await lumoApi.listSpaces();
 */

import { LumoApi } from '../../proton-upstream/remote/api.js';
import { installFetchAdapter } from '../../proton-shims/fetch-adapter.js';
import type { ProtonApi } from '../../lumo-client/types.js';
import { logger } from '../../app/logger.js';

// Track if fetch adapter is installed
let fetchAdapterInstalled = false;
let cleanupFetchAdapter: (() => void) | null = null;

/**
 * Creates a LumoApi instance that uses lumo-tamer's authenticated Api.
 *
 * This function:
 * 1. Installs a global fetch adapter that routes to our Api
 * 2. Creates a LumoApi instance with the given UID
 *
 * Note: The fetch adapter remains installed for the lifetime of the process.
 * This is acceptable since lumo-tamer is a server-side application.
 *
 * @param api - The authenticated Api function from lumo-tamer
 * @param uid - The user ID for x-pm-uid header (used by upstream but handled by our Api)
 * @returns A configured LumoApi instance
 */
export function createLumoApi(protonApi: ProtonApi, uid: string): LumoApi {
    // Install fetch adapter if not already installed
    if (!fetchAdapterInstalled) {
        logger.debug('Installing fetch adapter for LumoApi');
        cleanupFetchAdapter = installFetchAdapter(protonApi);
        fetchAdapterInstalled = true;
    }

    // Create LumoApi instance
    // Note: uid is used by LumoApi for headers, but our fetch adapter ignores them
    // since authentication is handled by the Api wrapper
    const lumoApi = new LumoApi(uid);

    return lumoApi;
}

/**
 * Cleanup function to restore original fetch.
 * Call this during shutdown if needed.
 */
export function cleanupLumoApi(): void {
    if (cleanupFetchAdapter) {
        cleanupFetchAdapter();
        cleanupFetchAdapter = null;
        fetchAdapterInstalled = false;
        logger.debug('Cleaned up fetch adapter');
    }
}

// Re-export useful types and values from upstream
export { LumoApi } from '../../proton-upstream/remote/api.js';
export type { Priority } from '../../proton-upstream/remote/scheduler.js';
export {
    RoleInt,
    StatusInt,
} from '../../proton-upstream/remote/types.js';
export type {
    ListSpacesRemote,
    GetSpaceRemote,
    GetConversationRemote,
    RemoteMessage,
    RemoteSpace,
    RemoteConversation,
    RemoteDeletedSpace,
    RemoteDeletedConversation,
    NewSpaceToApi,
    NewConversationToApi,
    NewMessageToApi,
    SpaceToApi,
    ConversationToApi,
    MessageToApi,
} from '../../proton-upstream/remote/types.js';
