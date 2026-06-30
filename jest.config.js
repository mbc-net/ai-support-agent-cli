module.exports = {
  coverageProvider: 'babel',
  forceExit: true,
  projects: [
    // Unit tests
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/__tests__/**/*.spec.ts'],
      testPathIgnorePatterns: ['\\.integration\\.spec\\.ts$'],
      globals: {
        'ts-jest': {
          isolatedModules: true,
        },
      },
      collectCoverageFrom: ['src/**/*.ts', '!src/index.ts', '!src/__mocks__/**'],
      coverageThreshold: {
        global: {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
      },
      reporters: [
        'default',
        ['jest-junit', { outputDirectory: 'report', outputName: 'unit.xml' }],
      ],
    },
    // Integration tests
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/__tests__/**/*.integration.spec.ts'],
      globals: {
        'ts-jest': {
          isolatedModules: true,
        },
      },
      // page-scripts.ts holds browser-context functions serialized to Chromium
      // via page.evaluate/addInitScript. Under --coverage the babel provider
      // would instrument them, injecting a module-scoped `cov_*` counter that is
      // undefined inside the browser, so the serialized function throws a
      // ReferenceError. Skip instrumenting it here; the unit project covers it
      // by invoking the functions directly in Node (page-scripts.spec.ts).
      coveragePathIgnorePatterns: [
        '/node_modules/',
        '<rootDir>/src/mcp/tools/browser/page-scripts.ts',
      ],
      testTimeout: 30000,
      reporters: [
        'default',
        ['jest-junit', { outputDirectory: 'report', outputName: 'integration.xml' }],
      ],
    },
  ],
};
