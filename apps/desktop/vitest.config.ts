import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // Eventual assertions also need time for SQLite work on shared CI disks.
    expect: { poll: { timeout: process.env.CI ? 10_000 : 1000 } },
    // Windows hosted runners perform real SQLite backups under shared disk load.
    testTimeout: process.env.CI ? 30_000 : 5_000
  }
})
