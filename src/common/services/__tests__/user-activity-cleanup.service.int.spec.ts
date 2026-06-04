/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: limpeza automática (cron) dos registros de atividade do usuário
 *           (UserActivityLog) — o "diário" de tudo que acontece no sistema
 *           (visitas de página, cliques, logins, checkouts, chamadas de API).
 *
 *  EM RESUMO:
 *    Esses registros NÃO devem ficar guardados para sempre. Existe uma política
 *    de RETENÇÃO em duas camadas:
 *      • Registros de AUDITORIA (login/AUTH, compra/CHECKOUT, conformidade/
 *        COMPLIANCE) ficam por 2 ANOS (730 dias) — servem de prova de
 *        transações financeiras e exigência legal (LGPD/Marco Civil/CDC).
 *      • Registros de ANALYTICS (visita de página, clique, API, perfil, outros)
 *        ficam por 90 DIAS — analytics de experiência não precisa de histórico
 *        longo, e a LGPD desestimula guardar além do necessário.
 *    A data que decide a idade do registro é o campo "occurredAt" (quando o
 *    evento aconteceu). O que for MAIS VELHO que o limite da sua camada é
 *    APAGADO; o que estiver DENTRO do limite é MANTIDO.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Analytics velho (mais de 90 dias) é apagado; analytics recente é mantido.
 *    • Auditoria com mais de 90 dias mas menos de 2 anos é MANTIDA (não cai na
 *      regra de analytics) — as camadas têm limites diferentes de propósito.
 *    • Auditoria com mais de 2 anos é apagada.
 *    • Bem na fronteira: registro mais novo que o corte sobrevive; mais velho
 *      que o corte morre.
 *    • Dá pra sobrescrever os limites por variável de ambiente
 *      (USER_ACTIVITY_RETENTION_DAYS_ANALYTICS / _AUDIT).
 *
 *  COMO CONFERIMOS:
 *    Este é um teste DE VERDADE contra um banco de dados de teste (descartável).
 *    Inserimos registros REAIS com datas "occurredAt" no passado (recentes e
 *    bem antigos), rodamos a limpeza e conferimos lendo o banco de volta
 *    (contando antes/depois e checando quais sobreviveram pela "action").
 *    Nada é "de faz-de-conta" — só o banco é separado, só para teste, limpo
 *    antes de cada cenário.
 * ============================================================================
 */
import { ConfigService } from '@nestjs/config';
import { UserActivityCategory, UserActivitySource } from '@prisma/client';
import { UserActivityCleanupService } from '../user-activity-cleanup.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { createTestPrisma, resetDb } from '../../testing/integration-db';

const DAY_MS = 86_400_000;

/** ConfigService stub: devolve os env vars de retenção passados no mapa. */
function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string) => overrides[key],
  } as unknown as ConfigService;
}

/** Data "X dias atrás" a partir de agora. */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

