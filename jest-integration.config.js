/**
 * Config dos testes de INTEGRAÇÃO (rodam contra um Postgres de teste real).
 * Reaproveita a config unitária e troca: arquivos `*.int.spec.ts`, global setup que
 * aplica as migrations, sem coleta/threshold de cobertura, e timeout maior (I/O de banco).
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   npx jest --config jest-integration.config.js
 */
const base = require('./jest.config.js');

module.exports = {
  ...base,
  testRegex: '.*\\.int\\.spec\\.ts$',
  globalSetup: '<rootDir>/common/testing/global-setup.js',
  testPathIgnorePatterns: ['/node_modules/'],
  collectCoverage: false,
  coverageThreshold: undefined,
  testTimeout: 60000,
  // Banco compartilhado entre os testes → roda em série (cada spec limpa o banco no início).
  maxWorkers: 1,
};
