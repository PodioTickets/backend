/**
 * ROTEIRO — statsAsAdmin (GET /admin/user-activity/stats)
 * ========================================================
 * Dashboard de métricas do UserActivityLog. Adversarial: janela default de
 * 30 dias quando from/to ausentes (nunca varre a tabela inteira), filtros de
 * categoria/origem entram em TODAS as agregações, BigInt do COUNT raw vira
 * Number (JSON.stringify de BigInt lança), e os rankings saem ordenados.
 */
import { UserActivityAdminService } from '../user-activity-admin.service';

describe('UserActivityAdminService.statsAsAdmin — métricas do dashboard', () => {
  const build = () => {
    const count = jest
      .fn()
      .mockResolvedValueOnce(100) // total
      .mockResolvedValueOnce(40); // anônimos
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
    });
    // ordenado: CHECKOUT (60) antes de PAGE_VIEW (10)
    expect(res.data.byCategory[0]).toEqual({ category: 'CHECKOUT', count: 60 });
    expect(res.data.perDay).toEqual([{ day: '2026-06-01', count: 7 }]);
    // serializável (BigInt lançaria TypeError)
    expect(() => JSON.stringify(res)).not.toThrow();
  });

  it('to vira fim do dia (23:59:59.999 UTC) — `to` é inclusivo', async () => {
    const { service, count } = build();

    await service.statsAsAdmin({ to: '2026-06-02' });

    const lte: Date = count.mock.calls[0][0].where.occurredAt.lte;
    expect(lte.toISOString()).toBe('2026-06-02T23:59:59.999Z');
  });
});
