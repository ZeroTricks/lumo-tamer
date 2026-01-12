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

const browserConfigSchema = z.object({
  url: z.string().min(1, 'browser.url is required'),
  cdpEndpoint: z.string().min(1, 'browser.cdpEndpoint is required'),
  enableWebSearch: z.boolean(),
  showSources: z.boolean(),
  behaviour: z.string().min(1, 'browser.behaviour is required'),
  behaviourAllowOverwrite: z.boolean(),
  privateByDefault: z.boolean(),
  instructionsUseTools: z.boolean(),
  instructionsToolsDescription: z.string(),
});

const selectorsSchema = z.object({
  input: z.string().min(1, 'selectors.input is required'),
  messages: z.string().min(1, 'selectors.messages is required'),
  contentElements: z.string().min(1, 'selectors.contentElements is required'),
  messageCompletionMarker: z.string().min(1, 'selectors.messageCompletionMarker is required'),
  webSearchToggle: z.string().min(1, 'selectors.webSearchToggle is required'),
  sources: z.string().min(1, 'selectors.sources is required'),
  newChatButton: z.string().min(1, 'selectors.newChatButton is required'),
  privateButton: z.string().min(1, 'selectors.privateButton is required'),
  settingsCog: z.string().min(1, 'selectors.settingsCog is required'),
  personalizationMenu: z.string().min(1, 'selectors.personalizationMenu is required'),
  behaviourField: z.string().min(1, 'selectors.behaviourField is required'),
  saveSettings: z.string().min(1, 'selectors.saveSettings is required'),
  modalClose: z.string().min(1, 'selectors.modalClose is required'),
  previousChat: z.string().min(1, 'selectors.previousChat is required'),
  expandSidebar: z.string().min(1, 'selectors.expandSidebar is required'),
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
