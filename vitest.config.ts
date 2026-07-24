import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    // Fixture generation (VideoToolbox encodes) can take minutes; individual
    // slow tests raise their own timeout, but keep a generous default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
