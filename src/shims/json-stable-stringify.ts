/**
 * Shim for json-stable-stringify
 *
 * Re-exports the default export with proper typing.
 *
 * Source: json-stable-stringify package
 */

import stableStringify from 'json-stable-stringify/index.js';

export default stableStringify as (obj: unknown, opts?: unknown) => string | undefined;
