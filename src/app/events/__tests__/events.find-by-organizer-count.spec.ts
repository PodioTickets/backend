import { EventsService } from '../events.service';
import { RegistrationStatus } from '@prisma/client';

/**
 * GET /organizers/me/events → findByOrganizer: o _count.registrations deve contar APENAS
 * inscrições válidas/pagas (CONFIRMED + COMPLETED), excluindo PENDING e CANCELLED — que
 * cobre também estorno e chargeback (ambos rebaixam a inscrição para CANCELLED).
 *
 * Instancia o service direto com mocks (o TestingModule completo exige 8 deps; aqui só
 * precisamos das 2 que findByOrganizer usa).
 */
describe('EventsService.findByOrganizer — _count.registrations só CONFIRMED/COMPLETED', () => {
  const buildService = () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const groupBy = jest.fn().mockResolvedValue([]);
    const prisma: any = {
      getReadClient: () => ({ event: { findMany, count }, order: { groupBy } }),
    };
    const access: any = {
      getMemberForOrganizerUser: jest.fn().mockResolvedValue({ organizationId: 'org1' }),
      buildOrganizerEventsWhere: jest.fn().mockReturnValue({ organizationId: 'org1' }),
    };
    const service = new EventsService(prisma, access, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { service, findMany };
  };

  it('passa o filtro de status no _count.registrations (filtered relation count)', async () => {
    const { service, findMany } = buildService();

    await service.findByOrganizer('user1', { page: 1, limit: 10 });

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.select._count.select.registrations).toEqual({
      where: { status: { in: [RegistrationStatus.CONFIRMED, RegistrationStatus.COMPLETED] } },
    });
  });

  it('mantém a contagem de modalities sem filtro (true)', async () => {
    const { service, findMany } = buildService();

    await service.findByOrganizer('user1', {});

    const arg = findMany.mock.calls[0][0];
    expect(arg.select._count.select.modalities).toBe(true);
  });

  it('totalSales = receita LÍQUIDA (desconta serviceFee + organizerFeePercent), não bruta', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'evt-1', name: 'E1', eventDate: new Date('2020-01-01'), status: 'COMPLETED' }]);
    const count = jest.fn().mockResolvedValue(1);
    // Net já calculado pelo SQL (centavos). 9000 = ex.: 10000 bruto − fees.
    const queryRaw = jest.fn().mockResolvedValue([{ eventId: 'evt-1', net: BigInt(9000) }]);
    const prisma: any = {
      getReadClient: () => ({ event: { findMany, count }, $queryRaw: queryRaw }),
    };
    const access: any = {
      getMemberForOrganizerUser: jest.fn().mockResolvedValue({ organizationId: 'org1' }),
      buildOrganizerEventsWhere: jest.fn().mockReturnValue({ organizationId: 'org1' }),
    };
    const service = new EventsService(prisma, access, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    const res: any = await service.findByOrganizer('user1', {});

    // totalSales vem do `net` da query (líquido), não do finalAmount bruto.
    const evt = res.data.events.find((e: any) => e.id === 'evt-1');
    expect(evt.totalSales).toBe(9000);

    // A query deve descontar serviceFee E organizerFeePercent — senão é BRUTO.
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sqlArg: any = queryRaw.mock.calls[0][0];
    const sqlText: string = sqlArg?.sql ?? (sqlArg?.strings ? sqlArg.strings.join(' ? ') : '');
    expect(sqlText).toMatch(/serviceFee/);
    expect(sqlText).toMatch(/organizerFeePercent/);
    // não pode somar o finalAmount cru (bruto)
    expect(sqlText).not.toMatch(/SUM\(\s*o\."finalAmount"\s*\)/);
  });
});
