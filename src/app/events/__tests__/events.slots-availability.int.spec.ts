/**
 * ============================================================================
 *  hasRegistrationSlotsAvailable — "esgotado" da TELA DO EVENTO
 * ============================================================================
 *  O botão "Inscreva-se" da página do evento é gated por este flag. Ele DEVE
 *  concordar com o gate real de venda do checkout, que é o
 *  `TicketBatch.availableQuantity` (decrementado na reserva, restaurado na
 *  expiração/estorno) + o teto do evento (`maxParticipants`, contagem derivada
 *  Registration != CANCELLED).
 *
 *  REGRESSÃO QUE ISTO TRAVA: antes o flag era calculado por contagem de
 *  inscrições CONFIRMED vs `batch.quantity`, o que DIVERGIA do checkout — um lote
 *  com availableQuantity=0 (esgotado no checkout) mas poucos confirmados
 *  (reservas PENDING, ou estorno que não restaurou estoque) mantinha o botão
 *  "Inscreva-se" ATIVO. Agora o flag sai do próprio availableQuantity.
 *
 *  Teste de VERDADE contra Postgres de teste; EventsService REAL (deps não usadas
 *  no caminho público são stubs).
 * ============================================================================
 */
import { EventStatus, RegistrationStatus } from '@prisma/client';
import { EventsService } from '../events.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  createTestPrisma,
  resetDb,
  seedOrganization,
  seedUser,
} from '../../../common/testing/integration-db';

describe('EventsService.hasRegistrationSlotsAvailable (integração, banco real)', () => {
  let prisma: PrismaService;
  let service: EventsService;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDb(prisma);
    const stub: any = {};
    // Só prisma é exercitado no caminho público de findBySlug; o resto é stub.
    service = new EventsService(prisma, stub, stub, stub, stub, stub, stub, stub);
  });

  /** Evento PUBLISHED futuro + 1 ingresso ativo + 1 lote (qty/availableQuantity=10). */
  async function seedPublishedEvent(maxParticipants: number | null) {
    const organizationId = await seedOrganization(prisma);
    const w = prisma.getWriteClient();
    const ev = await w.event.create({
      data: {
        organizationId,
        name: 'Slots',
        slug: `slots-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
        location: 'L', city: 'SP', state: 'SP', country: 'BR',
        eventDate: new Date('2030-01-10T12:00:00.000Z'),
        registrationStartDate: new Date('2029-12-01T12:00:00.000Z'),
        registrationEndDate: new Date('2030-01-05T12:00:00.000Z'),
        status: EventStatus.PUBLISHED,
        maxParticipants,
      },
      select: { id: true, slug: true },
    });
    const ticket = await w.ticket.create({
      data: { eventId: ev.id, name: 'T', modality: 'Corrida', isActive: true },
      select: { id: true },
    });
    const batch = await w.ticketBatch.create({
      data: { ticketId: ticket.id, quantity: 10, availableQuantity: 10, price: 10000 },
      select: { id: true },
    });
    return { ...ev, ticketId: ticket.id, batchId: batch.id };
  }

  /** Cria `n` inscrições CONFIRMED reais (com Order PAID) no lote. */
  async function addConfirmedRegs(eventId: string, ticketId: string, batchId: string, n: number) {
    const w = prisma.getWriteClient();
    for (let i = 0; i < n; i++) {
      const uid = await seedUser(prisma, 'USER');
      const order = await w.order.create({
        data: { userId: uid, eventId, status: 'PAID', totalAmount: 10000, serviceFee: 0, discount: 0, finalAmount: 10000 } as any,
        select: { id: true },
      });
      const reg = await w.registration.create({
        data: { event: { connect: { id: eventId } }, user: { connect: { id: uid } }, order: { connect: { id: order.id } }, status: RegistrationStatus.CONFIRMED } as any,
        select: { id: true },
      });
      await w.registrationTicket.create({ data: { registrationId: reg.id, ticketId, batchId } });
    }
  }

  const setAvailable = (batchId: string, availableQuantity: number) =>
    prisma.getWriteClient().ticketBatch.update({ where: { id: batchId }, data: { availableQuantity } });

  const flag = async (slug: string) =>
    (await service.findBySlug(slug)).data.event.hasRegistrationSlotsAvailable;

  it('teto do evento atingido (max=2, 2 inscrições) → false', async () => {
    const ev = await seedPublishedEvent(2);
    await addConfirmedRegs(ev.id, ev.ticketId, ev.batchId, 2);
    expect(await flag(ev.slug)).toBe(false);
  });

  it('lote esgotado (availableQuantity=0, sem teto) → false', async () => {
    const ev = await seedPublishedEvent(null);
    await setAvailable(ev.batchId, 0);
    expect(await flag(ev.slug)).toBe(false);
  });

  it('há saldo (availableQuantity>0, abaixo do teto) → true', async () => {
    const ev = await seedPublishedEvent(10);
    await addConfirmedRegs(ev.id, ev.ticketId, ev.batchId, 2);
    expect(await flag(ev.slug)).toBe(true);
  });

  it('REGRESSÃO: availableQuantity=0 mas poucos CONFIRMED (reserva/estorno) → false', async () => {
    const ev = await seedPublishedEvent(null);
    await setAvailable(ev.batchId, 0);
    await addConfirmedRegs(ev.id, ev.ticketId, ev.batchId, 3);
    expect(await flag(ev.slug)).toBe(false);
  });
});
