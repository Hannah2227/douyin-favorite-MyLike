import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // Windows hosted runners perform real SQLite backups under shared disk load.
    testTimeout: process.env.CI ? 30_000 : 5_000
  }
})
