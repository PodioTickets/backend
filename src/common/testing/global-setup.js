/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Global setup dos testes de INTEGRAÇÃO: cria o schema no Postgres de teste (descartável)
 * a partir do `schema.prisma`. Roda UMA vez por execução do jest, antes de qualquer spec.
 *
 * Usa `prisma db push` (e NÃO `migrate deploy`) de propósito:
 *   - No banco de teste só interessa o ESTADO FINAL do schema, não o histórico.
 *   - O histórico de migrations do projeto tem um drift de ordenação (uma migration mexe em
 *     OrganizationPixKey antes da migration que cria a tabela) que só não quebra na homolog
 *     porque o banco veio de restore de dump. `db push` sincroniza direto do schema e ignora isso.
 *
 * Pré-requisito: o container do banco de teste precisa estar de pé
 *   docker compose -f docker-compose.test.yml up -d   (ou: pnpm test:db:up)
 */
const { execSync } = require('node:child_process');

module.exports = async () => {
  const url =
    process.env.TEST_DATABASE_URL ||
    'postgresql://test:test@localhost:5434/podio_test?schema=public';

  // eslint-disable-next-line no-console
  console.log(`\n[integration] sincronizando schema no banco de teste (prisma db push)...`);
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
};
