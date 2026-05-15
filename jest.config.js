module.exports = {
  coverageProvider: 'babel',
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
      testTimeout: 30000,
      reporters: [
        'default',
        ['jest-junit', { outputDirectory: 'report', outputName: 'integration.xml' }],
      ],
    },
  ],
};
