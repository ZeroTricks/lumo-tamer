/**
 * Shim for toposort to work with ESM
 *
 * The package doesn't export correctly for ESM default imports.
 * This shim uses createRequire for clean CJS interop.
 *
 * Source: toposort package
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const toposortFn: <T>(edges: Array<[T, T | undefined]>) => T[] = require('toposort');
export default toposortFn;
