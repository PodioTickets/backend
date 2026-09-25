import { Prisma } from '@prisma/client';
import { removeUserAccountPreservingHistory } from '../remove-user-account.util';

function makeTx(counts: Partial<Record<string, number>> = {}) {
  const count = (key: string) => jest.fn().mockResolvedValue(counts[key] ?? 0);
  return {
    user: {
      delete: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({
        id: 'u1',
        firstName: 'Ana',
        lastName: 'Souza',
        email: 'ana@org.com',
        phone: '11999999999',
        documentNumber: '12345678901',
        documentType: 'CPF',
        avatarUrl: null,
        country: 'BR',
        dateOfBirth: null,
        gender: null,
        deletedAt: null,
      }),
    },
    order: { count: count('orders'), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    payment: { count: count('payments') },
    registration: {
      count: count('registrations'),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    eventWithdrawal: { count: count('withdrawals') },
    eventAnticipation: { count: count('anticipations') },
    eventAudit: { count: count('audits') },
  };
}

describe('removeUserAccountPreservingHistory', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');

  it('hard-deleta conta sem nenhum histórico', async () => {
    const tx = makeTx();
    await expect(removeUserAccountPreservingHistory(tx as any, 'u1', now)).resolves.toBe('deleted');
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('NÃO deleta colaborador que criou inscrições (pedido em nome dele): congela comprador e desativa', async () => {
    const tx = makeTx({ orders: 2, registrations: 3 });
    await expect(removeUserAccountPreservingHistory(tx as any, 'u1', now)).resolves.toBe('deactivated');

    expect(tx.user.delete).not.toHaveBeenCalled();
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', buyerSnapshot: { equals: Prisma.DbNull } },
      data: {
        buyerSnapshot: expect.objectContaining({ id: 'u1', email: 'ana@org.com', firstName: 'Ana' }),
      },
    });
    const data = tx.user.update.mock.calls[0][0].data;
    expect(data.email).toBe('deleted-u1@deleted.podioticket.local');
    expect(data.isActive).toBe(false);
    expect(data.deletedAt).toBe(now);
    expect(data.passwordChangedAt).toBe(now);
    expect(data).not.toHaveProperty('firstName'); // nome fica como âncora de auditoria
  });

  it.each(['withdrawals', 'anticipations', 'audits', 'payments', 'registrations'])(
    'não deleta conta com histórico em %s',
    async (key) => {
      const tx = makeTx({ [key]: 1 });
      await expect(removeUserAccountPreservingHistory(tx as any, 'u1', now)).resolves.toBe('deactivated');
      expect(tx.user.delete).not.toHaveBeenCalled();
      expect(tx.order.updateMany).not.toHaveBeenCalled();
    },
  );

  it('é idempotente para conta já removida', async () => {
    const tx = makeTx({ orders: 1 });
    tx.user.findUnique.mockResolvedValue({ id: 'u1', deletedAt: now });
    await expect(removeUserAccountPreservingHistory(tx as any, 'u1', now)).resolves.toBe('deactivated');
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });
});
