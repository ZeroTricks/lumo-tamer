import { z } from 'zod';
import merge from 'lodash/merge.js';
import bytes from 'bytes';
import { fatalExit, loadConfigYaml, loadDefaultsYaml } from './config-file.js';

// Load defaults from YAML (single source of truth)
const configDefaults = loadDefaultsYaml();

// Config loading
export type ConfigMode = 'server' | 'cli';

// Shared keys that can be overridden per mode
const SHARED_KEYS = ['log', 'conversations', 'commands'] as const;

// ============================================
// Schemas (validation only, no defaults)
// ============================================

const logConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  target: z.enum(['stdout', 'file']),
  filePath: z.string(),
  messageContent: z.boolean(),
});


const conversationsConfigSchema = z.object({
  deriveIdFromUser: z.boolean(),
  databasePath: z.string(),
  enableSync: z.boolean(),
  projectName: z.string().min(1),
});

// Replace pattern entry schema
const replacePatternSchema = z.object({
  pattern: z.string(),
  replacement: z.string().optional(),
});

// Server tools config (native, custom prefix, server, client)
const serverToolsConfigSchema = z.object({
  native: z.object({ enabled: z.boolean() }),
  prefix: z.string(),
  server: z.object({ enabled: z.boolean() }),
  client: z.object({ enabled: z.boolean() }),
});

// Metrics config
const metricsConfigSchema = z.object({
  enabled: z.boolean(),
  collectDefaultMetrics: z.boolean(),
  prefix: z.string(),
});

// Validates size strings using the bytes library (same parser Express uses)
const byteSizeSchema = z.union([
  z.string().refine((val) => bytes.parse(val) !== null, 'Invalid size format (e.g., "360kb", "1mb")'),
  z.number().positive(),
]);

// Injection location enum
const injectIntoSchema = z.enum(['first', 'last']);

// Instructions schemas
const cliInstructionsConfigSchema = z.object({
  injectInto: injectIntoSchema,
  template: z.string(),
  forLocalTools: z.string(),
  forToolBounce: z.string(),
});
const serverInstructionsConfigSchema = z.object({
  injectInto: injectIntoSchema,
  template: z.string(),
  forTools: z.string(),
  fallback: z.string(),
  forToolBounce: z.string(),
  replacePatterns: z.array(replacePatternSchema),
});

// CLI local tools config
const localToolsConfigSchema = z.object({
  enabled: z.boolean(),
  fileReads: z.object({
    enabled: z.boolean(),
    maxFileSize: byteSizeSchema,
  }),
  executors: z.record(z.string(), z.array(z.string())),
});

// CLI tools config (native, local)
const cliToolsConfigSchema = z.object({
  native: z.object({ enabled: z.boolean() }),
  local: localToolsConfigSchema,
});

export const authMethodSchema = z.enum(['login', 'browser', 'rclone']);

const authConfigSchema = z.object({
  method: authMethodSchema,
  vault: z.object({
    path: z.string(),
    keychain: z.object({
      service: z.string(),
      account: z.string(),
    }),
    keyFilePath: z.string(),
  }),
  autoRefresh: z.object({
    enabled: z.boolean(),
    intervalHours: z.number().min(1).max(24),
    onError: z.boolean(),
  }),
  browser: z.object({
    cdpEndpoint: z.string(),
  }),
  login: z.object({
    binaryPath: z.string(),
    appVersion: z.string(),
    userAgent: z.string(),
  }),
});

// Server merged config schema
const serverMergedConfigSchema = z.object({
  auth: authConfigSchema,
  log: logConfigSchema,
  conversations: conversationsConfigSchema,
  commands: z.object({ enabled: z.boolean(), wakeword: z.string() }),
  tools: serverToolsConfigSchema,
  instructions: serverInstructionsConfigSchema,
  metrics: metricsConfigSchema,
  bodyLimit: byteSizeSchema,
  port: z.number().int().positive(),
  apiKey: z.string().min(1, 'server.apiKey is required'),
  apiModelName: z.string().min(1),
});

// CLI merged config schema
const cliMergedConfigSchema = z.object({
  auth: authConfigSchema,
  log: logConfigSchema,
  conversations: conversationsConfigSchema,
  commands: z.object({ enabled: z.boolean(), wakeword: z.string() }),
  tools: cliToolsConfigSchema,
  instructions: cliInstructionsConfigSchema,
});

type ServerMergedConfig = z.infer<typeof serverMergedConfigSchema>;
type CliMergedConfig = z.infer<typeof cliMergedConfigSchema>;
type MergedConfig = ServerMergedConfig | CliMergedConfig;

// ============================================
// Config Loading
// ============================================

// Cache user config (loaded once)
let userConfigCache: Record<string, unknown> | null = null;
function loadUserYaml(): Record<string, unknown> {
  if (userConfigCache !== null) return userConfigCache;

  userConfigCache = loadConfigYaml();
  if (Object.keys(userConfigCache).length === 0) {
    console.log('No config.yaml found, using defaults from config.defaults.yaml');
  }
  return userConfigCache;
}

