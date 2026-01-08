export interface BrowserConfig {
  url: string;
  cdpEndpoint: string; // Chrome DevTools Protocol endpoint for remote browser
  enableWebSearch: boolean;
  showSources: boolean;
  behaviour: string;
}

export interface ChatboxSelectors {
  input: string;
  messages: string;
  completionIndicator?: string;
  webSearch: string;
  sources: string;
}
