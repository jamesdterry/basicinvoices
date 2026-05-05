import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    exclude: ['node_modules', 'e2e', 'data'],
    globals: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: { NODE_ENV: 'test', DB_PATH: ':memory:' },
  },
});
