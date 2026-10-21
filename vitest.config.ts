import { defineConfig, mergeConfig } from 'vitest/config';
import vite from './vite.config.ts';
export default mergeConfig(vite, defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'], setupFiles: ['test/setup.ts'], restoreMocks: true },
}));
