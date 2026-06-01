import { OrderFinalizationService } from '../order-finalization.service';

/**
 * Cobre os dois métodos compartilhados (fonte única) do OrderFinalizationService:
 *   - confirmAndFinalizeOrder: promove Order PENDING→PAID + finalize (idempotente).
 *   - reverseSaleSideEffects: reverte cupom/voucher no estorno E no chargeback.
 * O finalizePaidOrder em si depende de muito I/O e não é alvo aqui (é spy).
 */
describe('OrderFinalizationService — métodos compartilhados', () => {
  const prismaStub: any = { getReadClient: () => ({}) };
  let service: OrderFinalizationService;

  beforeEach(() => {
    service = new OrderFinalizationService(prismaStub);
  });

  describe('confirmAndFinalizeOrder', () => {
    it('finaliza quando ESTE caller promove o Order (UPDATE retorna 1 linha)', async () => {
      const tx: any = { $queryRaw: jest.fn().mockResolvedValue([{ id: 'o1' }]) };
      const spy = jest
        .spyOn(service, 'finalizePaidOrder')
        .mockResolvedValue([{ id: 'r1', qrCode: 'x', status: 'CONFIRMED' }]);

      const res = await service.confirmAndFinalizeOrder(tx, 'o1');

      expect(res.finalized).toBe(true);
      expect(res.registrations).toHaveLength(1);
      expect(spy).toHaveBeenCalledWith(tx, 'o1');
    });

    it('é idempotente: se o Order já não estava PENDING, NÃO finaliza', async () => {
      const tx: any = { $queryRaw: jest.fn().mockResolvedValue([]) };
      const spy = jest.spyOn(service, 'finalizePaidOrder').mockResolvedValue([]);

      const res = await service.confirmAndFinalizeOrder(tx, 'o1');

      expect(res.finalized).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('reverseSaleSideEffects', () => {
    const mkTx = (order: any) => ({
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      $executeRaw: jest.fn().mockResolvedValue(1),
      voucher: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    });

    it('cupom QUANTITY → decrementa 1', async () => {
      const tx: any = mkTx({
        userId: 'u1',
        couponId: 'c1',
        voucherId: null,
        reservedTickets: [{ quantity: 3 }],
        coupon: { couponType: 'QUANTITY' },
        voucher: null,
      });
      await service.reverseSaleSideEffects(tx, 'o1');
      // tagged template: args = [stringsArray, ...values] → o decremento é o 1º valor.
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw.mock.calls[0][1]).toBe(1);
      expect(tx.voucher.updateMany).not.toHaveBeenCalled();
    });

    it('cupom DISCOUNT sem lista → decrementa todos os ingressos aplicáveis (espelha o finalize)', async () => {
      const tx: any = mkTx({
        userId: 'u1',
        couponId: 'c1',
        voucherId: null,
        reservedTickets: [{ ticketId: 'A', quantity: 2 }, { ticketId: 'B', quantity: 1 }],
        pendingParticipants: [],
        coupon: { couponType: 'DISCOUNT' },
        event: { eventDate: '2020-01-01T00:00:00Z' },
        voucher: null,
      });
      await service.reverseSaleSideEffects(tx, 'o1');
      expect(tx.$executeRaw.mock.calls[0][1]).toBe(3);
    });

    it('BUG: cupom por ingresso (AGE) cobrindo 1 de 2 → decrementa 1 (não ticketCount)', async () => {
      const tx: any = mkTx({
        userId: 'u1',
        couponId: 'c1',
        voucherId: null,
        reservedTickets: [{ ticketId: 'A', quantity: 2 }],
        // p1 tem 20 (na faixa 18-25); p2 tem 40 (fora) → cobre só 1 ingresso.
        pendingParticipants: [{ birthDate: '2000-01-01' }, { birthDate: '1980-01-01' }],
        coupon: { couponType: 'AGE', minAge: 18, maxAge: 25 },
        event: { eventDate: '2020-01-01T00:00:00Z' },
        voucher: null,
      });
      await service.reverseSaleSideEffects(tx, 'o1');
      expect(tx.$executeRaw.mock.calls[0][1]).toBe(1);
    });

    it('voucher só é liberado para ESTE usuário (guard usedBy)', async () => {
      const tx: any = mkTx({
        userId: 'u1',
        couponId: null,
        voucherId: 'v1',
        reservedTickets: [],
        coupon: null,
        voucher: { status: 'USED' },
      });
      await service.reverseSaleSideEffects(tx, 'o1');
      expect(tx.voucher.updateMany).toHaveBeenCalledTimes(1);
      const arg = tx.voucher.updateMany.mock.calls[0][0];
      expect(arg.where).toMatchObject({ id: 'v1', status: 'USED', usedBy: 'u1' });
      expect(arg.data.status).toBe('ACTIVE');
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('sem cupom/voucher → nenhuma escrita', async () => {
      const tx: any = mkTx({
        userId: 'u1',
        couponId: null,
        voucherId: null,
        reservedTickets: [],
        coupon: null,
        voucher: null,
      });
      await service.reverseSaleSideEffects(tx, 'o1');
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.voucher.updateMany).not.toHaveBeenCalled();
    });

    it('order inexistente → no-op', async () => {
      const tx: any = mkTx(null);
      await service.reverseSaleSideEffects(tx, 'o1');
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.voucher.updateMany).not.toHaveBeenCalled();
    });
  });
});
