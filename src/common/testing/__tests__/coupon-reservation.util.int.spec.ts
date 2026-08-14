/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: a "reserva de uso" do CUPOM (limite de usos — maxUsage).
 *
 *  EM RESUMO:
 *    Um cupom pode ter um limite de usos (ex.: "vale para os 10 primeiros"). Antes, esse
 *    limite só era checado/contado na hora do pagamento — então vários carrinhos ao mesmo
 *    tempo conseguiam aplicar o desconto e ULTRAPASSAR o limite (mais gente comprava com
 *    desconto do que o organizador permitiu). Agora, quando um pedido aplica o cupom no
 *    pagamento, ele RESERVA as unidades que vai usar; outro pedido só consegue reservar o que
 *    ainda sobra. A disponibilidade é: limite − já usados − reservados por outros pedidos.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Cupom sem limite → concede tudo o que foi pedido.
 *    • Com folga → concede o pedido inteiro e marca o vínculo do cupom no pedido.
 *    • Quando o pedido cabe só em parte → concede o restante (reserva PARCIAL).
 *    • Esgotado → concede 0 e NÃO vincula o cupom ao pedido.
 *    • Dois pedidos somados NUNCA ultrapassam o limite (o 2º vê a reserva do 1º).
 *    • A própria reserva do pedido não conta contra ele (re-reservar é idempotente).
 *    • Pedido pago/cancelado/expirado some da conta → libera a reserva automaticamente.
 *    • Liberar (pedir 0) zera a reserva do pedido.
 *
 *  COMO CONFERIMOS:
 *    Teste DE VERDADE contra um banco de teste (descartável). A lógica vive em SQL atômico
 *    (trava de linha + soma) — por isso testamos contra Postgres real, não com "faz-de-conta".
 * ============================================================================
 */
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { createTestPrisma, resetDb, seedOrgUserEvent, seedUser } from '../integration-db';
import { claimCouponUnits, releaseCouponByOrder } from '../../utils/coupon-reservation.util';

