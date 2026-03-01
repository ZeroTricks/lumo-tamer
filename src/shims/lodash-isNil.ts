/**
 * Shim for lodash/isNil to work with ESM
 *
 * lodash individual imports like `from 'lodash/isNil'` don't resolve
 * correctly in Node ESM without the .js extension. This shim re-exports
 * from the main lodash package which works correctly.
 *
 * Source: lodash isNil function
 */

import lodash from 'lodash';
export default lodash.isNil;
