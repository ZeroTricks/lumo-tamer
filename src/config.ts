import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { z } from 'zod';

// Zod schemas for validation
const serverConfigSchema = z.object({
  port: z.number().int().positive(),
  apiKey: z.string().min(1, 'API key is required'),
  apiModelName: z.string().min(1, 'API model name is required'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
});

const browserConfigSchema = z.object({
  url: z.string().min(1, 'Chatbox URL is required'),
  cdpEndpoint: z.string().min(1, 'CDP endpoint is required'),
  enableWebSearch: z.boolean(),
  showSources: z.boolean(),
  behaviour: z.string().min(1, 'Behaviour instruction is required'),
  behaviourAllowOverwrite: z.boolean(),
  privateByDefault: z.boolean(),
  instructionsUseTools: z.boolean(),
  instructionsToolsDescription: z.string(),
});

const selectorsSchema = z.object({
  input: z.string().min(1, 'Input selector is required'),
  messages: z.string().min(1, 'Messages selector is required'),
  completionIndicator: z.string().optional(),
  webSearchToggle: z.string().min(1, 'Web search selector is required'),
  sources: z.string().min(1, 'Sources selector is required'),
  newChatButton: z.string().min(1, 'New chat selector is required'),
  privateButton: z.string().min(1, 'Private button selector is required'),
  settingsCog: z.string().min(1, 'Settings cog selector is required'),
  personalizationMenu: z.string().min(1, 'Personalization menu selector is required'),
  behaviourField: z.string().min(1, 'Behaviour field selector is required'),
  saveSettings: z.string().min(1, 'Personalization save selector is required'),
  modalClose: z.string().min(1, 'Modal close selector is required'),
  previousChat: z.string().min(1, 'Previous chat selector is required'),
  expandSidebar: z.string().min(1, 'Sidebar expander selector is required'),
});

const timeoutsSchema = z.object({
  withText: z.number().int().positive(),
  empty: z.number().int().positive(),
});

const configSchema = z.object({
  server: serverConfigSchema,
  browser: browserConfigSchema,
  selectors: selectorsSchema,
  timeouts: timeoutsSchema,
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
export const browserConfig = config.browser;
export const chatboxSelectors = config.selectors;
export const responseTimeouts = config.timeouts;

// Export types inferred from Zod schemas
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type BrowserConfig = z.infer<typeof browserConfigSchema>;
export type ChatboxSelectors = z.infer<typeof selectorsSchema>;
export type ResponseTimeouts = z.infer<typeof timeoutsSchema>;
