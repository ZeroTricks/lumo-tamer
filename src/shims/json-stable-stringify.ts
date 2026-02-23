/**
 * Shim for json-stable-stringify to work with ESM
 *
 * The package doesn't export correctly for ESM default imports.
 * This shim uses createRequire for clean CJS interop.
 *
 * Source: json-stable-stringify package
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const stableStringify: (obj: unknown, opts?: unknown) => string | undefined = require('json-stable-stringify');
export default stableStringify;