describe('Reserva de uso de cupom (integração, banco real)', () => {
  let prisma: PrismaService;
  let w: any;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    w = prisma.getWriteClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  const future = () => new Date(Date.now() + 30 * 60 * 1000);
  const past = () => new Date(Date.now() - 1000);

  // Cupom DISCOUNT real (10% OFF) com limite opcional. Devolve o id.
  const seedCoupon = async (eventId: string, over: Record<string, any> = {}) => {
    const c = await w.coupon.create({
      data: {
        eventId,
        code: `C-${randomUUID().slice(0, 8)}`,
        couponType: 'DISCOUNT',
        type: 'PERCENTAGE',
        value: 10,
        status: 'ACTIVE',
        usageCount: 0,
        ...over,
      },
      select: { id: true },
    });
    return c.id;
  };

  // Pedido PENDING real. `expiresAt` no futuro por padrão (reserva válida).
  const seedOrder = async (
    eventId: string,
    userId: string,
    over: Record<string, any> = {},
  ): Promise<string> => {
    const o = await w.order.create({
      data: {
        userId,
        eventId,
        totalAmount: 10000,
        serviceFee: 0,
        finalAmount: 10000,
        status: 'PENDING',
        expiresAt: future(),
        ...over,
      },
      select: { id: true },
    });
    return o.id;
  };

  const readOrder = (id: string) =>
    w.order.findUnique({ where: { id }, select: { couponId: true, couponReservedUnits: true } });

  it('cupom SEM limite (maxUsage null) → concede tudo o que foi pedido', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const userId = await seedUser(prisma, 'USER');
    const couponId = await seedCoupon(eventId, { maxUsage: null });
    const orderA = await seedOrder(eventId, userId);

    const granted = await claimCouponUnits(w, couponId, orderA, 5);

    expect(granted).toBe(5);
    const o = await readOrder(orderA);
    expect(o.couponReservedUnits).toBe(5);
    expect(o.couponId).toBe(couponId); // vínculo gravado atomicamente
  });

  // REGRESSÃO (bug do cupom ilimitado "esgotado" após o 1º uso):
  // com maxUsage null e usageCount > 0, o COALESCE(maxUsage, want) fazia
  // `want − usageCount − reservas`, zerando o grant depois do 1º uso. Um cupom
  // SEM limite NUNCA deve esgotar, independente de usos anteriores.
  it('cupom SEM limite com usageCount > 0 → NÃO esgota (concede tudo)', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const userId = await seedUser(prisma, 'USER');
    // Já foi usado 5x, mas é ILIMITADO → o 6º pedido ainda concede tudo.
    const couponId = await seedCoupon(eventId, { maxUsage: null, usageCount: 5 });
    const orderA = await seedOrder(eventId, userId);

    expect(await claimCouponUnits(w, couponId, orderA, 2)).toBe(2);
    const o = await readOrder(orderA);
    expect(o.couponReservedUnits).toBe(2);
    expect(o.couponId).toBe(couponId);
  });

  it('cupom SEM limite ignora reservas de OUTROS pedidos → concede tudo', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const userId = await seedUser(prisma, 'USER');
    const couponId = await seedCoupon(eventId, { maxUsage: null, usageCount: 3 });
    // Outro pedido PENDING segurando 4 unidades — irrelevante para ilimitado.
    await seedOrder(eventId, userId, { couponId, couponReservedUnits: 4 });
    const orderB = await seedOrder(eventId, userId);

    expect(await claimCouponUnits(w, couponId, orderB, 3)).toBe(3);
    expect((await readOrder(orderB)).couponReservedUnits).toBe(3);
  });

  it('com folga → concede o pedido inteiro', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const userId = await seedUser(prisma, 'USER');
    const couponId = await seedCoupon(eventId, { maxUsage: 10 });
    const orderA = await seedOrder(eventId, userId);

    expect(await claimCouponUnits(w, couponId, orderA, 3)).toBe(3);
  });

  it('cabe só em parte → concede o RESTANTE (reserva parcial)', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const userId = await seedUser(prisma, 'USER');
    // Limite 5, já 3 usados → restam 2. Pedindo 4, concede só 2.
    const couponId = await seedCoupon(eventId, { maxUsage: 5, usageCount: 3 });
    const orderA = await seedOrder(eventId, userId);

    expect(await claimCouponUnits(w, couponId, orderA, 4)).toBe(2);
    expect((await readOrder(orderA)).couponReservedUnits).toBe(2);
  });

  it('esgotado → concede 0 e NÃO vincula o cupom ao pedido', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const userId = await seedUser(prisma, 'USER');
    const couponId = await seedCoupon(eventId, { maxUsage: 3, usageCount: 3 });
    const orderA = await seedOrder(eventId, userId);

    expect(await claimCouponUnits(w, couponId, orderA, 2)).toBe(0);
    const o = await readOrder(orderA);
    expect(o.couponReservedUnits).toBe(0);
    expect(o.couponId).toBeNull(); // não vincula um cupom que não concedeu nada
  });

  it('dois pedidos somados NUNCA ultrapassam o limite (o 2º vê a reserva do 1º)', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const userId = await seedUser(prisma, 'USER');
    const couponId = await seedCoupon(eventId, { maxUsage: 4 });
    const orderA = await seedOrder(eventId, userId);
    const orderB = await seedOrder(eventId, userId);

    // A pega 3 (de 4). B pede 3, mas só sobra 1.
    expect(await claimCouponUnits(w, couponId, orderA, 3)).toBe(3);
    expect(await claimCouponUnits(w, couponId, orderB, 3)).toBe(1);

    // Invariante: a soma das reservas ≤ maxUsage.
    const a = await readOrder(orderA);
    const b = await readOrder(orderB);
    expect((a.couponReservedUnits ?? 0) + (b.couponReservedUnits ?? 0)).toBeLessThanOrEqual(4);
  });

  it('a própria reserva não conta contra o pedido (re-reservar é idempotente)', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const userId = await seedUser(prisma, 'USER');
    const couponId = await seedCoupon(eventId, { maxUsage: 3 });
    const orderA = await seedOrder(eventId, userId);

    expect(await claimCouponUnits(w, couponId, orderA, 3)).toBe(3);
    // Re-reservar o mesmo pedido: ainda concede 3 (não soma sobre si mesmo).
    expect(await claimCouponUnits(w, couponId, orderA, 3)).toBe(3);
    // Pode até REDUZIR a própria reserva.
    expect(await claimCouponUnits(w, couponId, orderA, 1)).toBe(1);
    expect((await readOrder(orderA)).couponReservedUnits).toBe(1);
  });

  it('pedido PAGO não conta na disponibilidade (sai da SUM de reservas)', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const userId = await seedUser(prisma, 'USER');
    const couponId = await seedCoupon(eventId, { maxUsage: 3 });
    // Pedido PAID com 3 reservas "presas" — não deve bloquear novos pedidos.
    const paid = await seedOrder(eventId, userId, {
      status: 'PAID',
      couponId,
      couponReservedUnits: 3,
    });
    const orderB = await seedOrder(eventId, userId);

    expect(paid).toBeDefined();
    // Como o limite é contado por usageCount (não por reservas de pedidos pagos),
    // e usageCount=0 aqui, B vê as 3 unidades livres.
    expect(await claimCouponUnits(w, couponId, orderB, 3)).toBe(3);
  });

  it('reserva de pedido EXPIRADO (carrinho abandonado) é tratada como livre', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const userId = await seedUser(prisma, 'USER');
    const couponId = await seedCoupon(eventId, { maxUsage: 2 });
    // Pedido PENDING porém VENCIDO segurando 2 unidades → deve ser ignorado.
    await seedOrder(eventId, userId, {
      couponId,
      couponReservedUnits: 2,
      expiresAt: past(),
    });
    const orderB = await seedOrder(eventId, userId);

    expect(await claimCouponUnits(w, couponId, orderB, 2)).toBe(2);
  });

  it('liberar (pedir 0) zera a reserva do pedido', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const userId = await seedUser(prisma, 'USER');
    const couponId = await seedCoupon(eventId, { maxUsage: 5 });
    const orderA = await seedOrder(eventId, userId);

    await claimCouponUnits(w, couponId, orderA, 3);
    await releaseCouponByOrder(w, orderA);

    expect((await readOrder(orderA)).couponReservedUnits).toBe(0);

    // claimCouponUnits com desejado 0 também libera.
    await claimCouponUnits(w, couponId, orderA, 3);
    expect(await claimCouponUnits(w, couponId, orderA, 0)).toBe(0);
    expect((await readOrder(orderA)).couponReservedUnits).toBe(0);
  });
});
