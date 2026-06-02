/**
 * ROTEIRO — taxas de retenção e estorno POR EVENTO no calcBreakdown
 * =================================================================
 * Prova que o breakdown usa as taxas QUE VÊM DO EVENTO (params `retentionRate` e
 * `refundFeeRate`), não mais a constante global. Adversarial: varia as taxas e
 * confirma que o resultado acompanha; cobre fallback, taxa 0, valor congelado e
 * independência entre as duas taxas.
 *
 * Base: subtotal 10000c + serviço 200c = 10200c; organizerFeePercent 4% → orgNet 9600c.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { RepasseService } from '../repasse.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrganizerMemberAccessService } from '../../organizations/organizer-member-access.service';
import { EmailService } from '../../../common/services/email.service';
import { PaymentsRefundService } from '../../payments/payments-refund.service';

const FINAL = 10200;
const FEE = 200;
const SUBTOTAL = 10000; // FINAL - FEE
const ORG_NET = 9600; // round(10000 * 0.96)
const ORG_FEE = 4;

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function paidOrder(opts: { daysAgo?: number; method?: string } = {}): any {
  return {
    id: `paid-${opts.daysAgo ?? 40}`,
    finalAmount: FINAL,
    serviceFee: FEE,
    payment: {
      status: 'PAID',
      paymentDate: daysAgo(opts.daysAgo ?? 40),
      method: opts.method ?? 'CREDIT_CARD',
      metadata: {},
    },
  };
}

function refundedOrder(meta: Record<string, any> = {}): any {
  return {
    id: `ref-${JSON.stringify(meta)}`,
    finalAmount: FINAL,
    serviceFee: FEE,
    payment: { status: 'REFUNDED', paymentDate: daysAgo(5), method: 'PIX', metadata: meta },
  };
}

describe('RepasseService — taxas por evento no calcBreakdown', () => {
  let service: RepasseService;

  const mockPrisma = { getWriteClient: jest.fn(), getReadClient: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RepasseService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrganizerMemberAccessService, useValue: { assertCanAccessEvent: jest.fn() } },
        { provide: EmailService, useValue: {} },
        { provide: PaymentsRefundService, useValue: { refundOrder: jest.fn() } },
      ],
    }).compile();
    service = module.get<RepasseService>(RepasseService);
  });

  // calcBreakdown(paid, refunded, retentionRate, isAudited, withdrawals, organizerFeePercent, refundFeeRate)
  const calc = (
    paid: any[],
    refunded: any[],
    opts: { retentionRate?: number; refundFeeRate?: number; audited?: boolean; withdrawals?: any[] } = {},
  ) =>
    (service as any).calcBreakdown(
      paid,
      refunded,
      opts.retentionRate ?? 0.1,
      opts.audited ?? false,
      opts.withdrawals ?? [],
      ORG_FEE,
      opts.refundFeeRate,
    );

  describe('taxa de ESTORNO por evento', () => {
    it('usa a taxa do evento (5%) → debita 500, não 200', () => {
      const b = calc([], [refundedOrder()], { refundFeeRate: 0.05 });
      expect(b.saldoDisponivel).toBe(-Math.round(SUBTOTAL * 0.05)); // -500
    });

    it('taxa do evento = 0 → não debita nada (saldo intacto)', () => {
      const b = calc([], [refundedOrder()], { refundFeeRate: 0 });
      expect(b.saldoDisponivel).toBe(0);
    });

    it('valor CONGELADO no metadata prevalece sobre a taxa do evento', () => {
      const b = calc([], [refundedOrder({ refundFee: 250 })], { refundFeeRate: 0.05 });
      expect(b.saldoDisponivel).toBe(-250);
    });

    it('taxa não informada → fallback 2% (back-compat de evento legado)', () => {
      const b = calc([], [refundedOrder()], { refundFeeRate: undefined });
      expect(b.saldoDisponivel).toBe(-Math.round(SUBTOTAL * 0.02)); // -200
    });

    it('múltiplos estornos somam pela taxa do evento (3% × 2 = -600)', () => {
      const b = calc([], [refundedOrder({ a: 1 }), refundedOrder({ a: 2 })], { refundFeeRate: 0.03 });
      expect(b.saldoDisponivel).toBe(-2 * Math.round(SUBTOTAL * 0.03)); // -600
    });
  });

  describe('taxa de RETENÇÃO por evento', () => {
    it('retenção do evento (20%) → retém 1920 e libera 7680', () => {
      // à vista fora da janela (40d, crédito → liberado), não auditado
      const b = calc([paidOrder({ daysAgo: 40 })], [], { retentionRate: 0.2 });
      expect(b.valorRetido).toBe(Math.round(ORG_NET * 0.2)); // 1920
      expect(b.saldoDisponivel).toBe(ORG_NET - Math.round(ORG_NET * 0.2)); // 7680
    });

    it('retenção 10% (default) → retém 960 e libera 8640', () => {
      const b = calc([paidOrder({ daysAgo: 40 })], [], { retentionRate: 0.1 });
      expect(b.valorRetido).toBe(960);
      expect(b.saldoDisponivel).toBe(8640);
    });
  });

  describe('independência das duas taxas (não cruzar fios)', () => {
    it('retenção e estorno são aplicadas com suas próprias taxas no mesmo breakdown', () => {
      // 1 pago fora da janela (retém 25%) + 1 estornado (taxa 10%)
      const b = calc([paidOrder({ daysAgo: 40 })], [refundedOrder()], {
        retentionRate: 0.25,
        refundFeeRate: 0.1,
      });
      const retido = Math.round(ORG_NET * 0.25); // 2400
      const liberadoDoPago = ORG_NET - retido; // 7200
      const taxaEstorno = Math.round(SUBTOTAL * 0.1); // 1000
      expect(b.valorRetido).toBe(retido);
      expect(b.saldoDisponivel).toBe(liberadoDoPago - taxaEstorno); // 6200
    });
  });
});
