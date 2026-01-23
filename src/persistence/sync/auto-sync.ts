/**
 * Auto-Sync Service for conversation persistence
 *
 * Provides smart automatic synchronization with:
 * - Debouncing: Waits for activity to settle before syncing
 * - Throttling: Ensures minimum interval between syncs
 * - Max delay: Forces sync after maximum time regardless of activity
 *
 * Inspired by Proton WebClient's saga-based sync with dirty flags
 * (see ~/WebClients/applications/lumo/src/app/redux/sagas/conversations.ts)
 */

import { logger } from '../../app/logger.js';
import { getSyncService, type SyncService } from './sync-service.js';

export interface AutoSyncConfig {
    /** Enable auto-sync (default: false) */
    enabled: boolean;
    /** Debounce delay - wait this long after last change before syncing (default: 5000ms, min: 1000ms) */
    debounceMs: number;
    /** Minimum interval between syncs (default: 30000ms, min: 5000ms) */
    minIntervalMs: number;
    /** Maximum time to wait before forcing a sync (default: 60000ms, min: 10000ms) */
    maxDelayMs: number;
}

const DEFAULT_CONFIG: AutoSyncConfig = {
    enabled: false,
    debounceMs: 5000,
    minIntervalMs: 30000,
    maxDelayMs: 60000,
};

/**
 * Auto-Sync Service
 *
 * Manages automatic synchronization of dirty conversations.
 * Uses a smart scheduling approach:
 * 1. When a conversation is marked dirty, schedule a sync
 * 2. Debounce: If more changes come in, push the sync back
 * 3. Throttle: Don't sync more often than minIntervalMs
 * 4. Max delay: Force sync after maxDelayMs regardless of activity
 */
export class AutoSyncService {
    private config: AutoSyncConfig;
    private syncService: SyncService;

    // Scheduling state
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private maxDelayTimer: ReturnType<typeof setTimeout> | null = null;
    private lastSyncTime = 0;
    private pendingSync = false;
    private isSyncing = false;
    private firstDirtyTime = 0;

    // Stats
    private syncCount = 0;
    private lastError: Error | null = null;

    constructor(syncService: SyncService, config: Partial<AutoSyncConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.syncService = syncService;

        if (this.config.enabled) {
            logger.info({
                debounceMs: this.config.debounceMs,
                minIntervalMs: this.config.minIntervalMs,
                maxDelayMs: this.config.maxDelayMs,
            }, 'AutoSyncService initialized');
        }
    }

    /**
     * Notify that a conversation has been marked dirty
     * Call this whenever conversations change
     */
    notifyDirty(): void {
        if (!this.config.enabled) {
            return;
        }

        // Record first dirty time for max delay calculation
        if (this.firstDirtyTime === 0) {
            this.firstDirtyTime = Date.now();
            this.startMaxDelayTimer();
        }

        this.scheduleSync();
    }

    /**
     * Schedule a sync with debouncing
     */
    private scheduleSync(): void {
        // Clear existing debounce timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        // Calculate delay respecting throttle
        const now = Date.now();
        const timeSinceLastSync = now - this.lastSyncTime;
        const throttleDelay = Math.max(0, this.config.minIntervalMs - timeSinceLastSync);
        const delay = Math.max(this.config.debounceMs, throttleDelay);

        logger.debug({
            delay,
            throttleDelay,
            debounceMs: this.config.debounceMs,
            timeSinceLastSync,
        }, 'Scheduling auto-sync');

        this.pendingSync = true;
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.executeSync();
        }, delay);
    }

    /**
     * Start the max delay timer (force sync after maxDelayMs)
     */
    private startMaxDelayTimer(): void {
        if (this.maxDelayTimer) {
            return;
        }

        this.maxDelayTimer = setTimeout(() => {
            this.maxDelayTimer = null;
            if (this.pendingSync && !this.isSyncing) {
                logger.info('Max delay reached, forcing sync');
                this.executeSync();
            }
        }, this.config.maxDelayMs);
    }

    /**
     * Execute the sync operation
     */
    private async executeSync(): Promise<void> {
        if (this.isSyncing) {
            return;
        }

        this.isSyncing = true;
        this.pendingSync = false;

        // Clear max delay timer since we're syncing
        if (this.maxDelayTimer) {
            clearTimeout(this.maxDelayTimer);
            this.maxDelayTimer = null;
        }

        try {
            const startTime = Date.now();
            const syncedCount = await this.syncService.sync();
            const duration = Date.now() - startTime;

            this.lastSyncTime = Date.now();
            this.firstDirtyTime = 0;
            this.syncCount++;
            this.lastError = null;

            if (syncedCount > 0) {
                logger.info({
                    syncedCount,
                    duration,
                    totalSyncs: this.syncCount,
                }, 'Auto-sync completed');
            } else {
                logger.debug('Auto-sync: no dirty conversations');
            }
        } catch (error) {
            this.lastError = error instanceof Error ? error : new Error(String(error));
            logger.error({
                error: this.lastError.message,
            }, 'Auto-sync failed');

            // Reschedule on failure (with backoff via throttle)
            this.scheduleSync();
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Force an immediate sync (bypasses debounce/throttle)
     */
    async syncNow(): Promise<number> {
        // Clear pending timers
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.maxDelayTimer) {
            clearTimeout(this.maxDelayTimer);
            this.maxDelayTimer = null;
        }

        this.pendingSync = false;
        this.firstDirtyTime = 0;

        const syncedCount = await this.syncService.sync();
        this.lastSyncTime = Date.now();
        this.syncCount++;

        return syncedCount;
    }

    /**
     * Stop auto-sync (cleanup timers)
     */
    stop(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.maxDelayTimer) {
            clearTimeout(this.maxDelayTimer);
            this.maxDelayTimer = null;
        }
        this.pendingSync = false;
        logger.info('AutoSyncService stopped');
    }

    /**
     * Get auto-sync statistics
     */
    getStats(): {
        enabled: boolean;
        syncCount: number;
        lastSyncTime: number;
        pendingSync: boolean;
        isSyncing: boolean;
        lastError: string | null;
    } {
        return {
            enabled: this.config.enabled,
            syncCount: this.syncCount,
            lastSyncTime: this.lastSyncTime,
            pendingSync: this.pendingSync,
            isSyncing: this.isSyncing,
            lastError: this.lastError?.message ?? null,
        };
    }
}

// Singleton instance
let autoSyncInstance: AutoSyncService | null = null;

/**
 * Get or create the global AutoSyncService instance
 */
export function getAutoSyncService(
    syncService?: SyncService,
    config?: Partial<AutoSyncConfig>
): AutoSyncService {
    if (!autoSyncInstance) {
        if (!syncService) {
            syncService = getSyncService();
        }
        autoSyncInstance = new AutoSyncService(syncService, config);
    }
    return autoSyncInstance;
}

/**
 * Reset the AutoSyncService (for testing)
 */
export function resetAutoSyncService(): void {
    if (autoSyncInstance) {
        autoSyncInstance.stop();
        autoSyncInstance = null;
    }
}
