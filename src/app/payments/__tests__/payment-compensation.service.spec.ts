/**
 * ROTEIRO — PaymentCompensationService (estorno automático de pagamento órfão)
 * =============================================================================
 * Compensa pagamento CAPTURADO sem entrega possível (pedido cancelado pelo cron antes do
 * webhook / finalize abortado por voucher consumido ou participantes vazios).
 *
 *  A. Estorno OK → Payment vira REFUNDED com refundType AUTO_COMPENSATION.
 *  B. Cielo RECUSA o estorno → status preservado + flag `compensationPending` (reconciliação
 *     manual) — nada se perde silenciosamente.
 *  C. NUNCA lança (o caller precisa devolver 200 pro gateway pra matar o retry-loop), mesmo
 *     com a Cielo explodindo ou o banco falhando.
 *  D. Sem Payment local → apenas loga (nada a estornar localmente).
 */
import { PaymentCompensationService } from '../payment-compensation.service';

describe('PaymentCompensationService', () => {
  const basePayment = {
    id: 'pay-1',
    orderId: 'order-1',
    userId: 'user-1',
    method: 'PIX',
    amount: 10000,
    status: 'PENDING',
    transactionId: 'tx-cielo-1',
    metadata: { cieloPaymentId: 'tx-cielo-1' },
  };

  const makeMocks = (over: { payment?: any; cancelResult?: any; cancelThrows?: boolean } = {}) => {
    const tx: any = {
      payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      // Pedido já não-PENDING por default (caso PAID_AFTER_CANCELLATION).
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      orderReservedTicket: { findMany: jest.fn().mockResolvedValue([]) },
      registration: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const w: any = {
      payment: { findUnique: jest.fn().mockResolvedValue('payment' in over ? over.payment : basePayment) },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
    };
    const prisma: any = { getWriteClient: () => w, getReadClient: () => w };
    const cielo: any = {
      cancelPayment: over.cancelThrows
        ? jest.fn().mockRejectedValue(new Error('cielo down'))
        : jest.fn().mockResolvedValue(over.cancelResult ?? { success: true }),
    };
    const activity: any = { record: jest.fn() };
    const service = new PaymentCompensationService(prisma, cielo, activity);
    return { service, w, tx, cielo, activity };
  };

  it('A. estorno OK → Payment REFUNDED + refundType AUTO_COMPENSATION + telemetria', async () => {
    const { service, tx, cielo, activity } = makeMocks();

    await service.compensateOrphanPayment('order-1', 'PAID_AFTER_CANCELLATION');

    expect(cielo.cancelPayment).toHaveBeenCalledWith('tx-cielo-1');
    const updateArg = tx.payment.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBe('REFUNDED');
    expect(updateArg.data.metadata.refundType).toBe('AUTO_COMPENSATION');
    expect(updateArg.data.metadata.compensationReason).toBe('PAID_AFTER_CANCELLATION');
    expect(updateArg.data.metadata.compensationPending).toBeUndefined();
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'order.auto-refund', userId: 'user-1' }),
    );
  });

  it('A2. pedido ainda PENDING (aborto do finalize) → cancela com estoque de volta + voucher liberado', async () => {
    const { service, tx } = makeMocks();
    // Pedido ainda PENDING → o UPDATE de cancelamento retorna 1 linha.
    tx.$queryRaw.mockResolvedValue([{ id: 'order-1' }]);
    tx.orderReservedTicket.findMany.mockResolvedValue([{ batchId: 'b1', quantity: 2 }]);

    await service.compensateOrphanPayment('order-1', 'VOUCHER_CONSUMED');

    // Estoque devolvido (1 UPDATE por lote) + release da reserva de voucher (executeRaw extra).
    expect(tx.orderReservedTicket.findMany).toHaveBeenCalled();
    expect(tx.$executeRaw.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(tx.registration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: 'order-1', status: 'PENDING' } }),
    );
  });

  it('B. Cielo recusa o estorno → status PRESERVADO + compensationPending (reconciliação manual)', async () => {
    const { service, tx } = makeMocks({ cancelResult: { success: false, error: 'Not allowed' } });

    await service.compensateOrphanPayment('order-1', 'VOUCHER_CONSUMED');

    const updateArg = tx.payment.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBeUndefined(); // não mente REFUNDED sem estorno real
    expect(updateArg.data.metadata.compensationPending).toBe(true);
    expect(updateArg.data.metadata.compensationReason).toBe('VOUCHER_CONSUMED');
  });

  it('C1. Cielo EXPLODE → não lança e marca compensationPending', async () => {
    const { service, tx } = makeMocks({ cancelThrows: true });

    await expect(
      service.compensateOrphanPayment('order-1', 'PAID_AFTER_CANCELLATION'),
    ).resolves.toBeUndefined();
    const updateArg = tx.payment.updateMany.mock.calls[0][0];
    expect(updateArg.data.metadata.compensationPending).toBe(true);
  });

  it('C2. banco explode na transação → NÃO propaga (caller devolve 200 pro gateway)', async () => {
    const { service, w } = makeMocks();
    w.$transaction.mockRejectedValue(new Error('db down'));

    await expect(
      service.compensateOrphanPayment('order-1', 'EMPTY_PARTICIPANTS'),
    ).resolves.toBeUndefined();
  });

  it('D. sem Payment local → só loga, não tenta estornar', async () => {
    const { service, cielo, w } = makeMocks({ payment: null });

    await service.compensateOrphanPayment('order-1', 'VOUCHER_CONSUMED');

    expect(cielo.cancelPayment).not.toHaveBeenCalled();
    expect(w.$transaction).not.toHaveBeenCalled();
  });
});
