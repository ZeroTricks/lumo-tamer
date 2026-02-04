import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const src = resolve(__dirname, 'src');

export default defineConfig({
  resolve: {
    alias: [
      // Match tsconfig paths for Proton shims
      { find: '@proton/crypto/lib/subtle/aesGcm', replacement: resolve(src, 'proton-shims/aesGcm.ts') },
      { find: '@proton/crypto/lib/subtle/hash', replacement: resolve(src, 'proton-shims/hash.ts') },
      { find: '@proton/crypto/lib/utils', replacement: resolve(src, 'proton-shims/crypto-lib-utils.ts') },
      { find: '@proton/crypto', replacement: resolve(src, 'proton-shims/crypto.ts') },
      { find: '@proton/shared/lib/apps/helper', replacement: resolve(src, 'proton-shims/apps-helper.ts') },
      { find: '@proton/shared/lib/fetch/headers', replacement: resolve(src, 'proton-shims/fetch-headers.ts') },
      { find: 'lodash/isNil', replacement: resolve(src, 'proton-shims/lodash-isNil.ts') },
      // Match tsconfig baseUrl=./src for bare imports (e.g. 'app/config.js')
      { find: 'app', replacement: resolve(src, 'app') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 15000,
    coverage: {
      include: ['src/**/*.ts'],
    }
  },
});
