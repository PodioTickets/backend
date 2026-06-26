import { EventsService } from '../events.service';
import { RegistrationStatus, PaymentStatus } from '@prisma/client';

/**
 * applyRegistrationStatusFilter — mapeia o filtro de status (valor do front) ao `where`.
 * Usado pela lista E pelo export, garantindo que ambos casem. O bug que isto trava: o front
 * manda "COMPLETED" para "Pago"; usar o valor cru perdia todas as inscrições CONFIRMED.
 */
describe('EventsService.applyRegistrationStatusFilter', () => {
  const svc = new EventsService(
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  const apply = (status: string | undefined) => {
    const where: any = { eventId: 'e', status: { not: 'PENDING' } };
    const res = (svc as any).applyRegistrationStatusFilter(where, status);
    return { where, ...res };
  };

  it('"COMPLETED" (= Pago no front) → CONFIRMED+COMPLETED com payment PAID (NÃO só COMPLETED)', () => {
    const { where, targetRefundType } = apply('COMPLETED');
    expect(where.status).toEqual({ in: [RegistrationStatus.CONFIRMED, RegistrationStatus.COMPLETED] });
    expect(where.order.payment.status).toBe(PaymentStatus.PAID);
    expect(targetRefundType).toBeNull();
  });

  it('"CONFIRMED" → where.status = CONFIRMED', () => {
    const { where } = apply('CONFIRMED');
    expect(where.status).toBe('CONFIRMED');
  });

  it('"CANCELLED" → status CANCELLED + exclui pagamentos REFUNDED (estorno/chargeback)', () => {
    const { where } = apply('CANCELLED');
    expect(where.status).toBe('CANCELLED');
    expect(where.AND).toEqual([{ NOT: { order: { payment: { status: PaymentStatus.REFUNDED } } } }]);
  });

  it('"CHARGEBACK" → payment REFUNDED + targetRefundType CHARGEBACK', () => {
    const { where, targetRefundType } = apply('CHARGEBACK');
    expect(where.order.payment.status).toBe(PaymentStatus.REFUNDED);
    expect(targetRefundType).toBe('CHARGEBACK');
  });

  it('"REFUNDED" → payment REFUNDED + targetRefundType REFUND', () => {
    const { where, targetRefundType } = apply('REFUNDED');
    expect(where.order.payment.status).toBe(PaymentStatus.REFUNDED);
    expect(targetRefundType).toBe('REFUND');
  });

  it('sem status (all) → where.status fica intacto ({ not: PENDING }), sem metadata', () => {
    const { where, targetRefundType } = apply(undefined);
    expect(where.status).toEqual({ not: 'PENDING' });
    expect(where.order).toBeUndefined();
    expect(targetRefundType).toBeNull();
  });
});
