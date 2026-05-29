import { REFUND_FEE_RATE, isChargeback, computeRefundImpact } from '../refund.util';

describe('refund.util — fonte única de regra de estorno', () => {
  it('REFUND_FEE_RATE é 2%', () => {
    expect(REFUND_FEE_RATE).toBe(0.02);
  });

  describe('isChargeback', () => {
    it('true só quando refundType === CHARGEBACK', () => {
      expect(isChargeback({ refundType: 'CHARGEBACK' })).toBe(true);
      expect(isChargeback({ refundType: 'REFUND' })).toBe(false);
      expect(isChargeback({})).toBe(false);
      expect(isChargeback(null)).toBe(false);
      expect(isChargeback(undefined)).toBe(false);
    });
  });

  describe('computeRefundImpact', () => {
    const order = (metadata: any) => ({
      finalAmount: 10200,
      serviceFee: 200,
      payment: { metadata },
    });

    it('estorno proativo (sem valores congelados) calcula ao vivo', () => {
      const r = computeRefundImpact(order({}), 4);
      expect(r.subtotal).toBe(10000);
      expect(r.organizerNetReversed).toBe(9600); // 10000 * 0.96
      expect(r.refundFee).toBe(200); // 10000 * 0.02
    });

    it('prioriza valores CONGELADOS no metadata (verdade histórica)', () => {
      const r = computeRefundImpact(
        order({ refundType: 'REFUND', organizerNetReversed: 8000, refundFee: 250 }),
        4,
      );
      expect(r.organizerNetReversed).toBe(8000);
      expect(r.refundFee).toBe(250);
    });

    it('CHARGEBACK também cobra a taxa de 2% (é um tipo de estorno)', () => {
      const r = computeRefundImpact(order({ refundType: 'CHARGEBACK' }), 4);
      expect(r.refundFee).toBe(200);
      expect(r.organizerNetReversed).toBe(9600);
    });
  });
});
