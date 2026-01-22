import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { z } from 'zod';

// Zod schemas for validation
const serverConfigSchema = z.object({
  port: z.number().int().positive(),
  apiKey: z.string().min(1, 'server.apiKey is required'),
  apiModelName: z.string().min(1, 'server.apiModelName is required'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
});

const protonConfigSchema = z.object({
  baseUrl: z.string().min(1, 'proton.baseUrl is required'),
  appVersion: z.string().min(1, 'proton.appVersion is required'),
  userAgent: z.string().optional(),
});

// Instructions configuration
const instructionsConfigSchema = z.object({
  default: z.string().optional(),
  append: z.boolean().optional().default(false),
  forTools: z.string().optional(),
}).optional();

// Tools configuration
const toolsConfigSchema = z.object({
  enableWebSearch: z.boolean().optional().default(false),
}).optional();

// Browser config is now optional (kept for backwards compatibility with DOM selectors)
const browserConfigSchema = z.object({
  url: z.string().optional(),
  cdpEndpoint: z.string().optional(),
  showSources: z.boolean().optional(),
  privateByDefault: z.boolean().optional(),
}).optional();

// Persistence configuration for conversation storage
// TODO: should defaults be here?
const persistenceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  syncInterval: z.number().default(30000),          // ms between sync attempts
  maxConversationsInMemory: z.number().default(100),
  defaultSpaceName: z.string().default('lumo-bridge'),
  // Optional: specify a space UUID directly to bypass name-matching logic
  // Can be found in the WebClient URL when viewing a space
  spaceId: z.string().uuid().optional(),
  // If true, sync all message types (system, tool_call, tool_result) to Proton server
  // If false (default), only sync user/assistant messages
  saveSystemMessages: z.boolean().default(false),
  // WORKAROUND for clients that don't provide conversation_id (e.g., Home Assistant).
  // When true: derives conversation ID from first user message hash, so same opening
  // message = same conversation. WARNING: This may incorrectly merge unrelated
  // conversations that happen to start with the same message!
  // When false (default): each request without conversation_id creates a new conversation.
  deriveIdFromFirstMessage: z.boolean().default(false),
}).optional();

// Auth configuration for SRP-based authentication
const authConfigSchema = z.object({
  method: z.enum(['srp', 'browser', 'rclone']).default('browser'),
  binaryPath: z.string().default('./bin/proton-auth'),
  tokenCachePath: z.string().default('sessions/auth-tokens.json'),
  // rclone-specific options
  rclonePath: z.string().optional(),   // Path to rclone.conf
  rcloneRemote: z.string().optional(), // Section name in rclone config
});





const configSchema = z.object({
  server: serverConfigSchema,
  proton: protonConfigSchema,
  tools: toolsConfigSchema,
  browser: browserConfigSchema,
  instructions: instructionsConfigSchema,
  persistence: persistenceConfigSchema,
  auth: authConfigSchema,
});

// Load and validate configuration
function loadConfig() {
  try {
    const configPath = join(process.cwd(), 'config.yaml');
    const fileContents = readFileSync(configPath, 'utf8');
    const rawConfig = load(fileContents);

    const validatedConfig = configSchema.parse(rawConfig);
    return validatedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Configuration validation failed:');
      error.issues.forEach((err) => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
      throw new Error('Invalid configuration. Please check config.yaml');
    }
    throw error;
  }
}

const config = loadConfig();

// Export configuration objects
export const serverConfig = config.server;
export const protonConfig = config.proton;

// Tools config
export const toolsConfig = config.tools;

// Browser-related configs are optional and may be undefined
export const browserConfig = config.browser;

// Instructions config
export const instructionsConfig = config.instructions;

// Persistence config
export const persistenceConfig = config.persistence;

// Auth config
export const authConfig = config.auth;

// Export types inferred from Zod schemas
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type ProtonConfig = z.infer<typeof protonConfigSchema>;
export type ToolsConfig = z.infer<typeof toolsConfigSchema>;
export type BrowserConfig = z.infer<typeof browserConfigSchema>;
export type InstructionsConfig = z.infer<typeof instructionsConfigSchema>;
export type PersistenceConfig = z.infer<typeof persistenceConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
