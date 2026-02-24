/**
 * Shim for toposort to work with ESM
 *
 * The package doesn't export correctly for ESM default imports.
 * We re-export the actual implementation here.
 *
 * Note: Import path uses 'toposort/index.js' to avoid tsc-alias
 * rewriting it back to this shim (creating a cycle).
 */

// @ts-ignore - CJS interop
import toposortFn from 'toposort/index.js';
export default toposortFn as <T>(edges: Array<[T, T | undefined]>) => T[];