function loadMergedConfig(mode: ConfigMode): MergedConfig {
  try {
    const userConfig = loadUserYaml();
    const defaultModeConfig = (mode === 'server' ? configDefaults.server : configDefaults.cli) as Record<string, unknown>;
    const userModeConfig = (mode === 'server' ? userConfig.server : userConfig.cli) as Record<string, unknown> | undefined;

    // Stage 1: defaults -> user (for all keys including mode-specific)
    const merged = merge({}, configDefaults, defaultModeConfig, userConfig, userModeConfig);

    // Stage 2: apply user mode overrides for shared keys only
    for (const key of SHARED_KEYS) {
      if (userModeConfig?.[key]) {
        merged[key] = merge({}, merged[key], userModeConfig[key]);
      }
    }

    // Remove server/cli sections from final config
    delete merged.server;
    delete merged.cli;

    return (mode === 'server' ? serverMergedConfigSchema : cliMergedConfigSchema).parse(merged);
  } catch (error) {
    catchZodErrors(error);
    throw error;
  }
}

// ============================================
// State
// ============================================

let config: MergedConfig | null = null;
let configMode: ConfigMode | null = null;

function catchZodErrors(error: unknown, path="") {
  if (error instanceof z.ZodError) {
    const errors = error.issues.map((e) => `  - ${path ? (path + '.') : ""}${e.path.join('.')}: ${e.message}`).join('\n');
    fatalExit(`Configuration validation for config.yaml failed:\n${errors}`);
  }
}

export function initConfig(mode: ConfigMode): void {
  configMode = mode;
  config = loadMergedConfig(mode);
  // Note: replacePatterns regex validation happens in src/api/instructions/
  // at module load time, when logger is available
}

export function getConfigMode(): ConfigMode | null {
  return configMode;
}

function getConfig(): MergedConfig {
  if (!config) throw new Error('Config not initialized. Call initConfig() first.');
  return config;
}

// ============================================
// Getters
// ============================================

export const getLogConfig = () => getConfig().log;
export const getConversationsConfig = () => getConfig().conversations;
export const getCommandsConfig = () => getConfig().commands;
export const getNativeToolsEnabled = () => getConfig().tools.native.enabled;

// Server-specific getters
export function getServerConfig(): ServerMergedConfig {
  if (configMode !== 'server' || !config) throw new Error('Server configuration required. Run in server mode.');
  return config as ServerMergedConfig;
}

export function getCustomToolPrefix() {
  const cfg = getServerConfig();
  return cfg.tools.prefix;
}

export function getServerInstructionsConfig() {
  const cfg = getServerConfig();
  return cfg.instructions;
}

export function getMetricsConfig() {
  const cfg = getServerConfig();
  return cfg.metrics;
}

// CLI-specific getters
export function getCliConfig(): CliMergedConfig {
  if (configMode !== 'cli' || !config) throw new Error('CLI configuration required. Run in CLI mode.');
  return config as CliMergedConfig;
}

export function getLocalToolsConfig() {
  const cfg = getCliConfig();
  return cfg.tools.local;
}

export function getCliInstructionsConfig() {
  const cfg = getCliConfig();
  return cfg.instructions;
}

// Generic instructions getter (works for both modes)
export function getInstructionsConfig() {
  return getConfig().instructions;
}

// ============================================
// Legacy/Eager Configs
// ============================================

// Legacy export (for scripts before initConfig, e.g. auth)
export const authConfig = ((): z.infer<typeof authConfigSchema> => {
  try {
    const userConfig = loadUserYaml();
    const merged = merge({}, configDefaults.auth, userConfig.auth);
    return authConfigSchema.parse(merged);
  } catch (error) {
    catchZodErrors(error, "auth");
    throw error;
  }
})();

// Mock config (eagerly loaded, needed before initConfig to decide auth vs mock)
const mockConfigSchema = z.object({
  enabled: z.boolean(),
  scenario: z.enum(['success', 'error', 'timeout', 'rejected', 'toolCall', 'misroutedToolCall', 'serverToolCall', 'weeklyLimit', 'cycle']),
});

export const mockConfig = ((): z.infer<typeof mockConfigSchema> => {
  const userConfig = loadUserYaml();
  const defaults = (configDefaults as any).test?.mock ?? {};
  const user = (userConfig as any).test?.mock ?? {};
  const merged = merge({}, defaults, user);
  return mockConfigSchema.parse(merged);
})();

// ============================================
// Types (only export those used externally)
// ============================================

export type MockConfig = z.infer<typeof mockConfigSchema>;
export type LogConfig = z.infer<typeof logConfigSchema>;
export type ConversationsConfig = z.infer<typeof conversationsConfigSchema>;

