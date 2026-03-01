/**
 * Auth providers index
 */

export { BrowserAuthProvider } from './browser.js';
export { AuthProvider, getProviderConfig, type  ProviderConfig } from './provider.js';

// Import browser to register its factory (side effect)
import './browser.js';

