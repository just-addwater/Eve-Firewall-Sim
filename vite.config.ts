import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { port: Number(process.env.PORT) || 5173 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
