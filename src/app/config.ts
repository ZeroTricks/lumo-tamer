import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { z } from 'zod';
import merge from 'lodash/merge.js';
import { resolveProjectPath } from './paths.js';

// ============================================================================
// Zod Schemas
// ============================================================================

const logConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  target: z.enum(['stdout', 'file']).default('stdout'),
  filePath: z.string().default('logs/lumo-bridge.log'),
}).optional();

const protonConfigSchema = z.object({
  baseUrl: z.string().min(1, 'proton.baseUrl is required'),
  appVersion: z.string().min(1, 'proton.appVersion is required'),
  userAgent: z.string().optional(),
});

const instructionsConfigSchema = z.object({
  default: z.string().optional(),
  append: z.boolean().optional().default(false),
  forTools: z.string().optional(),
}).optional();

const toolsConfigSchema = z.object({
  enableWebSearch: z.boolean().optional().default(false),
}).optional();

const browserConfigSchema = z.object({
  url: z.string().optional(),
  cdpEndpoint: z.string().optional(),
  showSources: z.boolean().optional(),
  privateByDefault: z.boolean().optional(),
}).optional();

const autoSyncConfigSchema = z.object({
  enabled: z.boolean().default(false),
  debounceMs: z.number().min(1000).default(5000),
  minIntervalMs: z.number().min(5000).default(30000),
  maxDelayMs: z.number().min(10000).default(60000),
}).optional();

const persistenceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  syncInterval: z.number().default(30000),
  maxConversationsInMemory: z.number().default(100),
  defaultSpaceName: z.string().default('lumo-bridge'),
  spaceId: z.string().uuid().optional(),
  saveSystemMessages: z.boolean().default(false),
  deriveIdFromFirstMessage: z.boolean().default(false),
  autoSync: autoSyncConfigSchema,
}).optional();

const authAutoRefreshConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalHours: z.number().min(1).max(24).default(20),
  onError: z.boolean().default(true),
}).optional();

const authConfigSchema = z.object({
  method: z.enum(['srp', 'browser', 'rclone']).default('browser'),
  binaryPath: z.string().default('./bin/proton-auth'),
  tokenCachePath: z.string().default('sessions/auth-tokens.json'),
  rclonePath: z.string().optional(),
  rcloneRemote: z.string().optional(),
  autoRefresh: authAutoRefreshConfigSchema,
});

// Mode-overridable config keys
const modeOverridesSchema = z.object({
  log: logConfigSchema,
  persistence: persistenceConfigSchema,
  instructions: instructionsConfigSchema,
  tools: toolsConfigSchema,
});

const serverConfigSchema = modeOverridesSchema.extend({
  port: z.number().int().positive(),
  apiKey: z.string().min(1, 'server.apiKey is required'),
  apiModelName: z.string().min(1, 'server.apiModelName is required'),
}).optional();

const cliConfigSchema = modeOverridesSchema.optional();

const configSchema = modeOverridesSchema.extend({
  server: serverConfigSchema,
  cli: cliConfigSchema,
  proton: protonConfigSchema,
  browser: browserConfigSchema,
  auth: authConfigSchema,
});

type RawConfig = z.infer<typeof configSchema>;
type ModeOverrides = z.infer<typeof modeOverridesSchema>;

// ============================================================================
// Load config
// ============================================================================

function loadConfig(): RawConfig {
  try {
    const configPath = resolveProjectPath('config.yaml');
    const fileContents = readFileSync(configPath, 'utf8');
    return configSchema.parse(load(fileContents));
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Configuration validation failed:');
      error.issues.forEach((e) => console.error(`  - ${e.path.join('.')}: ${e.message}`));
      throw new Error('Invalid configuration. Please check config.yaml');
    }
    throw error;
  }
}

const config = loadConfig();

// ============================================================================
// Mode-specific resolution
// ============================================================================

export type ConfigMode = 'server' | 'cli';

const MODE_KEYS: (keyof ModeOverrides)[] = ['log', 'persistence', 'instructions', 'tools'];

let resolved: (ModeOverrides & { mode: ConfigMode }) | null = null;

export function initConfig(mode: ConfigMode): void {
  const modeConfig = mode === 'server' ? config.server : config.cli;
  resolved = { mode } as ModeOverrides & { mode: ConfigMode };

  for (const key of MODE_KEYS) {
    (resolved as Record<string, unknown>)[key] = merge({}, config[key], modeConfig?.[key]);
  }
}

export function getConfigMode(): ConfigMode | null {
  return resolved?.mode ?? null;
}

// ============================================================================
// Getters (return mode-specific or fallback to shared)
// ============================================================================

export const getLogConfig = () => resolved?.log ?? config.log;
export const getPersistenceConfig = () => resolved?.persistence ?? config.persistence;
export const getInstructionsConfig = () => resolved?.instructions ?? config.instructions;
export const getToolsConfig = () => resolved?.tools ?? config.tools;

export function getServerConfig() {
  if (!config.server) {
    throw new Error('Server configuration required. Add server section to config.yaml');
  }
  return config.server;
}

// ============================================================================
// Shared config (not mode-specific)
// ============================================================================

export const protonConfig = config.proton;
export const browserConfig = config.browser;
export const authConfig = config.auth;

// ============================================================================
// Export types
// ============================================================================

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type ProtonConfig = z.infer<typeof protonConfigSchema>;
export type ToolsConfig = z.infer<typeof toolsConfigSchema>;
export type BrowserConfig = z.infer<typeof browserConfigSchema>;
export type InstructionsConfig = z.infer<typeof instructionsConfigSchema>;
export type PersistenceConfig = z.infer<typeof persistenceConfigSchema>;
export type AutoSyncConfig = z.infer<typeof autoSyncConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type AuthAutoRefreshConfig = z.infer<typeof authAutoRefreshConfigSchema>;
export type CliConfig = z.infer<typeof cliConfigSchema>;
export type LogConfig = z.infer<typeof logConfigSchema>;
