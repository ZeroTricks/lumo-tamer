import { existsSync, readFileSync } from 'fs';
import { load } from 'js-yaml';
import { z } from 'zod';
import merge from 'lodash/merge.js';
import { resolveProjectPath } from './paths.js';

// Load defaults from YAML (single source of truth)
const configDefaults = load(readFileSync(resolveProjectPath('config.defaults.yaml'), 'utf8')) as Record<string, unknown>;

// Config loading
export type ConfigMode = 'server' | 'cli';
// Shared keys that can be overridden per mode (instructions is mode-specific only)
const SHARED_KEYS = ['log', 'conversations', 'tools', 'commands'] as const;

// Schemas (validation only, no defaults - defaults come from config.defaults.yaml)
const logConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  target: z.enum(['stdout', 'file']),
  filePath: z.string(),
  messageContent: z.boolean(),
});

const instructionsConfigSchema = z.object({
  default: z.string(),
  append: z.boolean(),
  forTools: z.string(),
});

const toolsConfigSchema = z.object({
  enabled: z.boolean(),
  enableWebSearch: z.boolean(),
  enableFileReads: z.boolean(),
  // Maps code block language tag → [command, ...args]. Code is appended as last arg.
  executors: z.record(z.string(), z.array(z.string())),
});

const commandsConfigSchema = z.object({
  enabled: z.boolean(),
});

const conversationsConfigSchema = z.object({
  maxInMemory: z.number(),
  deriveIdFromFirstMessage: z.boolean(),
  sync: z.object({
    enabled: z.boolean(),
    spaceId: z.string().uuid().optional(),
    spaceName: z.string().min(1),
    includeSystemMessages: z.boolean(),
    autoSync: z.boolean(),
  }),
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

const modeConfigSchema = z.object({
  log: logConfigSchema,
  conversations: conversationsConfigSchema,
  instructions: instructionsConfigSchema,
  tools: toolsConfigSchema,
  commands: commandsConfigSchema,
});

const mergedConfigSchema = modeConfigSchema.extend({
  auth: authConfigSchema,
});

const serverFieldsSchema = z.object({
  port: z.number().int().positive(),
  apiKey: z.string().min(1, 'server.apiKey is required'),
  apiModelName: z.string().min(1),
});

const serverMergedConfigSchema = mergedConfigSchema.extend(serverFieldsSchema.shape);

type MergedConfig = z.infer<typeof mergedConfigSchema>;
type ServerMergedConfig = z.infer<typeof serverMergedConfigSchema>;



// Cache user config (loaded once)
let userConfigCache: Record<string, unknown> | null = null;
function loadUserYaml(): Record<string, unknown> {
  if (userConfigCache !== null) return userConfigCache;

  const configPath = resolveProjectPath('config.yaml');
  if (!existsSync(configPath)) {
    // using console here as logger is not initialized yet
    console.log('No config.yaml found, using defaults from config.defaults.yaml');
    userConfigCache = {};
  } else {
    userConfigCache = load(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  }
  return userConfigCache;
}

function loadMergedConfig(mode: ConfigMode): MergedConfig | ServerMergedConfig {
  try {
    const userConfig = loadUserYaml();
    const defaultModeConfig = (mode === 'server' ? configDefaults.server : configDefaults.cli) as Record<string, unknown>;
    const userModeConfig = (mode === 'server' ? userConfig.server : userConfig.cli) as Record<string, unknown> | undefined;

    // Stage 1: defaults → user (for all keys including mode-specific)
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

    return (mode === 'server' ? serverMergedConfigSchema : mergedConfigSchema).parse(merged);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Configuration validation failed:');
      error.issues.forEach((e) => console.error(`  - ${e.path.join('.')}: ${e.message}`));
      throw new Error('Invalid configuration. Please check config.yaml and config.defaults.yaml');
    }
    throw error;
  }
}

// State
let config: MergedConfig | ServerMergedConfig | null = null;
let configMode: ConfigMode | null = null;

export function initConfig(mode: ConfigMode): void {
  configMode = mode;
  config = loadMergedConfig(mode);
}

export function getConfigMode(): ConfigMode | null {
  return configMode;
}

function getConfig(): MergedConfig {
  if (!config) throw new Error('Config not initialized. Call initConfig() first.');
  return config;
}

// Getters
export const getLogConfig = () => getConfig().log;
export const getConversationsConfig = () => getConfig().conversations;
export const getInstructionsConfig = () => getConfig().instructions;
export const getToolsConfig = () => getConfig().tools;
export const getCommandsConfig = () => getConfig().commands;

export function getServerConfig(): ServerMergedConfig {
  if (configMode !== 'server' || !config) throw new Error('Server configuration required. Run in server mode.');
  return config as ServerMergedConfig;
}

// Legacy export (for scripts before initConfig (auth))
export const authConfig = ((): z.infer<typeof authConfigSchema> => {
  const userConfig = loadUserYaml();
  const merged = merge({}, configDefaults.auth, userConfig.auth);
  return authConfigSchema.parse(merged);
})();

// Types
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type ServerConfig = z.infer<typeof serverFieldsSchema>;
export type CliConfig = z.infer<typeof modeConfigSchema>;
export type LogConfig = z.infer<typeof logConfigSchema>;
export type ToolsConfig = z.infer<typeof toolsConfigSchema>;
export type InstructionsConfig = z.infer<typeof instructionsConfigSchema>;
export type ConversationsConfig = z.infer<typeof conversationsConfigSchema>;
