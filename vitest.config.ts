import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const src = resolve(__dirname, 'src');
const packages = resolve(__dirname, 'packages');

export default defineConfig({
  resolve: {
    alias: {
      // @lumo/* - maps to lumo package
      '@lumo': resolve(packages, 'lumo/src'),
      // @proton/* deep paths - map to proton, wildcards work with object syntax
      '@proton/crypto/lib/subtle/aesGcm': resolve(packages, 'proton/src/crypto/lib/subtle/aesGcm.ts'),
      '@proton/crypto/lib/subtle/hash': resolve(packages, 'proton/src/crypto/lib/subtle/hash.ts'),
      '@proton/crypto/lib/utils': resolve(packages, 'proton/src/crypto/lib/utils.ts'),
      '@proton/crypto/lib': resolve(packages, 'proton/src/crypto/index.ts'),
      '@proton/crypto': resolve(packages, 'proton/src/crypto/index.ts'),
      '@proton/shared/lib/apps/helper': resolve(packages, 'proton/src/shared/lib/apps/helper.ts'),
      '@proton/shared/lib/fetch/headers': resolve(packages, 'proton/src/shared/lib/fetch/headers.ts'),
      '@proton/utils/mergeUint8Arrays': resolve(packages, 'proton/src/utils/mergeUint8Arrays.ts'),
      // Library shims (in shims/ directory)
      'lodash/isNil': resolve(src, 'shims/lodash-isNil.ts'),
      // Match tsconfig baseUrl=./src for bare imports (e.g. 'app/config.js')
      'app': resolve(src, 'app'),
    },
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
