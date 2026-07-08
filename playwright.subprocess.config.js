const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  timeout: 120_000,
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
  },
  reporter: [['json', { outputFile: process.env.E2E_JSON_OUTPUT ?? '/tmp/e2e-result.json' }]],
  workers: 1,
})
