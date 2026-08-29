/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o "diário de atividades" do sistema (UserActivityLog). Toda vez que
 *           alguém abre uma página, clica num botão, faz login ou passa pelo
 *           checkout, o sistema pode registrar uma linha aqui (quem fez, de qual
 *           IP, em que sessão, de qual origem, quando).
 *
 *  EM RESUMO:
 *    Um administrador precisa CONSULTAR esse diário para investigar abuso, refazer
 *    a jornada de um usuário, etc. Esta tela só LÊ os registros — nunca grava.
 *    O administrador pode filtrar por usuário, IP, sessão, categoria, origem,
 *    intervalo de datas e por um pedaço do texto da ação; e os resultados vêm
 *    paginados (página/limite/total) e ordenados do mais novo para o mais antigo.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Sem nenhum filtro: traz tudo, do mais recente para o mais antigo.
 *    • Filtro por IP exato: traz só os registros daquele IP.
 *    • Filtro por usuário (userId): traz só os daquele usuário.
 *    • Filtro por categoria (ex.: AUTH): traz só os daquela categoria.
 *    • Filtro por origem (source, ex.: BACKEND): traz só os daquela origem.
 *    • Filtro por sessão (sessionId exato): traz só os daquela sessão.
 *    • Filtro por intervalo de datas (de/até): traz só o que caiu no período;
 *      o "até" é inclusivo até o fim do dia (23:59:59.999 UTC).
 *    • Filtro por pedaço do texto da ação (q): busca por substring, ignorando
 *      maiúsculas/minúsculas.
 *    • Busca por dados do usuário (userSearch): casa por nome/sobrenome/email e
 *      EXCLUI registros anônimos (sem usuário).
 *    • Busca por nome completo ("Fulano de Teste"): cada palavra precisa casar
 *      com algum campo do usuário — nome + sobrenome juntos funcionam.
 *    • Paginação: respeita página e limite, e o total reflete TODOS os registros
 *      que casam com o filtro (não só os da página).
 *    • Registro anônimo (sem userId) volta com user = null.
 *    • Sem resultados: lista vazia e total zero (sem quebrar).
 *
 *  COMO CONFERIMOS:
 *    Este é um teste DE VERDADE contra um banco de dados de teste (descartável).
 *    Criamos usuários e linhas de atividade REAIS no banco, chamamos a consulta do
 *    administrador e conferimos o que volta. O banco é separado, só para teste, e
 *    é limpo antes de cada cenário.
 * ============================================================================
 */
import { UserActivityAdminService } from '../user-activity-admin.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AdminUserActivityListQueryDto } from '../dto/admin-list-activity.dto';
import {
  createTestPrisma,
  resetDb,
  seedUser,
} from '../../../common/testing/integration-db';
import {
  Prisma,
  UserActivityCategory,
  UserActivitySource,
} from '@prisma/client';

