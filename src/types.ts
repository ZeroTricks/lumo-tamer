// Types are now exported from config.ts (inferred from Zod schemas)
// This file is kept for any additional application-specific types

// Extend Window interface for custom properties used in browser automation
declare global {
  interface Window {
    __lumoState?: {
      observer: MutationObserver;
      lastMessageContainer: Element;
    };
    __responseMutationHandler?: (text: string, hasCompletionMarker: boolean) => void;
  }
}

// Browser extraction types
export interface Source {
  url: string;
  title: string;
}

export interface ToolCall {
  name: string;
  arguments: string;
}
