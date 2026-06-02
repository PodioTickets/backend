/**
 * Utilitários para testes de INTEGRAÇÃO (rodam contra um Postgres de teste REAL).
 *
 * - `createTestPrisma()`: um PrismaService apontando para o banco de teste (porta 5433).
 * - `resetDb()`: limpa TODAS as tabelas entre os testes (isolamento), sem apagar o schema.
 * - `seed*`: cria linhas REAIS mínimas (organização, usuário admin, evento) para os cenários.
 *
 * O banco de teste é descartável (docker-compose.test.yml) — nunca toca dados reais.
 */
import { PrismaService } from '../../prisma/prisma.service';

/** URL do Postgres de teste. Sobrescrevível por env; default = container docker-compose.test.yml. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://test:test@localhost:5434/podio_test?schema=public';

/** Cria um PrismaService conectado ao banco de TESTE (ConfigService stub). */
export function createTestPrisma(): PrismaService {
  const configStub: any = {
    get: (key: string) => (key === 'DATABASE_URL' ? TEST_DATABASE_URL : undefined),
  };
  return new PrismaService(configStub);
}

/**
 * Esvazia todas as tabelas do schema público (menos o controle de migrations).
 * TRUNCATE ... CASCADE respeita as FKs; RESTART IDENTITY zera as sequências.
 */
export async function resetDb(prisma: PrismaService): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;

/** Cria uma organização real mínima e devolve seu id. */
export async function seedOrganization(prisma: PrismaService): Promise<string> {
  const org = await prisma.getWriteClient().organization.create({
    data: { name: `Org Teste ${uniq()}`, email: `org-${uniq()}@teste.com` },
    select: { id: true },
  });
  return org.id;
}

/** Cria um usuário real. `role` default ADMIN (passa direto na checagem de acesso). */
export async function seedUser(
  prisma: PrismaService,
  role: 'ADMIN' | 'USER' | 'PODIOGO_STAFF' = 'ADMIN',
): Promise<string> {
  const user = await prisma.getWriteClient().user.create({
    data: {
      email: `user-${uniq()}@teste.com`,
      password: 'hash-irrelevante-no-teste',
      firstName: 'Fulano',
      lastName: 'de Teste',
      role: role as any,
    },
    select: { id: true },
  });
  return user.id;
}

/** Cria um evento real mínimo (com a organização). Datas coerentes (inscrição → evento futuro). */
export async function seedEvent(
  prisma: PrismaService,
  organizationId: string,
): Promise<string> {
  const event = await prisma.getWriteClient().event.create({
    data: {
      organizationId,
      name: `Evento Teste ${uniq()}`,
      location: 'Local Teste',
      city: 'São Paulo',
      state: 'SP',
      country: 'BR',
      eventDate: new Date('2030-01-10T12:00:00.000Z'),
      registrationStartDate: new Date('2029-12-01T12:00:00.000Z'),
      registrationEndDate: new Date('2030-01-05T12:00:00.000Z'),
    },
    select: { id: true },
  });
  return event.id;
}

/** Atalho: cria organização + usuário admin + evento de uma vez. */
export async function seedOrgUserEvent(prisma: PrismaService): Promise<{
  organizationId: string;
  adminUserId: string;
  eventId: string;
}> {
  const organizationId = await seedOrganization(prisma);
  const adminUserId = await seedUser(prisma, 'ADMIN');
  const eventId = await seedEvent(prisma, organizationId);
  return { organizationId, adminUserId, eventId };
}