describe('UserActivityCleanupService (integração, banco real)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma); // banco limpo antes de cada cenário
  });

  /**
   * Helper: insere um UserActivityLog REAL com occurredAt explícito no passado.
   * `action` é a "etiqueta" usada depois pra saber quem sobreviveu.
   */
  const createLog = (params: {
    category: UserActivityCategory;
    occurredAt: Date;
    action: string;
  }) =>
    prisma.getWriteClient().userActivityLog.create({
      data: {
        source: UserActivitySource.FRONTEND,
        category: params.category,
        action: params.action,
        occurredAt: params.occurredAt,
      },
      select: { id: true, action: true },
    });

  /** Lê todas as actions que sobraram no banco (ordenadas pra comparação estável). */
  const remainingActions = async (): Promise<string[]> => {
    const rows = await prisma
      .getWriteClient()
      .userActivityLog.findMany({ select: { action: true } });
    return rows.map((r) => r.action).sort();
  };

  it('apaga analytics com mais de 90 dias e mantém analytics recente', async () => {
    const service = new UserActivityCleanupService(prisma, makeConfig());

    // ANALYTICS = qualquer categoria fora de AUTH/CHECKOUT/COMPLIANCE.
    await createLog({
      category: UserActivityCategory.PAGE_VIEW,
      occurredAt: daysAgo(120), // > 90d → deve sair
      action: 'analytics-velho',
    });
    await createLog({
      category: UserActivityCategory.CLICK,
      occurredAt: daysAgo(10), // < 90d → deve ficar
      action: 'analytics-recente',
    });

    const antes = await prisma.getWriteClient().userActivityLog.count();
    expect(antes).toBe(2);

    await service.runCleanup();

    const depois = await prisma.getWriteClient().userActivityLog.count();
    expect(depois).toBe(1);
    expect(await remainingActions()).toEqual(['analytics-recente']);
  });

  it('mantém auditoria com mais de 90 dias (limite de auditoria é 2 anos, não 90 dias)', async () => {
    const service = new UserActivityCleanupService(prisma, makeConfig());

    // Mesma idade (120d) mas categorias de AUDITORIA: limite delas é 730d,
    // então NÃO devem ser apagadas — prova que as camadas têm cortes distintos.
    await createLog({
      category: UserActivityCategory.AUTH,
      occurredAt: daysAgo(120),
      action: 'auth-120d',
    });
    await createLog({
      category: UserActivityCategory.CHECKOUT,
      occurredAt: daysAgo(120),
      action: 'checkout-120d',
    });
    await createLog({
      category: UserActivityCategory.COMPLIANCE,
      occurredAt: daysAgo(120),
      action: 'compliance-120d',
    });
    // Um analytics velho junto pra garantir que SÓ ele cai.
    await createLog({
      category: UserActivityCategory.API,
      occurredAt: daysAgo(120),
      action: 'api-analytics-120d',
    });

    expect(await prisma.getWriteClient().userActivityLog.count()).toBe(4);

    await service.runCleanup();

    // Os 3 de auditoria ficam; só o analytics cai.
    expect(await remainingActions()).toEqual([
      'auth-120d',
      'checkout-120d',
      'compliance-120d',
    ]);
  });

  it('apaga auditoria com mais de 2 anos (730 dias)', async () => {
    const service = new UserActivityCleanupService(prisma, makeConfig());

    await createLog({
      category: UserActivityCategory.AUTH,
      occurredAt: daysAgo(800), // > 730d → sai
      action: 'auth-muito-velho',
    });
    await createLog({
      category: UserActivityCategory.CHECKOUT,
      occurredAt: daysAgo(400), // < 730d → fica
      action: 'checkout-dentro-do-prazo',
    });

    expect(await prisma.getWriteClient().userActivityLog.count()).toBe(2);

    await service.runCleanup();

    expect(await remainingActions()).toEqual(['checkout-dentro-do-prazo']);
  });

  it('respeita a fronteira exata do corte (mais novo sobrevive, mais velho morre)', async () => {
    const service = new UserActivityCleanupService(prisma, makeConfig());

    // O corte é "occurredAt < agora - 90d". Pegamos pontos logo dos dois lados:
    // 89d (dentro, fica) e 91d (fora, sai). Margem de 1 dia evita flutuação
    // de relógio entre o cálculo do teste e o do serviço.
    await createLog({
      category: UserActivityCategory.OTHER,
      occurredAt: daysAgo(89),
      action: 'logo-antes-do-corte',
    });
    await createLog({
      category: UserActivityCategory.OTHER,
      occurredAt: daysAgo(91),
      action: 'logo-depois-do-corte',
    });

    await service.runCleanup();

    expect(await remainingActions()).toEqual(['logo-antes-do-corte']);
  });

  it('permite sobrescrever os limites por variável de ambiente', async () => {
    // Analytics agora 30 dias; auditoria agora 60 dias.
    const service = new UserActivityCleanupService(
      prisma,
      makeConfig({
        USER_ACTIVITY_RETENTION_DAYS_ANALYTICS: '30',
        USER_ACTIVITY_RETENTION_DAYS_AUDIT: '60',
      }),
    );

    await createLog({
      category: UserActivityCategory.PAGE_VIEW,
      occurredAt: daysAgo(45), // > 30d → sai (com o default de 90d ficaria)
      action: 'analytics-45d',
    });
    await createLog({
      category: UserActivityCategory.PAGE_VIEW,
      occurredAt: daysAgo(20), // < 30d → fica
      action: 'analytics-20d',
    });
    await createLog({
      category: UserActivityCategory.AUTH,
      occurredAt: daysAgo(70), // > 60d → sai (com o default de 730d ficaria)
      action: 'auth-70d',
    });
    await createLog({
      category: UserActivityCategory.AUTH,
      occurredAt: daysAgo(50), // < 60d → fica
      action: 'auth-50d',
    });

    expect(await prisma.getWriteClient().userActivityLog.count()).toBe(4);

    await service.runCleanup();

    expect(await remainingActions()).toEqual(['analytics-20d', 'auth-50d']);
  });
});
