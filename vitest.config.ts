import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Database-backed test files share one database, so files run one at a time.
    fileParallelism: false,
    include: ['packages/*/src/**/*.test.ts', 'apps/*/{src,test}/**/*.test.ts'],
  },
});
