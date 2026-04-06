module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.spec.ts'],
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: 'report', outputName: 'unit.xml' }],
  ],
};
