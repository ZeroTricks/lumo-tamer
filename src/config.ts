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
  tokensPath: z.string().min(1, 'proton.tokensPath is required'),
  appVersion: z.string().min(1, 'proton.appVersion is required'),
});

// Browser config is now optional (kept for backwards compatibility)
const browserConfigSchema = z.object({
  url: z.string().optional(),
  cdpEndpoint: z.string().optional(),
  enableWebSearch: z.boolean().optional(),
  showSources: z.boolean().optional(),
  behaviour: z.string().optional(),
  behaviourAllowOverwrite: z.boolean().optional(),
  privateByDefault: z.boolean().optional(),
  instructionsUseTools: z.boolean().optional(),
  instructionsToolsDescription: z.string().optional(),
}).optional();





const configSchema = z.object({
  server: serverConfigSchema,
  proton: protonConfigSchema,
  browser: browserConfigSchema,
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

// Browser-related configs are optional and may be undefined
export const browserConfig = config.browser;

// Export types inferred from Zod schemas
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type ProtonConfig = z.infer<typeof protonConfigSchema>;
export type BrowserConfig = z.infer<typeof browserConfigSchema>;
