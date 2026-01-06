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
};

export const browserConfig: BrowserConfig = {
  url: getRequiredEnv('CHATBOX_URL'),
  headless: getRequiredEnv('HEADLESS') === 'true',
  userDataDir: getRequiredEnv('USER_DATA_DIR'),
};

export const chatboxSelectors: ChatboxSelectors = {
  input: getRequiredEnv('SELECTOR_INPUT'),
  sendButton: getRequiredEnv('SELECTOR_SEND_BUTTON'),
  messages: getRequiredEnv('SELECTOR_MESSAGES'),
};
