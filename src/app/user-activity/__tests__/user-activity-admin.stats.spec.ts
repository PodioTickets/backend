/**
 * ROTEIRO — statsAsAdmin (GET /admin/user-activity/stats)
 * ========================================================
 * Dashboard de métricas do UserActivityLog. Adversarial: janela default de
 * 30 dias quando from/to ausentes (nunca varre a tabela inteira), filtros de
 * categoria/origem entram em TODAS as agregações, BigInt do COUNT raw vira
 * Number (JSON.stringify de BigInt lança), e os rankings saem ordenados.
 */
import {
  PURCHASE_FUNNEL_STAGES,
  UserActivityAdminService,
} from '../user-activity-admin.service';

describe('UserActivityAdminService.statsAsAdmin — métricas do dashboard', () => {
  const build = () => {
    const count = jest
      .fn()
      .mockResolvedValueOnce(100) // total
      .mockResolvedValueOnce(40) // anônimos
      .mockResolvedValueOnce(25) // eventPageViews (action page:event)
      .mockResolvedValueOnce(8); // paymentsConfirmed (action order.paid)
    const groupBy = jest.fn().mockImplementation(({ by }: any) => {
      if (by[0] === 'category') {
        return Promise.resolve([
          { category: 'PAGE_VIEW', _count: { _all: 10 } },
          { category: 'CHECKOUT', _count: { _all: 60 } },
        ]);
      }
      if (by[0] === 'source') {
        return Promise.resolve([
          { source: 'FRONTEND', _count: { _all: 90 } },
          { source: 'BACKEND', _count: { _all: 10 } },
        ]);
      }
      if (by[0] === 'action') {
        return Promise.resolve([
          { action: 'page:home', _count: { _all: 50 } },
        ]);
      }
      if (by[0] === 'userId') {
        return Promise.resolve([{ userId: 'u1' }, { userId: 'u2' }]);
      }
      return Promise.resolve([{ sessionId: 's1' }]);
    });
    const $queryRaw = jest.fn().mockResolvedValue([
      { day: new Date('2026-06-01T00:00:00.000Z'), count: BigInt(7) },
    ]);
    const client: any = { userActivityLog: { count, groupBy }, $queryRaw };
    const prisma: any = { getReadClient: () => client };
    const service = new UserActivityAdminService(prisma);
    return { service, count, groupBy, $queryRaw };
  };

  it('sem from/to → janela default de ~30 dias no where', async () => {
    const { service, count } = build();

    await service.statsAsAdmin({});

    const where = count.mock.calls[0][0].where;
    const gte: Date = where.occurredAt.gte;
    const lte: Date = where.occurredAt.lte;
    const days = (lte.getTime() - gte.getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(31);
  });

  it('category/source entram no where das agregações Prisma', async () => {
    const { service, count, groupBy } = build();

    await service.statsAsAdmin({
      category: 'CHECKOUT' as any,
      source: 'FRONTEND' as any,
    });

    expect(count.mock.calls[0][0].where.category).toBe('CHECKOUT');
    expect(count.mock.calls[0][0].where.source).toBe('FRONTEND');
    // groupBy de categoria também recebe os filtros
    const catCall = groupBy.mock.calls.find((c: any[]) => c[0].by[0] === 'category');
    expect(catCall[0].where.category).toBe('CHECKOUT');
  });

  it('payload: rankings ordenados desc, únicos contados e BigInt convertido', async () => {
    const { service } = build();

    const res = await service.statsAsAdmin({});

    expect(res.data.totals).toEqual({
      events: 100,
      uniqueUsers: 2,
      uniqueSessions: 1,
      anonymousEvents: 40,
      eventPageViews: 25,
      paymentsConfirmed: 8,
    });
    // ordenado: CHECKOUT (60) antes de PAGE_VIEW (10)
    expect(res.data.byCategory[0]).toEqual({ category: 'CHECKOUT', count: 60 });
    expect(res.data.perDay).toEqual([{ day: '2026-06-01', count: 7 }]);
    // viewsPerDay também sai convertida (mesmo mock do $queryRaw)
    expect(res.data.viewsPerDay).toEqual([{ day: '2026-06-01', count: 7 }]);
    // serializável (BigInt lançaria TypeError)
    expect(() => JSON.stringify(res)).not.toThrow();
  });

  it('eventId entra como filtro JSONB nas agregações Prisma', async () => {
    const { service, count } = build();
    const eventId = '11111111-2222-4333-8444-555555555555';

    await service.statsAsAdmin({ eventId });

    // total (recorte geral) e métricas fixas (page views / paid) filtram pelo evento
    expect(count.mock.calls[0][0].where.metadata).toEqual({
      path: ['eventId'],
      equals: eventId,
    });
    expect(count.mock.calls[2][0].where.metadata).toEqual({
      path: ['eventId'],
      equals: eventId,
    });
  });

  it('métricas fixas (views/paid) IGNORAM category/source — só período+eventId', async () => {
    const { service, count } = build();

    await service.statsAsAdmin({ category: 'AUTH' as any });

    // recorte geral respeita a categoria…
    expect(count.mock.calls[0][0].where.category).toBe('AUTH');
    // …mas o contador de views da página de evento não (semântica fixa)
    expect(count.mock.calls[2][0].where.category).toBeUndefined();
    expect(count.mock.calls[2][0].where.action).toBe('page:event');
    expect(count.mock.calls[3][0].where.action).toBe('order.paid');
  });

  it('to vira fim do dia (23:59:59.999 UTC) — `to` é inclusivo', async () => {
    const { service, count } = build();

    await service.statsAsAdmin({ to: '2026-06-02' });

    const lte: Date = count.mock.calls[0][0].where.occurredAt.lte;
    expect(lte.toISOString()).toBe('2026-06-02T23:59:59.999Z');
  });
});

describe('UserActivityAdminService.funnelAsAdmin — funil de compra', () => {
  const build = (rows: Array<{ action: string; total: bigint; uniq: bigint }>) => {
    const $queryRaw = jest.fn().mockResolvedValue(rows);
    const client: any = { $queryRaw };
    const prisma: any = { getReadClient: () => client };
    const service = new UserActivityAdminService(prisma);
    return { service, $queryRaw };
  };

  it('etapas saem na ordem canônica com zero-fill e BigInt convertido', async () => {
    const { service } = build([
      // fora de ordem de propósito + etapas faltando (billing/pay sem linhas)
      { action: 'order.paid', total: BigInt(3), uniq: BigInt(2) },
      { action: 'page:event', total: BigInt(100), uniq: BigInt(80) },
      { action: 'order.reserve', total: BigInt(12), uniq: BigInt(10) },
    ]);

    const res = await service.funnelAsAdmin({});

    expect(res.data.stages.map((s) => s.action)).toEqual([
      ...PURCHASE_FUNNEL_STAGES,
    ]);
    expect(res.data.stages[0]).toEqual({
      action: 'page:event',
      total: 100,
      unique: 80,
    });
    // etapa sem registro → zero-fill (front não lida com etapa ausente)
    expect(res.data.stages[2]).toEqual({
      action: 'order.billing-address',
      total: 0,
      unique: 0,
    });
    expect(() => JSON.stringify(res)).not.toThrow();
  });

  it('com eventId → SQL com join em Order e o id nos parâmetros', async () => {
    const eventId = '11111111-2222-4333-8444-555555555555';
    const { service, $queryRaw } = build([]);

    const res = await service.funnelAsAdmin({ eventId });

    // Prisma.sql: template com strings + values — o id precisa estar bound
    // como parâmetro (nunca interpolado na string).
    const sqlArg = $queryRaw.mock.calls[0][0];
    expect(sqlArg.values).toContain(eventId);
    expect(sqlArg.sql ?? sqlArg.strings?.join('')).toContain('LEFT JOIN "Order"');
    expect(res.data.eventId).toBe(eventId);
  });

  it('sem from/to → janela default de ~30 dias', async () => {
    const { service, $queryRaw } = build([]);

    await service.funnelAsAdmin({});

    const sqlArg = $queryRaw.mock.calls[0][0];
    const dates = (sqlArg.values as unknown[]).filter(
      (v): v is Date => v instanceof Date,
    );
    expect(dates).toHaveLength(2);
    const days =
      Math.abs(dates[1].getTime() - dates[0].getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(31);
  });
});
