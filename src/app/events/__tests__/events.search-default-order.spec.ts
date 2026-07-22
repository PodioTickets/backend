import { EventsService } from '../events.service';

/**
 * GET /events/search — ORDEM PADRÃO do catálogo público:
 *  1. eventos que ainda vão acontecer, do mais PRÓXIMO ao mais distante
 *     (destaque do admin primeiro, como já era);
 *  2. eventos CONCLUÍDOS sempre no FIM (mais recente antes).
 *
 * Antes era `eventDate asc` puro: como concluído tem a data mais antiga, ele
 * subia para o topo da busca.
 *
 * "Concluído" não é coluna (é derivado de `eventDate` — ver `event-status.util`),
 * então a página é montada a partir de DOIS blocos. O risco real está na
 * matemática de skip/take na fronteira entre eles — é o que estes testes travam.
 *
 * Instancia o service direto com mocks (só o read client é usado por `search`).
 */
describe('EventsService.search — ordem padrão (concluídos por último)', () => {
  /** @param upcomingTotal quantos eventos futuros existem no filtro */
  const buildService = (upcomingTotal: number, completedTotal: number) => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest
      .fn()
      // 1ª chamada = futuros, 2ª = concluídos (ordem do Promise.all no service).
      .mockResolvedValueOnce(upcomingTotal)
      .mockResolvedValueOnce(completedTotal);
    const prisma: any = { getReadClient: () => ({ event: { findMany, count } }) };
    const service = new EventsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, findMany, count };
  };

  it('página cheia de futuros: não consulta o bloco de concluídos', async () => {
    const { service, findMany } = buildService(50, 7);

    const res: any = await service.search({ page: 1, limit: 20 } as any);

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.skip).toBe(0);
    expect(arg.take).toBe(20);
    expect(arg.orderBy[0]).toEqual({ featuredOrder: { sort: 'asc', nulls: 'last' } });
    expect(arg.orderBy[1]).toEqual({ eventDate: 'asc' });
    // total = futuros + concluídos (a paginação enxerga a lista inteira).
    expect(res.data.pagination.total).toBe(57);
    expect(res.data.pagination.totalPages).toBe(3);
  });

  it('página que ATRAVESSA a fronteira: completa com concluídos, sem pular nem repetir', async () => {
    // 5 futuros, 10 concluídos, página 2 de 4 → itens 4..7 = 2 futuros + 2 concluídos.
    const { service, findMany } = buildService(5, 10);

    await service.search({ page: 2, limit: 4 } as any);

    expect(findMany).toHaveBeenCalledTimes(2);
    const upcoming = findMany.mock.calls[0][0];
    const completed = findMany.mock.calls[1][0];
    expect(upcoming.skip).toBe(4);
    expect(upcoming.take).toBe(1); // só resta 1 futuro (o 5º)
    expect(completed.skip).toBe(0); // primeiro concluído
    expect(completed.take).toBe(3);
    // Entre concluídos, o mais recente primeiro — destaque não promove concluído.
    expect(completed.orderBy).toEqual([{ eventDate: 'desc' }, { id: 'asc' }]);
  });

  it('página inteiramente depois da fronteira: só concluídos, com skip descontado', async () => {
    // 5 futuros, 10 concluídos, página 3 de 4 → itens 8..11 = concluídos 3..6.
    const { service, findMany } = buildService(5, 10);

    await service.search({ page: 3, limit: 4 } as any);

    expect(findMany).toHaveBeenCalledTimes(1);
    const completed = findMany.mock.calls[0][0];
    expect(completed.skip).toBe(3); // 8 - 5 futuros
    expect(completed.take).toBe(4);
  });

  it('os dois blocos partem do MESMO where (só diferem no corte de eventDate)', async () => {
    const { service, findMany } = buildService(1, 1);

    await service.search({ page: 1, limit: 2 } as any);

    const [upcoming, completed] = findMany.mock.calls.map((c) => c[0]);
    // where = { AND: [whereBase, { eventDate: <corte> }] }
    expect(upcoming.where.AND[0]).toEqual(completed.where.AND[0]);
    const cutoff = upcoming.where.AND[1].eventDate.gte;
    expect(completed.where.AND[1].eventDate.lt).toEqual(cutoff);
    // Mesma projeção nos dois blocos (a página é homogênea).
    expect(upcoming.select).toEqual(completed.select);
  });
});
