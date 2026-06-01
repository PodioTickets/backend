import { EventsService } from '../events.service';

/**
 * GET /financial → summary.pendingRelease ("aguardando liberação" do organizador) deve incluir
 * o 10% retido (valorRetido), além do que está na janela de compensação (aguardandoLiberacao).
 * Vale p/ métodos à vista (PIX/débito/crédito à vista); parcelado não retém → não entra.
 * availableBalance (sacável) NÃO inclui o retido.
 */
describe('EventsService.getFinancial — aguardando liberação inclui o retido', () => {
  const EVENT_ID = '999ef0df-a1a3-4e10-95eb-7b2b8df6f0c7';

  const buildService = (breakdown: any, audit: any = null) => {
    const repasseService: any = {
      computeBreakdownForEvent: jest.fn().mockResolvedValue({
        breakdown,
        audit,
        paidOrders: [],
        refundedOrders: [],
        completedWithdrawalsTotal: 0,
        organizerFeePercent: 4,
      }),
    };
    const access: any = { assertCanAccessEvent: jest.fn().mockResolvedValue(undefined) };
    const ticketsService: any = { findAll: jest.fn().mockResolvedValue({ data: { tickets: [] } }) };
    const service = new EventsService(
      {} as any, access, {} as any, ticketsService, {} as any, {} as any, repasseService, {} as any,
    );
    return service;
  };

  const baseBreakdown = {
    saldoParaSaque: 9000,
    aguardandoLiberacao: 0,
    valorRetido: 1000,
    parceladosAReceber: 0,
    grossRevenue: 10200,
  };

  it('PIX/débito (liberação imediata): retido 10% entra em pendingRelease, fora do saldo', async () => {
    const service = buildService(baseBreakdown);

    const res = await service.getFinancial('user1', EVENT_ID, {} as any);
    const s = res.data.summary;

    expect(s.pendingRelease).toBe(1000); // aguardando(0) + retido(1000)
    expect(s.awaitingAudit).toBe(1000); // sub-detalhe
    expect(s.availableBalance).toBe(9000); // 90% sacável, sem o retido
  });

  it('dentro da janela (ex.: crédito à vista) + retido de outro pedido → soma os dois', async () => {
    const service = buildService({
      ...baseBreakdown,
      aguardandoLiberacao: 5000, // pedido ainda na janela (100%)
      valorRetido: 1000, // outro pedido já fora da janela (10%)
    });

    const res = await service.getFinancial('user1', EVENT_ID, {} as any);
    expect(res.data.summary.pendingRelease).toBe(6000);
  });

  it('parcelado (sem retido) → nada em pendingRelease, vai pra installmentsToReceive', async () => {
    const service = buildService({
      ...baseBreakdown,
      aguardandoLiberacao: 0,
      valorRetido: 0,
      parceladosAReceber: 8000,
    });

    const res = await service.getFinancial('user1', EVENT_ID, {} as any);
    expect(res.data.summary.pendingRelease).toBe(0);
    expect(res.data.summary.installmentsToReceive).toBe(8000);
  });

  it('auditado: retido já liberado (0) → pendingRelease 0, tudo sacável', async () => {
    const service = buildService(
      { ...baseBreakdown, saldoParaSaque: 10000, aguardandoLiberacao: 0, valorRetido: 0 },
      { id: 'audit1', createdAt: new Date('2026-01-01') },
    );

    const res = await service.getFinancial('user1', EVENT_ID, {} as any);
    expect(res.data.summary.pendingRelease).toBe(0);
    expect(res.data.summary.availableBalance).toBe(10000);
    expect(res.data.summary.isAudited).toBe(true);
  });
});
