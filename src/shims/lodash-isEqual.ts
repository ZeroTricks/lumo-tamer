/**
 * Shim for lodash/isEqual to work with ESM
 *
 * lodash individual imports like `from 'lodash/isEqual'` don't resolve
 * correctly in Node ESM without the .js extension. This shim re-exports
 * from the main lodash package which works correctly.
 *
 * Source: lodash isEqual function
 */

import lodash from 'lodash';
export default lodash.isEqual;
