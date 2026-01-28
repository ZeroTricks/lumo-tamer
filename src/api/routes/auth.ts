/**
 * Auth API routes
 *
 * Provides authentication-related endpoints:
 * - POST /v1/auth/logout - Revoke session and delete tokens
 * - POST /v1/auth/refresh - Manually trigger token refresh
 * - GET /v1/auth/status - Get current auth status
 */

import { Router, Request, Response } from 'express';
import { EndpointDependencies } from '../types.js';
import { getAutoSyncService } from '../../conversations/index.js';
import { logger } from '../../app/logger.js';

export function createAuthRouter(deps: EndpointDependencies): Router {
  const router = Router();

  /**
   * POST /v1/auth/logout
   *
   * Revokes the current session on Proton's servers and deletes the local token cache.
   *
   * Response:
   * - 200: Logout successful
   * - 500: Logout failed
   */
  router.post('/v1/auth/logout', async (req: Request, res: Response) => {
    try {
      if (!deps.authManager || !deps.vaultPath) {
        res.status(500).json({
          error: {
            message: 'Auth manager not available',
            type: 'server_error',
          },
        });
        return;
      }

      // Stop auto-sync if running
      const autoSync = getAutoSyncService();
      autoSync?.stop();

      // Perform logout (stops refresh timer, revokes session, deletes tokens)
      await deps.authManager.logout();

      logger.info('Logout via API successful');

      // Schedule graceful shutdown after response is fully sent
      res.on('finish', () => {
        logger.info('Shutting down after logout...');
        process.exit(0);
      });

      res.json({
        success: true,
        message: 'Logged out successfully. Session revoked and tokens deleted. Server shutting down...',
      });
    } catch (error) {
      logger.error({ error }, 'Logout API failed');
      res.status(500).json({
        error: {
          message: error instanceof Error ? error.message : 'Logout failed',
          type: 'server_error',
        },
      });
    }
  });

  /**
   * POST /v1/auth/refresh
   *
   * Manually triggers a token refresh.
   *
   * Response:
   * - 200: Refresh successful
   * - 500: Refresh failed
   */
  router.post('/v1/auth/refresh', async (req: Request, res: Response) => {
    try {
      if (!deps.authManager) {
        res.status(500).json({
          error: {
            message: 'Auth manager not available',
            type: 'server_error',
          },
        });
        return;
      }

      await deps.authManager.refreshNow();

      logger.info('Token refresh via API successful');

      res.json({
        success: true,
        message: 'Tokens refreshed successfully.',
      });
    } catch (error) {
      logger.error({ error }, 'Token refresh API failed');
      res.status(500).json({
        error: {
          message: error instanceof Error ? error.message : 'Refresh failed',
          type: 'server_error',
        },
      });
    }
  });

  /**
   * GET /v1/auth/status
   *
   * Returns current authentication status.
   *
   * Response:
   * - 200: Status object
   */
  router.get('/v1/auth/status', (req: Request, res: Response) => {
    if (!deps.authManager) {
      res.status(500).json({
        error: {
          message: 'Auth manager not available',
          type: 'server_error',
        },
      });
      return;
    }

    const provider = deps.authManager.getProvider();
    const status = provider.getStatus();

    res.json({
      method: status.method,
      valid: status.valid,
      source: status.source,
      details: status.details,
      warnings: status.warnings,
    });
  });

  return router;
}
