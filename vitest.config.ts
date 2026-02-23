import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const src = resolve(__dirname, 'src');

export default defineConfig({
  resolve: {
    alias: [
      // Match tsconfig paths for Proton shims (order matters - specific paths before general)
      { find: '@proton/crypto/lib/subtle/aesGcm', replacement: resolve(src, 'proton-shims/crypto/lib/subtle/aesGcm.ts') },
      { find: '@proton/crypto/lib/subtle/hash', replacement: resolve(src, 'proton-shims/crypto/lib/subtle/hash.ts') },
      { find: '@proton/crypto/lib/utils', replacement: resolve(src, 'proton-shims/crypto/lib/utils.ts') },
      { find: '@proton/crypto/lib', replacement: resolve(src, 'proton-shims/crypto/index.ts') },
      { find: '@proton/crypto', replacement: resolve(src, 'proton-shims/crypto/index.ts') },
      { find: '@proton/shared/lib/apps/helper', replacement: resolve(src, 'proton-shims/shared/lib/apps/helper.ts') },
      { find: '@proton/shared/lib/fetch/headers', replacement: resolve(src, 'proton-shims/shared/lib/fetch/headers.ts') },
      { find: '@proton/utils/mergeUint8Arrays', replacement: resolve(src, 'proton-shims/utils/mergeUint8Arrays.ts') },
      // Format shims (in shims/ directory)
      { find: 'lodash/isNil', replacement: resolve(src, 'shims/lodash-isNil.ts') },
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
