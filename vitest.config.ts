import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], environment: 'node', testTimeout: 15000, server: { deps: { inline: ['@excalidraw/excalidraw', 'roughjs'] } } },
});