describe('UserActivityAdminService (integração, banco real)', () => {
  let prisma: PrismaService;
  let service: UserActivityAdminService;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    service = new UserActivityAdminService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma); // banco limpo antes de cada cenário
  });

  /**
   * Cria uma linha REAL de UserActivityLog.
   *
   * Campos OBRIGATÓRIOS no schema: source, category, action. Os demais são
   * opcionais. `occurredAt` tem default now() — passamos explicitamente nos
   * cenários de data para ter datas determinísticas.
   */
  const seedLog = (
    overrides: Partial<Prisma.UserActivityLogUncheckedCreateInput> = {},
  ) =>
    prisma.getWriteClient().userActivityLog.create({
      data: {
        source: UserActivitySource.BACKEND,
        category: UserActivityCategory.API,
        action: 'api:GET /events',
        ...overrides,
      },
      select: { id: true },
    });

  // Atalho para montar o DTO de query sem ruído de tipos no teste.
  const query = (q: Partial<AdminUserActivityListQueryDto> = {}) =>
    q as AdminUserActivityListQueryDto;

  it('sem filtro, traz tudo do mais recente para o mais antigo', async () => {
    await seedLog({
      action: 'antigo',
      occurredAt: new Date('2026-01-01T10:00:00.000Z'),
    });
    await seedLog({
      action: 'meio',
      occurredAt: new Date('2026-01-02T10:00:00.000Z'),
    });
    await seedLog({
      action: 'recente',
      occurredAt: new Date('2026-01-03T10:00:00.000Z'),
    });

    const res = await service.listAsAdmin(query());

    expect(res.data.items.map((i) => i.action)).toEqual([
      'recente',
      'meio',
      'antigo',
    ]); // ordem decrescente por occurredAt
    expect(res.data.pagination.total).toBe(3);
  });

  it('filtra por IP exato', async () => {
    await seedLog({ ip: '187.45.10.2', action: 'alvo' });
    await seedLog({ ip: '10.0.0.1', action: 'outro' });

    const res = await service.listAsAdmin(query({ ip: '187.45.10.2' }));

    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].action).toBe('alvo');
    expect(res.data.items[0].ip).toBe('187.45.10.2');
    expect(res.data.pagination.total).toBe(1);
  });

  it('filtra por usuário (userId) e devolve os dados do usuário', async () => {
    const userId = await seedUser(prisma, 'USER');
    const outroUserId = await seedUser(prisma, 'USER');
    await seedLog({ userId, action: 'do-usuario' });
    await seedLog({ userId: outroUserId, action: 'de-outro' });
    await seedLog({ action: 'anonimo' }); // sem userId

    const res = await service.listAsAdmin(query({ userId }));

    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].action).toBe('do-usuario');
    expect(res.data.items[0].userId).toBe(userId);
    // O service achata firstName + lastName em fullName.
    expect(res.data.items[0].user).toMatchObject({
      id: userId,
      fullName: 'Fulano de Teste',
    });
  });

  it('filtra por categoria', async () => {
    await seedLog({ category: UserActivityCategory.AUTH, action: 'login' });
    await seedLog({ category: UserActivityCategory.AUTH, action: 'logout' });
    await seedLog({ category: UserActivityCategory.PAGE_VIEW, action: 'home' });

    const res = await service.listAsAdmin(
      query({ category: UserActivityCategory.AUTH }),
    );

    expect(res.data.items).toHaveLength(2);
    expect(res.data.items.every((i) => i.category === 'AUTH')).toBe(true);
    expect(res.data.pagination.total).toBe(2);
  });

  it('filtra por origem (source)', async () => {
    await seedLog({ source: UserActivitySource.FRONTEND, action: 'fe' });
    await seedLog({ source: UserActivitySource.BACKEND, action: 'be' });
    await seedLog({ source: UserActivitySource.WEBHOOK, action: 'wh' });

    const res = await service.listAsAdmin(
      query({ source: UserActivitySource.WEBHOOK }),
    );

    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].action).toBe('wh');
    expect(res.data.items[0].source).toBe('WEBHOOK');
  });

  it('filtra por sessionId exato (costura jornada anônima→autenticada)', async () => {
    await seedLog({ sessionId: 'sess-abc', action: 'na-sessao' });
    await seedLog({ sessionId: 'sess-xyz', action: 'fora' });

    const res = await service.listAsAdmin(query({ sessionId: 'sess-abc' }));

    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].action).toBe('na-sessao');
    expect(res.data.items[0].sessionId).toBe('sess-abc');
  });

  it('filtra por intervalo de datas (de/até inclusivo)', async () => {
    await seedLog({
      action: 'antes',
      occurredAt: new Date('2026-01-09T23:00:00.000Z'),
    });
    await seedLog({
      action: 'dentro-inicio',
      occurredAt: new Date('2026-01-10T00:00:00.000Z'),
    });
    // "to" é inclusivo até o FIM do dia (23:59:59.999 UTC) — este deve entrar.
    await seedLog({
      action: 'dentro-fim-do-dia',
      occurredAt: new Date('2026-01-12T18:30:00.000Z'),
    });
    await seedLog({
      action: 'depois',
      occurredAt: new Date('2026-01-13T00:00:00.000Z'),
    });

    const res = await service.listAsAdmin(
      query({ from: '2026-01-10T00:00:00.000Z', to: '2026-01-12' }),
    );

    const actions = res.data.items.map((i) => i.action);
    expect(actions).toContain('dentro-inicio');
    expect(actions).toContain('dentro-fim-do-dia');
    expect(actions).not.toContain('antes');
    expect(actions).not.toContain('depois');
    expect(res.data.pagination.total).toBe(2);
  });

  it('busca por substring na ação ignorando maiúsculas/minúsculas (q)', async () => {
    await seedLog({ action: 'api:POST /orders/reserve' });
    await seedLog({ action: 'click:btn-buy' });
    await seedLog({ action: 'page:event/maratona' });

    const res = await service.listAsAdmin(query({ q: 'ORDERS' }));

    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].action).toBe('api:POST /orders/reserve');
  });

  it('busca por dados do usuário (userSearch) e exclui anônimos', async () => {
    // seedUser cria firstName "Fulano", lastName "de Teste", email único.
    const userId = await seedUser(prisma, 'USER');
    await seedLog({ userId, action: 'do-fulano' });
    await seedLog({ action: 'anonimo' }); // sem userId → deve ser excluído

    const res = await service.listAsAdmin(query({ userSearch: 'fulano' }));

    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].action).toBe('do-fulano');
    expect(res.data.items[0].userId).toBe(userId);
  });

  it('busca por nome completo (userSearch com várias palavras)', async () => {
    // seedUser cria firstName "Fulano" + lastName "de Teste" → o admin
    // digita o nome como vê na lista, "Fulano de Teste".
    const userId = await seedUser(prisma, 'USER');
    await seedLog({ userId, action: 'do-fulano' });
    await seedLog({ action: 'anonimo' });

    const res = await service.listAsAdmin(
      query({ userSearch: 'Fulano de Teste' })
    );

    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].userId).toBe(userId);
  });

  it('não casa quando alguma palavra do userSearch não bate', async () => {
    const userId = await seedUser(prisma, 'USER');
    await seedLog({ userId, action: 'do-fulano' });

    const res = await service.listAsAdmin(
      query({ userSearch: 'Fulano Inexistente' })
    );

    expect(res.data.items).toHaveLength(0);
    expect(res.data.pagination.total).toBe(0);
  });

  it('respeita paginação (page/limit) e total reflete TODOS os que casam', async () => {
    // 5 registros, datas crescentes para ordem determinística (desc no service).
    for (let i = 0; i < 5; i++) {
      await seedLog({
        action: `acao-${i}`,
        occurredAt: new Date(`2026-02-0${i + 1}T10:00:00.000Z`),
      });
    }

    const pagina1 = await service.listAsAdmin(query({ page: 1, limit: 2 }));
    const pagina2 = await service.listAsAdmin(query({ page: 2, limit: 2 }));
    const pagina3 = await service.listAsAdmin(query({ page: 3, limit: 2 }));

    // Ordem desc: acao-4 (mais novo) ... acao-0 (mais antigo).
    expect(pagina1.data.items.map((i) => i.action)).toEqual([
      'acao-4',
      'acao-3',
    ]);
    expect(pagina2.data.items.map((i) => i.action)).toEqual([
      'acao-2',
      'acao-1',
    ]);
    expect(pagina3.data.items.map((i) => i.action)).toEqual(['acao-0']);

    // total e totalPages olham o conjunto inteiro, não só a página.
    expect(pagina1.data.pagination.total).toBe(5);
    expect(pagina1.data.pagination.totalPages).toBe(3);
    expect(pagina1.data.pagination.page).toBe(1);
    expect(pagina1.data.pagination.limit).toBe(2);
  });

  it('limita o "limit" em no máximo 100', async () => {
    await seedLog({ action: 'unico' });

    const res = await service.listAsAdmin(query({ limit: 9999 }));

    expect(res.data.pagination.limit).toBe(100); // teto aplicado pelo service
    expect(res.data.items).toHaveLength(1);
  });

  it('registro anônimo (sem userId) volta com user = null', async () => {
    await seedLog({ action: 'anonimo' }); // sem userId

    const res = await service.listAsAdmin(query());

    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].userId).toBeNull();
    expect(res.data.items[0].user).toBeNull();
  });

  it('combina filtros com AND (categoria + IP)', async () => {
    await seedLog({
      category: UserActivityCategory.AUTH,
      ip: '187.45.10.2',
      action: 'alvo',
    });
    await seedLog({
      category: UserActivityCategory.AUTH,
      ip: '10.0.0.1',
      action: 'mesma-categoria-outro-ip',
    });
    await seedLog({
      category: UserActivityCategory.API,
      ip: '187.45.10.2',
      action: 'mesmo-ip-outra-categoria',
    });

    const res = await service.listAsAdmin(
      query({ category: UserActivityCategory.AUTH, ip: '187.45.10.2' }),
    );

    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].action).toBe('alvo');
  });

  it('sem resultados: lista vazia e total zero', async () => {
    await seedLog({ ip: '10.0.0.1' });

    const res = await service.listAsAdmin(query({ ip: '255.255.255.255' }));

    expect(res.data.items).toEqual([]);
    expect(res.data.pagination.total).toBe(0);
    expect(res.data.pagination.totalPages).toBe(0);
  });
});
