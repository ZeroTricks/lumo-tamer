import { config } from 'dotenv';
import { BrowserConfig, ChatboxSelectors } from './types.js';

config();

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const serverConfig = {
  port: parseInt(getRequiredEnv('PORT'), 10),
  apiKey: getRequiredEnv('API_KEY'),
  modelName: getRequiredEnv('MODEL_NAME'),
};

export const browserConfig: BrowserConfig = {
  url: getRequiredEnv('CHATBOX_URL'),
  cdpEndpoint: getRequiredEnv('CDP_ENDPOINT'),
};

export const chatboxSelectors: ChatboxSelectors = {
  input: getRequiredEnv('SELECTOR_INPUT'),
  messages: getRequiredEnv('SELECTOR_MESSAGES'),
  completionIndicator: getRequiredEnv('SELECTOR_COMPLETION_INDICATOR'),
};

export const responseTimeouts = {
  withText: parseInt(getRequiredEnv('RESPONSE_TIMEOUT_WITH_TEXT')),
  empty: parseInt(getRequiredEnv('RESPONSE_TIMEOUT_EMPTY')),
};
