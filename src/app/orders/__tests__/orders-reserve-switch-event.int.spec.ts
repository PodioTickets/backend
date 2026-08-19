/**
 * ============================================================================
 *  reserve(): "um checkout ativo por vez" (troca de evento)
 * ============================================================================
 *  Ao INICIAR a reserva de um ingresso, os pedidos PENDING do usuário em OUTROS
 *  eventos (abandonados) são cancelados e o estoque deles é devolvido. Sem isso,
 *  pedidos acumulados de eventos anteriores disparavam TOO_MANY_PENDING_ORDERS
 *  ("já possui pedido em aberto") e prendiam o cupom do evento anterior.
 *
 *  Teste DE VERDADE contra Postgres de teste. OrdersService REAL; só o Redis é
 *  stubado (checkRateLimit → true) e a telemetria é no-op — o resto do reserve
 *  (validação, lote ativo, transação, advisory lock) roda de verdade.
 * ============================================================================
 */
import { EventStatus } from '@prisma/client';
import { OrdersService } from '../orders.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  createTestPrisma,
  resetDb,
  seedOrganization,
  seedUser,
} from '../../../common/testing/integration-db';

describe('OrdersService.reserve — troca de evento cancela pendências (integração)', () => {
  let prisma: PrismaService;
  let service: OrdersService;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    service = new OrdersService(
      prisma,
      {} as any, // Cielo
      { checkRateLimit: async () => true } as any, // Redis (rate limit sempre OK)
      {} as any, // Email
      {} as any, // TicketPdf
      {} as any, // ReceiptPdf
      {} as any, // OrderFinalization
      { record: () => {} } as any, // UserActivity (no-op)
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  /** Evento PUBLISHED com janela de inscrição ABERTA + 1 ingresso + 1 lote (estoque 10). */
  async function seedEventWithTicket(organizationId: string) {
    const w = prisma.getWriteClient();
    const ev = await w.event.create({
      data: {
        organizationId,
        name: `Ev ${Math.round(Math.random() * 1e6)}`,
        slug: `ev-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
        location: 'L', city: 'SP', state: 'SP', country: 'BR',
        // Janela aberta AGORA (wall-clock UTC; reserve usa eventWindowInstant +3h,
        // então uma abertura bem no passado cobre qualquer fuso).
        eventDate: new Date('2035-01-10T12:00:00.000Z'),
        registrationStartDate: new Date('2020-01-01T00:00:00.000Z'),
        registrationEndDate: new Date('2035-01-05T12:00:00.000Z'),
        status: EventStatus.PUBLISHED,
      },
      select: { id: true },
    });
    const ticket = await w.ticket.create({
      data: { eventId: ev.id, name: 'Ingresso', modality: 'Corrida', isActive: true },
      select: { id: true },
    });
    const batch = await w.ticketBatch.create({
      data: { ticketId: ticket.id, quantity: 10, availableQuantity: 10, price: 5000 },
      select: { id: true },
    });
    return { eventId: ev.id, ticketId: ticket.id, batchId: batch.id };
  }

  it('reservar no evento B cancela o pedido PENDING do evento A e devolve o estoque', async () => {
    const organizationId = await seedOrganization(prisma);
    const userId = await seedUser(prisma, 'USER');
    const a = await seedEventWithTicket(organizationId);
    const b = await seedEventWithTicket(organizationId);

    // 1) Reserva no evento A → cria pedido PENDING e decrementa o estoque de A.
    const orderA: any = await service.reserve(userId, {
      eventId: a.eventId,
      tickets: [{ ticketId: a.ticketId, quantity: 2 }],
    } as any);
    const w = prisma.getWriteClient();
    const batchAAfterReserve = await w.ticketBatch.findUnique({
      where: { id: a.batchId }, select: { availableQuantity: true },
    });
    expect(batchAAfterReserve?.availableQuantity).toBe(8); // 10 - 2

    // 2) Reserva no evento B → deve cancelar o pedido de A e restaurar o estoque de A.
    const orderB: any = await service.reserve(userId, {
      eventId: b.eventId,
      tickets: [{ ticketId: b.ticketId, quantity: 1 }],
    } as any);

    const orderAAfter = await w.order.findUnique({
      where: { id: orderA.id }, select: { status: true },
    });
    expect(orderAAfter?.status).toBe('CANCELLED');

    const orderBAfter = await w.order.findUnique({
      where: { id: orderB.id }, select: { status: true, eventId: true },
    });
    expect(orderBAfter?.status).toBe('PENDING');
    expect(orderBAfter?.eventId).toBe(b.eventId);

    // Estoque de A devolvido (o pedido abandonado não segura mais vaga).
    const batchARestored = await w.ticketBatch.findUnique({
      where: { id: a.batchId }, select: { availableQuantity: true },
    });
    expect(batchARestored?.availableQuantity).toBe(10);

    // Só 1 pendência ativa do usuário no total (a do evento B).
    const pendings = await w.order.count({ where: { userId, status: 'PENDING' } });
    expect(pendings).toBe(1);
  });

  it('reservar no MESMO evento é idempotente e NÃO é cancelado como "outro evento"', async () => {
    const organizationId = await seedOrganization(prisma);
    const userId = await seedUser(prisma, 'USER');
    const a = await seedEventWithTicket(organizationId);

    const order1: any = await service.reserve(userId, {
      eventId: a.eventId,
      tickets: [{ ticketId: a.ticketId, quantity: 2 }],
    } as any);
    const order2: any = await service.reserve(userId, {
      eventId: a.eventId,
      tickets: [{ ticketId: a.ticketId, quantity: 2 }],
    } as any);

    // Idempotência: mesmo evento + mesmos tickets → mesmo pedido, ainda PENDING.
    expect(order2.id).toBe(order1.id);
    const w = prisma.getWriteClient();
    const after = await w.order.findUnique({ where: { id: order1.id }, select: { status: true } });
    expect(after?.status).toBe('PENDING');
  });
});
