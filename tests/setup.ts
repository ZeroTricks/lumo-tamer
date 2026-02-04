/**
 * Vitest global setup - runs before all test files.
 *
 * Initializes config and logger so modules that depend on them
 * (most of src/) can be imported without errors.
 */

import { initConfig } from '../src/app/config.js';
import { initLogger } from '../src/app/logger.js';

// Load config.defaults.yaml (server mode gives us all config sections)
initConfig('server');

// Silent logger - only fatal errors show up in test output
initLogger(
  { level: 'fatal', target: 'stdout', filePath: '', messageContent: false },
  { consoleShim: false },
);
