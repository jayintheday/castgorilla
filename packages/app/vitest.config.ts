/**
 * Standalone test config so `npm test -w packages/app` runs only the app's
 * tests. The root vitest run also discovers these via its `packages/**` glob.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
