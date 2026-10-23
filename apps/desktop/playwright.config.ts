import { defineConfig } from '@playwright/test'
import { testTimeout } from './tests/helpers/test-timeout'

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: testTimeout(45_000),
  expect: { timeout: process.env.CI ? 30_000 : 10_000 },
  reporter: 'list'
})
