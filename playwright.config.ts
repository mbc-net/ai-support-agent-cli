import { defineConfig } from '@playwright/test'

export default defineConfig({
  timeout: 30000,
  use: {
    headless: true,
    screenshot: 'only-on-failure',
  },
  reporter: [['json', { outputFile: 'tmp/e2e-results.json' }]],
})
