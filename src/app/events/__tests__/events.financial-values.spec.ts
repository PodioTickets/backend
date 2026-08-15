import { EventsService } from '../events.service';
import { RepasseService } from '../../repasse/repasse.service';

/**
 * Valores corretos no FINANCIAL do organizador (GET /financial) por método de pagamento.
 *
 * Ponta a ponta: usa o calcBreakdown REAL (matemática de retenção/liberação do RepasseService)
 * e alimenta o mapeamento do EventsService.getFinancial, conferindo os campos que o organizador vê:
 *   - availableBalance      = sacável (saldoParaSaque) — NÃO inclui o 10% retido.
 *   - pendingRelease        = "aguardando liberação" = janela + 10% retido.
 *   - installmentsToReceive = parcelas futuras (parcelado).
 *
 * Regras travadas:
 *   PIX/DÉBITO  → 90% no saldo IMEDIATO + 10% retido (aguardando liberação).
 *   CRÉDITO À VISTA → dentro de 31d: 100% aguardando; após 31d: 90% saldo + 10% retido.
 *   PARCELADO   → SEM retenção; 100% dividido em N parcelas (31/62/93…d).
 *
 * Base: subtotal R$100 (10000c) + taxa 2% (200c) = total 10200c; orgFee 4% → orgNet 9600c.
 * retentionRate 10% → retido 960c, saldo 8640c.
 */
const FINAL = 10200;
const FEE = 200;
const ORG_NET = 9600;
const ORG_FEE = 4;
const RETENTION = 0.1;
const RETIDO = Math.round(ORG_NET * RETENTION); // 960
const SALDO_90 = ORG_NET - RETIDO; // 8640
const EVENT_ID = '999ef0df-a1a3-4e10-95eb-7b2b8df6f0c7';

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function mkOrder(opts: { daysAgo?: number; method?: string; installments?: number } = {}): any {
  const metadata: Record<string, any> =
    opts.installments && opts.installments > 1 ? { creditCard: { installments: opts.installments } } : {};
  return {
    id: `ord-${opts.method ?? 'X'}-${opts.daysAgo ?? 0}-${opts.installments ?? 1}`,
    finalAmount: FINAL,
    serviceFee: FEE,
    payment: {
      status: 'PAID',
      paymentDate: daysAgo(opts.daysAgo ?? 0),
      method: opts.method ?? 'PIX',
      metadata,
    },
  };
}

describe('EventsService.getFinancial — valores por método de pagamento (ponta a ponta)', () => {
  // RepasseService real só p/ exercitar o calcBreakdown (lógica pura, sem I/O).
  const repasseReal = new RepasseService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { record: jest.fn(), recordForEvent: jest.fn() } as any,
  );
  const breakdownFor = (orders: any[], audited = false) =>
    (repasseReal as any).calcBreakdown(orders, [], RETENTION, audited, [], ORG_FEE);

  // EventsService com computeBreakdownForEvent devolvendo o breakdown REAL calculado acima.
  const financialFor = async (orders: any[], audited = false) => {
    const breakdown = breakdownFor(orders, audited);
    const repasseService: any = {
      computeBreakdownForEvent: jest.fn().mockResolvedValue({
        breakdown,
        audit: audited ? { id: 'a1', createdAt: new Date() } : null,
        paidOrders: [],
        refundedOrders: [],
        completedWithdrawalsTotal: 0,
        organizerFeePercent: ORG_FEE,
      }),
    };
    const access: any = { assertCanAccessEvent: jest.fn().mockResolvedValue(undefined) };
    const ticketsService: any = { findAll: jest.fn().mockResolvedValue({ data: { tickets: [] } }) };
    const events = new EventsService(
      {} as any, access, {} as any, ticketsService, {} as any, {} as any, repasseService, {} as any,
    );
    const res = await events.getFinancial('user1', EVENT_ID, {} as any);
    return res.data.summary;
  };

  it('PIX recém-pago → 90% sacável imediato + 10% retido em aguardando liberação', async () => {
    const s = await financialFor([mkOrder({ method: 'PIX', daysAgo: 0 })]);
    expect(s.availableBalance).toBe(SALDO_90); // 8640 sacável
    expect(s.pendingRelease).toBe(RETIDO); // 960 aguardando (o retido)
    expect(s.awaitingAudit).toBe(RETIDO); // 960 sub-detalhe
    expect(s.installmentsToReceive).toBe(0);
  });

  it('DÉBITO recém-pago → idêntico ao PIX (90% imediato + 10% retido)', async () => {
    const s = await financialFor([mkOrder({ method: 'DEBIT_CARD', daysAgo: 0 })]);
    expect(s.availableBalance).toBe(SALDO_90);
    expect(s.pendingRelease).toBe(RETIDO);
  });

  it('CRÉDITO À VISTA dentro de 31 dias → 100% aguardando liberação, nada sacável', async () => {
    const s = await financialFor([mkOrder({ method: 'CREDIT_CARD', daysAgo: 5 })]);
    expect(s.availableBalance).toBe(0);
    expect(s.pendingRelease).toBe(ORG_NET); // 9600 (janela inteira)
    expect(s.awaitingAudit).toBe(0); // ainda não foi pro retido
    expect(s.installmentsToReceive).toBe(0);
  });

  it('CRÉDITO À VISTA após 31 dias → 90% sacável + 10% retido em aguardando', async () => {
    const s = await financialFor([mkOrder({ method: 'CREDIT_CARD', daysAgo: 40 })]);
    expect(s.availableBalance).toBe(SALDO_90); // 8640
    expect(s.pendingRelease).toBe(RETIDO); // 960
  });

  it('PARCELADO 3x recém-pago → 100% em parcelas a receber, SEM retido, nada em aguardando', async () => {
    const s = await financialFor([mkOrder({ method: 'CREDIT_CARD', daysAgo: 0, installments: 3 })]);
    expect(s.availableBalance).toBe(0);
    expect(s.pendingRelease).toBe(0); // parcelado não retém → não entra em aguardando
    expect(s.awaitingAudit).toBe(0);
    expect(s.installmentsToReceive).toBe(ORG_NET); // 9600 (todas as parcelas futuras)
  });

  it('PARCELADO 3x com 1ª parcela vencida (35 dias) → 1/3 sacável, 2/3 a receber', async () => {
    const s = await financialFor([mkOrder({ method: 'CREDIT_CARD', daysAgo: 35, installments: 3 })]);
    const parcela = Math.floor(ORG_NET / 3); // 3200
    expect(s.availableBalance).toBe(parcela); // 3200 (1ª parcela liberada)
    expect(s.installmentsToReceive).toBe(ORG_NET - parcela); // 6400 (2ª + 3ª)
    expect(s.pendingRelease).toBe(0); // sem retenção no parcelado
  });

  it('PIX auditado → 10% liberado: 100% sacável, nada em aguardando', async () => {
    const s = await financialFor([mkOrder({ method: 'PIX', daysAgo: 0 })], true);
    expect(s.availableBalance).toBe(ORG_NET); // 9600 (retido liberado pela auditoria)
    expect(s.pendingRelease).toBe(0);
    expect(s.isAudited).toBe(true);
  });
});
