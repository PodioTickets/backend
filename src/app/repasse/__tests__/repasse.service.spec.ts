import { Test, TestingModule } from '@nestjs/testing';
import { RepasseService } from '../repasse.service';
import { REFUND_FEE_RATE } from '../../../common/utils/refund.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrganizerMemberAccessService } from '../../organizations/organizer-member-access.service';
import { EmailService } from '../../../common/services/email.service';
import { PaymentsRefundService } from '../../payments/payments-refund.service';

/**
 * Regra de dinheiro do repasse — foco no ESTORNO (refund) após a correção do
 * double-count. Trava os números do roteiro de smoke:
 *
 *   Exemplo base: subtotal R$100 (10000c) + taxa serviço 2% (200c) = total R$102 (10200c);
 *   organizerFeePercent 4% → orgNet = round(10000 * 0.96) = 9600c.
 *   Taxa de refund = round(10000 * 0.02) = 200c.
 *
 * Princípio: o orgNet do pedido estornado NÃO é re-subtraído (ele some ao sair de
 * `paidOrders`); o saldo só fica negativo quando o organizador já sacou; a única
 * dedução explícita é a taxa de refund de 2% sobre o subtotal.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

const FINAL = 10200; // total pago (centavos)
const FEE = 200; // taxa de serviço (centavos)
const ORG_NET = 9600; // orgNet esperado (96.00) com orgFee 4%
const REFUND_FEE = 200; // 2% de 10000 (subtotal)
const RETENTION = 0.1; // 10%
const ORG_FEE = 4; // organizerFeePercent

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function mkOrder(opts: {
  daysAgo?: number;
  method?: string;
  status?: 'PAID' | 'REFUNDED';
  installments?: number;
  finalAmount?: number;
  serviceFee?: number;
  meta?: Record<string, any>;
} = {}): any {
  const metadata: Record<string, any> = {
    ...(opts.installments && opts.installments > 1
      ? { creditCard: { installments: opts.installments } }
      : {}),
    ...(opts.meta ?? {}),
  };
  return {
    id: `ord-${Math.round(opts.daysAgo ?? 0)}-${opts.status ?? 'PAID'}-${opts.method ?? 'CREDIT_CARD'}-${opts.installments ?? 1}`,
    finalAmount: opts.finalAmount ?? FINAL,
    serviceFee: opts.serviceFee ?? FEE,
    payment: {
      status: opts.status ?? 'PAID',
      paymentDate: daysAgo(opts.daysAgo ?? 5),
      method: opts.method ?? 'CREDIT_CARD',
      metadata,
    },
  };
}

const wd = (netAmount: number, status: 'COMPLETED' | 'PENDING' = 'COMPLETED') => ({
  status,
  netAmount,
});

describe('RepasseService — lógica de estorno (calcBreakdown)', () => {
  let service: RepasseService;

  const mockPrisma = {
    getWriteClient: jest.fn(),
    getReadClient: jest.fn(),
  };
  const mockAccess = { assertCanAccessEvent: jest.fn().mockResolvedValue(undefined) };
  const mockEmail = {
    sendTransferRequested: jest.fn(),
    sendTransferConfirmed: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RepasseService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrganizerMemberAccessService, useValue: mockAccess },
        { provide: EmailService, useValue: mockEmail },
        { provide: PaymentsRefundService, useValue: { refundOrder: jest.fn() } },
      ],
    }).compile();
    service = module.get<RepasseService>(RepasseService);
  });

  // Acesso direto ao método privado (lógica pura, sem I/O).
  const calc = (paid: any[], refunded: any[], audited: boolean, withdrawals: any[] = []) =>
    (service as any).calcBreakdown(paid, refunded, RETENTION, audited, withdrawals, ORG_FEE);

  it('a taxa de refund é fixa em 2%', () => {
    expect(REFUND_FEE_RATE).toBe(0.02);
  });

  describe('contribuições positivas (sanidade — não pode regredir)', () => {
    it('à vista dentro da janela → 100% em aguardando liberação', () => {
      const b = calc([mkOrder({ daysAgo: 5 })], [], false);
      expect(b.aguardandoLiberacao).toBe(ORG_NET);
      expect(b.valorRetido).toBe(0);
      expect(b.saldoDisponivel).toBe(0);
    });

    it('à vista fora da janela, não auditado → 10% retido + 90% saldo', () => {
      const b = calc([mkOrder({ daysAgo: 40 })], [], false);
      expect(b.aguardandoLiberacao).toBe(0);
      expect(b.valorRetido).toBe(Math.round(ORG_NET * RETENTION)); // 960
      expect(b.saldoDisponivel).toBe(ORG_NET - Math.round(ORG_NET * RETENTION)); // 8640
    });

    it('à vista fora da janela, auditado → 100% no saldo', () => {
      const b = calc([mkOrder({ daysAgo: 40 })], [], true);
      expect(b.saldoDisponivel).toBe(ORG_NET);
      expect(b.valorRetido).toBe(0);
    });

    it('parcelado (3x) recém-pago → tudo em parcelados a receber, sem retenção', () => {
      const b = calc([mkOrder({ daysAgo: 0, installments: 3 })], [], false);
      expect(b.parceladosAReceber).toBe(ORG_NET);
      expect(b.valorRetido).toBe(0);
      expect(b.saldoDisponivel).toBe(0);
    });

    // PIX e DÉBITO: janela 0 → liberação dos 90% IMEDIATA na confirmação (sem aguardando).
    it('PIX recém-pago (mesmo dia), não auditado → 90% no saldo + 10% retido IMEDIATAMENTE', () => {
      const b = calc([mkOrder({ daysAgo: 0, method: 'PIX' })], [], false);
      expect(b.aguardandoLiberacao).toBe(0); // sem janela de espera
      expect(b.valorRetido).toBe(Math.round(ORG_NET * RETENTION)); // 960 (aguardando auditoria)
      expect(b.saldoDisponivel).toBe(ORG_NET - Math.round(ORG_NET * RETENTION)); // 8640 liberado
    });

    it('DÉBITO recém-pago (mesmo dia), não auditado → 90% no saldo + 10% retido IMEDIATAMENTE', () => {
      const b = calc([mkOrder({ daysAgo: 0, method: 'DEBIT_CARD' })], [], false);
      expect(b.aguardandoLiberacao).toBe(0);
      expect(b.valorRetido).toBe(Math.round(ORG_NET * RETENTION));
      expect(b.saldoDisponivel).toBe(ORG_NET - Math.round(ORG_NET * RETENTION));
    });

    it('PIX recém-pago, auditado → 100% no saldo (sem retenção, sem aguardando)', () => {
      const b = calc([mkOrder({ daysAgo: 0, method: 'PIX' })], [], true);
      expect(b.aguardandoLiberacao).toBe(0);
      expect(b.valorRetido).toBe(0);
      expect(b.saldoDisponivel).toBe(ORG_NET);
    });
  });

  describe('estorno — roteiro de smoke', () => {
    // Caso A
    it('A) estorno DENTRO da janela, não auditado, sem saque → só a taxa de refund (-200)', () => {
      const b = calc([], [mkOrder({ daysAgo: 5, status: 'REFUNDED' })], false);
      expect(b.aguardandoLiberacao).toBe(0);
      expect(b.saldoDisponivel).toBe(-REFUND_FEE);
      expect(b.saldoParaSaque).toBe(-REFUND_FEE);
    });

    // Caso B
    it('B) estorno após liberar e SACAR 9600, auditado → -9800 (saque a descoberto + taxa)', () => {
      const b = calc([], [mkOrder({ daysAgo: 40, status: 'REFUNDED' })], true, [wd(ORG_NET)]);
      expect(b.saldoDisponivel).toBe(-REFUND_FEE);
      expect(b.totalWithdrawn).toBe(ORG_NET);
      expect(b.saldoParaSaque).toBe(-(ORG_NET + REFUND_FEE)); // -9800
    });

    // Caso C
    it('C) estorno liberado mas NÃO sacado, auditado → só a taxa (-200)', () => {
      const b = calc([], [mkOrder({ daysAgo: 40, status: 'REFUNDED' })], true, []);
      expect(b.saldoDisponivel).toBe(-REFUND_FEE);
      expect(b.saldoParaSaque).toBe(-REFUND_FEE);
    });

    // Caso D
    it('D) dois dentro da janela, 1 estornado → válido intacto em aguardando, saldo só com a taxa', () => {
      const b = calc(
        [mkOrder({ daysAgo: 5 })],
        [mkOrder({ daysAgo: 5, status: 'REFUNDED' })],
        false,
      );
      expect(b.aguardandoLiberacao).toBe(ORG_NET); // o pedido válido não é tocado
      expect(b.saldoDisponivel).toBe(-REFUND_FEE);
      expect(b.saldoParaSaque).toBe(-REFUND_FEE);
    });

    // Caso E — outros métodos
    it('E1) estorno PARCELADO → parcelas somem, só a taxa de refund (-200)', () => {
      const b = calc([], [mkOrder({ daysAgo: 5, status: 'REFUNDED', installments: 3 })], false);
      expect(b.parceladosAReceber).toBe(0);
      expect(b.saldoDisponivel).toBe(-REFUND_FEE);
      expect(b.saldoParaSaque).toBe(-REFUND_FEE);
    });

    it('E2) estorno PIX → mesma regra, só a taxa de refund (-200)', () => {
      const b = calc([], [mkOrder({ daysAgo: 5, status: 'REFUNDED', method: 'PIX' })], true);
      expect(b.saldoDisponivel).toBe(-REFUND_FEE);
      expect(b.saldoParaSaque).toBe(-REFUND_FEE);
    });

    it('CHARGEBACK também cobra a taxa de refund de 2% (é um tipo de estorno)', () => {
      const b = calc(
        [],
        [mkOrder({ daysAgo: 5, status: 'REFUNDED', meta: { refundType: 'CHARGEBACK' } })],
        true,
      );
      expect(b.saldoDisponivel).toBe(-REFUND_FEE);
      expect(b.saldoParaSaque).toBe(-REFUND_FEE);
    });
  });

  describe('regressão — o double-count NÃO pode voltar', () => {
    it('estorno de pedido nunca recebido nem sacado não derruba o saldo pelo orgNet', () => {
      const b = calc([], [mkOrder({ daysAgo: 5, status: 'REFUNDED' })], false);
      // Antes do fix dava -9600 (orgNet). Agora só a taxa de refund.
      expect(b.saldoParaSaque).not.toBe(-ORG_NET);
      expect(b.saldoParaSaque).toBe(-REFUND_FEE);
    });

    it('múltiplos estornos só somam taxas de refund (sem cobrar orgNet de novo)', () => {
      const refunded = [
        mkOrder({ daysAgo: 5, status: 'REFUNDED' }),
        mkOrder({ daysAgo: 40, status: 'REFUNDED' }),
        mkOrder({ daysAgo: 5, status: 'REFUNDED', installments: 3 }),
      ];
      const b = calc([], refunded, false);
      expect(b.saldoParaSaque).toBe(-REFUND_FEE * 3); // -600, nada de orgNet
    });
  });

  describe('antecipação — move de aguardando/parcelas p/ saldo disponível', () => {
    // calcBreakdown(paid, refunded, retention, audited, withdrawals, orgFee, refundFeeRate, anticipations)
    const calcA = (paid: any[], audited: boolean, anticipations: any[]) =>
      (service as any).calcBreakdown(paid, [], RETENTION, audited, [], ORG_FEE, undefined, anticipations);

    it('à vista na janela antecipada: sai de aguardando e o LÍQUIDO entra no saldo', () => {
      const order = mkOrder({ daysAgo: 5 }); // à vista em janela → aguardando ORG_NET
      const anticipation = { netAmount: 9000, breakdown: [{ unitId: order.id, gross: ORG_NET }] };
      const b = calcA([order], false, [anticipation]);
      expect(b.aguardandoLiberacao).toBe(0); // saiu de aguardando (ORG_NET − ORG_NET)
      expect(b.saldoDisponivel).toBe(9000); // líquido antecipado
      expect(b.saldoParaSaque).toBe(9000); // sacável via repasse
    });

    it('à vista JÁ liberada e antecipada NÃO conta duas vezes no saldo', () => {
      const order = mkOrder({ daysAgo: 60 }); // fora da janela → normalmente saldo ORG_NET
      const anticipation = { netAmount: 9000, breakdown: [{ unitId: order.id, gross: ORG_NET }] };
      const b = calcA([order], true, [anticipation]); // audited → sem 10% retido
      // ORG_NET excluído do saldo (não vem de novo) + líquido antecipado = 9000 (não 9600+9000).
      expect(b.saldoDisponivel).toBe(9000);
    });

    it('parcela futura antecipada sai de parcelados e o líquido entra no saldo', () => {
      const order = mkOrder({ daysAgo: 5, installments: 3 });
      order.payment.id = 'pay-x'; // chave da parcela = `${payment.id}-inst-N`
      // orgNet ORG_NET/3 por parcela; antecipa a 1ª parcela (3200).
      const anticipation = { netAmount: 3000, breakdown: [{ unitId: 'pay-x-inst-1', gross: 3200 }] };
      const b = calcA([order], false, [anticipation]);
      // 3 parcelas de 3200 = 9600; menos a 1ª antecipada (3200) = 6400 a receber.
      expect(b.parceladosAReceber).toBe(6400);
      expect(b.saldoDisponivel).toBe(3000); // líquido antecipado
    });
  });
});

// ── Integração (e2e de serviço): exercita o caminho público getSummary ────────
// Reproduz o estado de banco PÓS-estorno (payment.status REFUNDED) e confere o
// summary, sem precisar de Cielo/HTTP — segue o roteiro A/B/C/D.

describe('RepasseService.getSummary — integração pós-estorno (roteiro)', () => {
  let service: RepasseService;

  const mockPrisma = {
    getWriteClient: jest.fn(),
    getReadClient: jest.fn(),
  };
  const mockAccess = { assertCanAccessEvent: jest.fn().mockResolvedValue(undefined) };
  const mockEmail = { sendTransferRequested: jest.fn(), sendTransferConfirmed: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RepasseService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrganizerMemberAccessService, useValue: mockAccess },
        { provide: EmailService, useValue: mockEmail },
        { provide: PaymentsRefundService, useValue: { refundOrder: jest.fn() } },
      ],
    }).compile();
    service = module.get<RepasseService>(RepasseService);
  });

  function setupDb(opts: { orders: any[]; audit: any; withdrawals?: any[]; anticipations?: any[] }) {
    const writeClient = {
      event: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'evt-1', organizerFeePercent: ORG_FEE, retentionRate: RETENTION }),
      },
      order: { findMany: jest.fn().mockResolvedValue(opts.orders) },
      eventAudit: { findUnique: jest.fn().mockResolvedValue(opts.audit) },
      eventWithdrawal: { findMany: jest.fn().mockResolvedValue(opts.withdrawals ?? []) },
      eventAnticipation: { findMany: jest.fn().mockResolvedValue(opts.anticipations ?? []) },
    };
    mockPrisma.getWriteClient.mockReturnValue(writeClient);
  }

  const summaryOf = async () => {
    const res = await service.getSummary('user-1', 'evt-1');
    return (res as any).data.summary;
  };

  it('A) estorno dentro da janela → saldoParaSaque -200, aguardando 0, 1 estornado', async () => {
    setupDb({ orders: [mkOrder({ daysAgo: 5, status: 'REFUNDED' })], audit: null });
    const s = await summaryOf();
    expect(s.aguardandoLiberacao).toBe(0);
    expect(s.saldoParaSaque).toBe(-REFUND_FEE);
    expect(s.refundedOrders).toBe(1);
    expect(s.isAudited).toBe(false);
  });

  it('B) liberado + sacado 9600 + estornado (auditado) → saldoParaSaque -9800', async () => {
    setupDb({
      orders: [mkOrder({ daysAgo: 40, status: 'REFUNDED' })],
      audit: { createdAt: new Date(), retentionReleased: 0 },
      withdrawals: [wd(ORG_NET, 'COMPLETED')],
    });
    const s = await summaryOf();
    expect(s.saldoParaSaque).toBe(-(ORG_NET + REFUND_FEE));
    expect(s.isAudited).toBe(true);
  });

  it('C) liberado, não sacado, estornado (auditado) → saldoParaSaque -200', async () => {
    setupDb({
      orders: [mkOrder({ daysAgo: 40, status: 'REFUNDED' })],
      audit: { createdAt: new Date(), retentionReleased: 0 },
    });
    const s = await summaryOf();
    expect(s.saldoParaSaque).toBe(-REFUND_FEE);
  });

  it('D) um válido + um estornado, ambos na janela → aguardando 9600 e saldoParaSaque -200', async () => {
    setupDb({
      orders: [mkOrder({ daysAgo: 5 }), mkOrder({ daysAgo: 5, status: 'REFUNDED' })],
      audit: null,
    });
    const s = await summaryOf();
    expect(s.aguardandoLiberacao).toBe(ORG_NET);
    expect(s.saldoParaSaque).toBe(-REFUND_FEE);
    expect(s.refundedOrders).toBe(1);
  });

  it('summary expõe o que foi retirado: refundFeesTotal e refundOrgNetReverted', async () => {
    setupDb({
      orders: [
        mkOrder({ daysAgo: 5, status: 'REFUNDED' }),
        mkOrder({ daysAgo: 40, status: 'REFUNDED' }),
      ],
      audit: null,
    });
    const s = await summaryOf();
    expect(s.refundedOrders).toBe(2);
    expect(s.refundFeesTotal).toBe(REFUND_FEE * 2); // 400 debitado do saldo
    expect(s.refundOrgNetReverted).toBe(ORG_NET * 2); // 19200 de venda revertida
  });
});

// ── getRefunded: a rota do organizador reflete o que foi retirado dele ────────

describe('RepasseService.getRefunded — detalhe do estorno p/ o organizador', () => {
  let service: RepasseService;

  const mockPrisma = { getWriteClient: jest.fn(), getReadClient: jest.fn() };
  const mockAccess = { assertCanAccessEvent: jest.fn().mockResolvedValue(undefined) };
  const mockEmail = { sendTransferRequested: jest.fn(), sendTransferConfirmed: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RepasseService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrganizerMemberAccessService, useValue: mockAccess },
        { provide: EmailService, useValue: mockEmail },
        { provide: PaymentsRefundService, useValue: { refundOrder: jest.fn() } },
      ],
    }).compile();
    service = module.get<RepasseService>(RepasseService);
  });

  function setupRead(orders: any[]) {
    const sumFinal = orders.reduce((s, o) => s + (o.finalAmount ?? 0), 0);
    const sumFee = orders.reduce((s, o) => s + (o.serviceFee ?? 0), 0);
    const readClient = {
      event: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'evt-1', organizerFeePercent: ORG_FEE, retentionRate: RETENTION }),
      },
      order: {
        findMany: jest.fn().mockResolvedValue(orders),
        count: jest.fn().mockResolvedValue(orders.length),
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { finalAmount: sumFinal, serviceFee: sumFee } }),
      },
    };
    mockPrisma.getReadClient.mockReturnValue(readClient);
  }

  it('cada item mostra refundedToBuyer, organizerNetReversed e refundFee', async () => {
    setupRead([mkOrder({ daysAgo: 5, status: 'REFUNDED' })]);
    const res: any = await service.getRefunded('user-1', 'evt-1', 1, 20);
    const item = res.data.items[0];
    expect(item.refundedToBuyer).toBe(FINAL); // devolvido ao comprador
    expect(item.organizerNetReversed).toBe(ORG_NET); // venda revertida
    expect(item.refundFee).toBe(REFUND_FEE); // 2% debitado
    expect(res.data.totalRefundedToBuyer).toBe(FINAL);
    expect(res.data.totalRefundFees).toBe(REFUND_FEE);
    expect(res.data.totalOrganizerNetReversed).toBe(ORG_NET);
  });

  it('prioriza valores CONGELADOS no metadata (verdade histórica) sobre o cálculo ao vivo', async () => {
    // metadata congelado com fee% antigo diferente do atual (ORG_FEE).
    const frozen = { organizerNetReversed: 8000, refundFee: 250, refundReason: 'cliente desistiu' };
    setupRead([mkOrder({ daysAgo: 5, status: 'REFUNDED', meta: frozen })]);
    const res: any = await service.getRefunded('user-1', 'evt-1', 1, 20);
    const item = res.data.items[0];
    expect(item.organizerNetReversed).toBe(8000); // veio do metadata, não recalculado
    expect(item.refundFee).toBe(250);
    expect(item.reason).toBe('cliente desistiu');
  });
});

describe('RepasseService.refundOrder (organizador c/ permissão financeira)', () => {
  let service: RepasseService;
  let refundService: { refundOrder: jest.Mock };
  let readClient: any;

  const mockAccess = { assertCanAccessEvent: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    refundService = { refundOrder: jest.fn().mockResolvedValue({ ok: true }) };
    readClient = { order: { findUnique: jest.fn() } };
    const mockPrisma = {
      getReadClient: jest.fn().mockReturnValue(readClient),
      getWriteClient: jest.fn().mockReturnValue(readClient),
    };
    mockAccess.assertCanAccessEvent.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RepasseService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrganizerMemberAccessService, useValue: mockAccess },
        { provide: EmailService, useValue: {} },
        { provide: PaymentsRefundService, useValue: refundService },
      ],
    }).compile();
    service = module.get<RepasseService>(RepasseService);
  });

  it('checa permissão financeira e delega ao engine com o organizador como actor', async () => {
    readClient.order.findUnique.mockResolvedValue({ eventId: 'evt-1' });

    const res = await service.refundOrder('user-1', 'evt-1', 'order-1', { reason: 'cliente desistiu' }, '1.2.3.4');

    expect(mockAccess.assertCanAccessEvent).toHaveBeenCalledWith('user-1', 'evt-1', 'financial');
    expect(refundService.refundOrder).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', adminUserId: 'user-1', reason: 'cliente desistiu', ip: '1.2.3.4' }),
    );
    expect(res).toEqual({ ok: true });
  });

  it('pedido de OUTRO evento → NotFound e NÃO estorna (fecha IDOR)', async () => {
    readClient.order.findUnique.mockResolvedValue({ eventId: 'evt-OUTRO' });

    await expect(
      service.refundOrder('user-1', 'evt-1', 'order-1', { reason: 'x' }),
    ).rejects.toThrow(/não encontrado/i);
    expect(refundService.refundOrder).not.toHaveBeenCalled();
  });

  it('pedido inexistente → NotFound', async () => {
    readClient.order.findUnique.mockResolvedValue(null);
    await expect(
      service.refundOrder('user-1', 'evt-1', 'order-1', { reason: 'x' }),
    ).rejects.toThrow(/não encontrado/i);
    expect(refundService.refundOrder).not.toHaveBeenCalled();
  });

  it('sem permissão financeira → propaga o erro e NÃO estorna', async () => {
    mockAccess.assertCanAccessEvent.mockRejectedValueOnce(new Error('forbidden'));
    await expect(
      service.refundOrder('user-1', 'evt-1', 'order-1', { reason: 'x' }),
    ).rejects.toThrow('forbidden');
    expect(readClient.order.findUnique).not.toHaveBeenCalled();
    expect(refundService.refundOrder).not.toHaveBeenCalled();
  });
});
