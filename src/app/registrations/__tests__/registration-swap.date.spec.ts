import { BadRequestException } from '@nestjs/common';
import { OrderStatus, RegistrationStatus } from '@prisma/client';
import { RegistrationSwapService } from '../registration-swap.service';

/**
 * Troca de ingresso: bloqueio pela DATA do evento (mesma regra do "Concluído": fim do dia
 * em BRT). Para antes de qualquer escrita — o `ticket.findUnique` não pode ser chamado.
 */
describe('RegistrationSwapService — data do evento', () => {
  const DAY = 24 * 60 * 60 * 1000;

  function setup(eventDate: Date | null) {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      registration: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'reg-1',
          eventId: 'ev-1',
          voidedAt: null,
          status: RegistrationStatus.CONFIRMED,
          order: { id: 'ord-1', status: OrderStatus.PAID, reservedTickets: [] },
          event: { id: 'ev-1', eventDate },
          tickets: [{ ticketId: 't-old', batchId: 'b-old' }],
          products: [],
          questionAnswers: [],
          modalities: [],
        }),
      },
      ticket: { findUnique: jest.fn() },
    };
    const prisma: any = { getWriteClient: () => ({ $transaction: (fn: any) => fn(tx) }) };
    const service = new RegistrationSwapService(prisma, {} as any, {} as any);
    const run = () =>
      service.swapTicket({ registrationId: 'reg-1', ticketId: 't-new', products: [], adminUserId: 'adm' });
    return { tx, run };
  }

  it('recusa quando a data do evento já passou', async () => {
    const { tx, run } = setup(new Date(Date.now() - 3 * DAY));
    await expect(run()).rejects.toThrow(
      new BadRequestException('Não é possível trocar o ingresso depois da data do evento'),
    );
    expect(tx.ticket.findUnique).not.toHaveBeenCalled();
  });

  it('recusa sem data do evento (fail secure)', async () => {
    const { tx, run } = setup(null);
    await expect(run()).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.ticket.findUnique).not.toHaveBeenCalled();
  });

  it('evento futuro passa da checagem de data (segue para o ingresso)', async () => {
    const { tx, run } = setup(new Date(Date.now() + 10 * DAY));
    tx.ticket.findUnique.mockResolvedValue(null); // para logo depois, com 404 do ingresso
    await expect(run()).rejects.toThrow('Ingresso não encontrado neste evento');
    expect(tx.ticket.findUnique).toHaveBeenCalled();
  });
});
