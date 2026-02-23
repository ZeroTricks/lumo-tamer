/**
 * Shim for lodash/isObject to work with ESM
 *
 * lodash individual imports like `from 'lodash/isObject'` don't resolve
 * correctly in Node ESM without the .js extension. This shim re-exports
 * from the main lodash package which works correctly.
 *
 * Source: lodash isObject function
 */

import lodash from 'lodash';
export default lodash.isObject;
