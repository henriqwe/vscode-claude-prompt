import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: { vscode: new URL('./src/__tests__/mocks/vscode.ts', import.meta.url).pathname },
  },
})
