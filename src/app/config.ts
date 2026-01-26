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
  appVersion: z.string().min(1, 'proton.appVersion is required'),
});

const instructionsConfigSchema = z.object({
  default: z.string().optional(),
  append: z.boolean().optional().default(false),
  forTools: z.string().optional(),
}).optional();

const toolsConfigSchema = z.object({
  enableWebSearch: z.boolean().optional().default(false),
}).optional();

const syncConfigSchema = z.object({
  enabled: z.boolean().default(false),
  spaceId: z.string().uuid().optional(),
  spaceName: z.string().min(1).default('lumo-bridge'),
  includeSystemMessages: z.boolean().default(false),
  autoSync: z.boolean().default(false),
}).optional();

const conversationsDefaults = {
  maxInMemory: 100,
  deriveIdFromFirstMessage: false
};
const conversationsConfigSchema = z.object({
  maxInMemory: z.number().default(conversationsDefaults.maxInMemory),
  deriveIdFromFirstMessage: z.boolean().default(conversationsDefaults.deriveIdFromFirstMessage),
  sync: syncConfigSchema,
}).default(conversationsDefaults);

const authAutoRefreshConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalHours: z.number().min(1).max(24).default(20),
  onError: z.boolean().default(true),
}).optional();

// Auth method-specific config schemas
const authBrowserConfigSchema = z.object({
  cdpEndpoint: z.string().optional(),
}).optional();

const authLoginConfigSchema = z.object({
  binaryPath: z.string(),
  // Headers to avoid CAPTCHA - only used by proton-auth binary
  appVersion: z.string().optional(),
  userAgent: z.string().optional(),
}).optional();

export const authMethodSchema = z.enum(['login', 'browser', 'rclone']);

const authConfigSchema = z.object({
  method: authMethodSchema.default('browser'),
  tokenPath: z.string().default('sessions/auth-tokens.json'),
  autoRefresh: authAutoRefreshConfigSchema,
  // Method-specific config
  browser: authBrowserConfigSchema,
  login: authLoginConfigSchema,
});

// Mode-overridable config keys
const modeOverridesSchema = z.object({
  log: logConfigSchema,
  conversations: conversationsConfigSchema,
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

const MODE_KEYS: (keyof ModeOverrides)[] = ['log', 'conversations', 'instructions', 'tools'];

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
export const getConversationsConfig = () => resolved?.conversations ?? config.conversations;
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
export const authConfig = config.auth;

// ============================================================================
// Export types
// ============================================================================

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type ProtonConfig = z.infer<typeof protonConfigSchema>;
export type ToolsConfig = z.infer<typeof toolsConfigSchema>;
export type InstructionsConfig = z.infer<typeof instructionsConfigSchema>;
export type ConversationsConfig = z.infer<typeof conversationsConfigSchema>;
export type SyncConfig = z.infer<typeof syncConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type AuthBrowserConfig = z.infer<typeof authBrowserConfigSchema>;
export type AuthLoginConfig = z.infer<typeof authLoginConfigSchema>;
export type AuthAutoRefreshConfig = z.infer<typeof authAutoRefreshConfigSchema>;
export type CliConfig = z.infer<typeof cliConfigSchema>;
export type LogConfig = z.infer<typeof logConfigSchema>;
