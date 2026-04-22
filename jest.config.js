/** @type {import('jest').Config} */
const enforceCoverage = String(process.env.ENFORCE_COVERAGE || "").trim().toLowerCase() === "true";

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.js"],
  testTimeout: 120000,
  clearMocks: true,
  restoreMocks: true,
  collectCoverage: true,
  collectCoverageFrom: ["src/**/*.js", "!src/server.js", "!src/config/**"],
  ...(enforceCoverage
    ? {
        coverageThreshold: {
          global: {
            branches: 80,
            functions: 80,
            lines: 80,
            statements: 80,
          },
        },
      }
    : {}),
  setupFiles: ["<rootDir>/__tests__/jest.env.js"],
  setupFilesAfterEnv: ["<rootDir>/__tests__/setupAfterEnv.js"],
  globalTeardown: "<rootDir>/__tests__/globalTeardown.js",
};

