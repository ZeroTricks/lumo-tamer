import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { z } from 'zod';
import merge from 'lodash/merge.js';
import { resolveProjectPath } from './paths.js';

// Schemas
const logConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  target: z.enum(['stdout', 'file']).default('stdout'),
  filePath: z.string().default('logs/lumo-tamer.log'),
  messageContent: z.boolean().default(false),
}).prefault({});

const instructionsConfigSchema = z.object({
  default: z.string().optional(),
  append: z.boolean().default(false),
  forTools: z.string().default(''),
}).prefault({});

const toolsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  enableWebSearch: z.boolean().default(false),
  // Maps code block language tag → [command, ...args]. Code is appended as last arg.
  executors: z.record(z.string(), z.array(z.string())).default({
    // Unix shells
    bash: ['bash', '-c'],
    sh: ['sh', '-c'],
    zsh: ['zsh', '-c'],
    // Windows shells
    powershell: ['powershell', '-Command'],
    ps1: ['powershell', '-Command'],
    cmd: ['cmd', '/c'],
    // Scripting languages
    python: ['python3', '-c'],
    python3: ['python3', '-c'],
    node: ['node', '-e'],
    javascript: ['node', '-e'],
    js: ['node', '-e'],
    ruby: ['ruby', '-e'],
    perl: ['perl', '-e'],
  }),
}).prefault({});

const commandsConfigSchema = z.object({
  enabled: z.boolean().default(true),
}).prefault({});

const syncConfigSchema = z.object({
  enabled: z.boolean().default(false),
  spaceId: z.string().uuid().optional(),
  spaceName: z.string().min(1).default('lumo-tamer'),
  includeSystemMessages: z.boolean().default(false),
  autoSync: z.boolean().default(false),
}).prefault({});

const conversationsConfigSchema = z.object({
  maxInMemory: z.number().default(100),
  deriveIdFromFirstMessage: z.boolean().default(false),
  sync: syncConfigSchema,
}).prefault({});

const authAutoRefreshConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalHours: z.number().min(1).max(24).default(20),
  onError: z.boolean().default(true),
}).prefault({});

const authBrowserConfigSchema = z.object({
  cdpEndpoint: z.string().default('http://localhost:9222'),
}).optional();

const authLoginConfigSchema = z.object({
  binaryPath: z.string().default('./dist/proton-auth'),
  appVersion: z.string().default('macos-drive@1.0.0-alpha.1+rclone'),
  userAgent: z.string().default('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
}).prefault({});

export const authMethodSchema = z.enum(['login', 'browser', 'rclone']);

const authConfigSchema = z.object({
  method: authMethodSchema.default('browser'),
  tokenPath: z.string().default('sessions/auth-tokens.json'),
  autoRefresh: authAutoRefreshConfigSchema,
  browser: authBrowserConfigSchema,
  login: authLoginConfigSchema,
}).prefault({});

const modeOverridesSchema = z.object({
  log: logConfigSchema,
  conversations: conversationsConfigSchema,
  instructions: instructionsConfigSchema,
  tools: toolsConfigSchema,
  commands: commandsConfigSchema,
});

const mergedConfigSchema = modeOverridesSchema.extend({
  auth: authConfigSchema,
});

const serverFieldsSchema = z.object({
  port: z.number().int().positive().default(3003),
  apiKey: z.string().min(1, 'server.apiKey is required'),
  apiModelName: z.string().min(1).default('lumo'),
});

const serverMergedConfigSchema = mergedConfigSchema.extend(serverFieldsSchema.shape);

type MergedConfig = z.infer<typeof mergedConfigSchema>;
type ServerMergedConfig = z.infer<typeof serverMergedConfigSchema>;
type ModeOverrides = z.infer<typeof modeOverridesSchema>;

// Config loading
export type ConfigMode = 'server' | 'cli';
const MODE_KEYS: (keyof ModeOverrides)[] = ['log', 'conversations', 'instructions', 'tools', 'commands'];

function loadRawYaml(): Record<string, unknown> {
  return load(readFileSync(resolveProjectPath('config.yaml'), 'utf8')) as Record<string, unknown>;
}

function loadMergedConfig(mode: ConfigMode): MergedConfig | ServerMergedConfig {
  try {
    const raw = loadRawYaml();
    const modeConfig = (mode === 'server' ? raw.server : raw.cli) as Record<string, unknown> | undefined;

    // Deep merge mode-overridable keys before Zod parsing
    const merged: Record<string, unknown> = { auth: raw.auth };
    for (const key of MODE_KEYS) {
      merged[key] = merge({}, raw[key], modeConfig?.[key]);
    }

    // Copy mode-specific fields (anything not in MODE_KEYS)
    if (modeConfig) {
      for (const key of Object.keys(modeConfig)) {
        if (!MODE_KEYS.includes(key as keyof ModeOverrides)) {
          merged[key] = modeConfig[key];
        }
      }
    }

    return (mode === 'server' ? serverMergedConfigSchema : mergedConfigSchema).parse(merged);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Configuration validation failed:');
      error.issues.forEach((e) => console.error(`  - ${e.path.join('.')}: ${e.message}`));
      throw new Error('Invalid configuration. Please check config.yaml');
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

// Legacy exports (for scripts before initConfig)
export const authConfig = authConfigSchema.parse(loadRawYaml().auth);

// Types
export type ServerConfig = z.infer<typeof serverFieldsSchema>;
export type ToolsConfig = z.infer<typeof toolsConfigSchema>;
export type InstructionsConfig = z.infer<typeof instructionsConfigSchema>;
export type ConversationsConfig = z.infer<typeof conversationsConfigSchema>;
export type SyncConfig = z.infer<typeof syncConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type AuthBrowserConfig = z.infer<typeof authBrowserConfigSchema>;
export type AuthLoginConfig = z.infer<typeof authLoginConfigSchema>;
export type AuthAutoRefreshConfig = z.infer<typeof authAutoRefreshConfigSchema>;
export type CliConfig = z.infer<typeof modeOverridesSchema>;
export type LogConfig = z.infer<typeof logConfigSchema>;
