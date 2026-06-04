/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: a "reserva de uso único" do voucher (vale-ingresso grátis).
 *
 *  EM RESUMO:
 *    Um voucher vale por UM uso só. Antes, ele só era "carimbado como usado" na hora do
 *    pagamento — então dava pra colar o mesmo voucher em dois pedidos ao mesmo tempo e os
 *    dois saírem de graça. Agora, assim que um pedido pega o voucher, ele fica RESERVADO
 *    para aquele pedido; nenhum outro pedido consegue pegá-lo enquanto isso.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Um pedido consegue reservar um voucher livre.
 *    • Um segundo pedido NÃO consegue reservar o mesmo voucher (já está com o primeiro).
 *    • O mesmo pedido pode "reservar de novo" sem erro (idempotente).
 *    • Se a reserva venceu (carrinho abandonado), outro pedido pode pegar o voucher.
 *    • Cancelar/abandonar o pedido LIBERA o voucher de volta.
 *    • Na finalização do pagamento, só o pedido dono consome o voucher (vira USED).
 *    • Um segundo pedido NÃO consegue consumir um voucher já usado (trava a dupla-concessão).
 *
 *  COMO CONFERIMOS:
 *    Teste DE VERDADE contra um banco de teste (descartável). Criamos evento e voucher REAIS,
 *    chamamos os helpers e conferimos lendo o banco de volta. A lógica vive em SQL atômico —
 *    por isso testamos contra Postgres real, não com "faz-de-conta".
 * ============================================================================
 */
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  createTestPrisma,
  resetDb,
  seedOrgUserEvent,
  seedUser,
} from '../integration-db';
import {
  claimVoucher,
  releaseVoucherByOrder,
  tryConsumeVoucher,
  tryConsumeVoucherUnreserved,
} from '../../utils/voucher-reservation.util';

describe('Reserva de voucher (integração, banco real)', () => {
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

  // Cria um voucher ACTIVE real e devolve seu id.
  const seedVoucher = async (eventId: string, over: Record<string, any> = {}) => {
    const v = await w.voucher.create({
      data: {
        eventId,
        name: 'Lote Voucher',
        code: `V-${randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
        ...over,
      },
      select: { id: true },
    });
    return v.id;
  };

  const readVoucher = (id: string) =>
    w.voucher.findUnique({
      where: { id },
      select: { status: true, reservedByOrderId: true, reservedUntil: true, usedBy: true },
    });

  const future = () => new Date(Date.now() + 30 * 60 * 1000);
  const past = () => new Date(Date.now() - 1000);

  it('um pedido reserva um voucher livre', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const voucherId = await seedVoucher(eventId);
    const orderA = randomUUID();

    const ok = await claimVoucher(w, voucherId, orderA, future());

    expect(ok).toBe(true);
    const v = await readVoucher(voucherId);
    expect(v.reservedByOrderId).toBe(orderA);
    expect(v.status).toBe('ACTIVE'); // reserva não muda o status
  });

  it('um segundo pedido NÃO consegue reservar o mesmo voucher', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const voucherId = await seedVoucher(eventId);
    const orderA = randomUUID();
    const orderB = randomUUID();

    expect(await claimVoucher(w, voucherId, orderA, future())).toBe(true);
    expect(await claimVoucher(w, voucherId, orderB, future())).toBe(false); // bloqueado

    const v = await readVoucher(voucherId);
    expect(v.reservedByOrderId).toBe(orderA); // continua com o primeiro
  });

  it('o mesmo pedido pode reservar de novo (idempotente)', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const voucherId = await seedVoucher(eventId);
    const orderA = randomUUID();

    expect(await claimVoucher(w, voucherId, orderA, future())).toBe(true);
    expect(await claimVoucher(w, voucherId, orderA, future())).toBe(true); // re-claim ok
  });

  it('reserva vencida pode ser pega por outro pedido', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const voucherId = await seedVoucher(eventId);
    const orderA = randomUUID();
    const orderB = randomUUID();

    // A reserva com prazo JÁ vencido (simula carrinho abandonado).
    expect(await claimVoucher(w, voucherId, orderA, past())).toBe(true);
    // B consegue pegar porque a reserva de A venceu.
    expect(await claimVoucher(w, voucherId, orderB, future())).toBe(true);

    const v = await readVoucher(voucherId);
    expect(v.reservedByOrderId).toBe(orderB);
  });

  it('liberar pelo pedido devolve o voucher para disponível', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const voucherId = await seedVoucher(eventId);
    const orderA = randomUUID();
    const orderB = randomUUID();

    await claimVoucher(w, voucherId, orderA, future());
    await releaseVoucherByOrder(w, orderA);

    const v = await readVoucher(voucherId);
    expect(v.reservedByOrderId).toBeNull();
    // Agora outro pedido consegue reservar.
    expect(await claimVoucher(w, voucherId, orderB, future())).toBe(true);
  });

  it('o pedido dono consome o voucher na finalização (vira USED)', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const voucherId = await seedVoucher(eventId);
    const userId = await seedUser(prisma, 'USER');
    const orderA = randomUUID();

    await claimVoucher(w, voucherId, orderA, future());
    const consumed = await tryConsumeVoucher(w, voucherId, orderA, userId);

    expect(consumed).toBe(true);
    const v = await readVoucher(voucherId);
    expect(v.status).toBe('USED');
    expect(v.usedBy).toBe(userId);
    expect(v.reservedByOrderId).toBeNull(); // reserva limpa ao consumir
  });

  it('um segundo pedido NÃO consegue consumir um voucher já usado (trava dupla-concessão)', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const voucherId = await seedVoucher(eventId);
    const userId = await seedUser(prisma, 'USER');
    const orderA = randomUUID();
    const orderB = randomUUID();

    await claimVoucher(w, voucherId, orderA, future());
    expect(await tryConsumeVoucher(w, voucherId, orderA, userId)).toBe(true);
    // B tenta consumir o mesmo voucher → já está USED → falha (o caller aborta o finalize).
    expect(await tryConsumeVoucher(w, voucherId, orderB, userId)).toBe(false);
  });

  it('voucher legado sem reserva (ACTIVE, reservedByOrderId null) ainda pode ser consumido uma vez', async () => {
    const { eventId } = await seedOrgUserEvent(prisma);
    const voucherId = await seedVoucher(eventId); // nunca reservado
    const userId = await seedUser(prisma, 'USER');
    const orderA = randomUUID();
    const orderB = randomUUID();

    // Primeiro pedido consome (cobre pedidos criados antes da reserva existir).
    expect(await tryConsumeVoucher(w, voucherId, orderA, userId)).toBe(true);
    // Segundo já não consegue.
    expect(await tryConsumeVoucher(w, voucherId, orderB, userId)).toBe(false);
  });

  // ── tryConsumeVoucherUnreserved (regressão 2026-06-04) ───────────────────────
  // Fluxos SEM pedido próprio (ex.: POST /registrations legado) consumiam o voucher por
  // status apenas — bypass do uso único: roubavam voucher RESERVADO por outro checkout.
  describe('tryConsumeVoucherUnreserved (fluxos sem pedido próprio)', () => {
    it('voucher LIVRE → consome (vira USED)', async () => {
      const { eventId } = await seedOrgUserEvent(prisma);
      const voucherId = await seedVoucher(eventId);
      const userId = await seedUser(prisma, 'USER');

      expect(await tryConsumeVoucherUnreserved(w, voucherId, userId)).toBe(true);
      const v = await readVoucher(voucherId);
      expect(v.status).toBe('USED');
      expect(v.usedBy).toBe(userId);
    });

    it('voucher RESERVADO por checkout ativo → NÃO consome (fecha o bypass)', async () => {
      const { eventId } = await seedOrgUserEvent(prisma);
      const voucherId = await seedVoucher(eventId);
      const userId = await seedUser(prisma, 'USER');
      const checkoutOrder = randomUUID();
      await claimVoucher(w, voucherId, checkoutOrder, future());

      expect(await tryConsumeVoucherUnreserved(w, voucherId, userId)).toBe(false);
      const v = await readVoucher(voucherId);
      expect(v.status).toBe('ACTIVE'); // intacto — o checkout dono segue protegido
      expect(v.reservedByOrderId).toBe(checkoutOrder);
    });

    it('reserva VENCIDA (carrinho abandonado) → consome normalmente', async () => {
      const { eventId } = await seedOrgUserEvent(prisma);
      const voucherId = await seedVoucher(eventId);
      const userId = await seedUser(prisma, 'USER');
      await w.voucher.update({
        where: { id: voucherId },
        data: { reservedByOrderId: randomUUID(), reservedUntil: past() },
      });

      expect(await tryConsumeVoucherUnreserved(w, voucherId, userId)).toBe(true);
      const v = await readVoucher(voucherId);
      expect(v.status).toBe('USED');
      expect(v.reservedByOrderId).toBeNull();
    });

    it('voucher já USED → não consome de novo', async () => {
      const { eventId } = await seedOrgUserEvent(prisma);
      const voucherId = await seedVoucher(eventId, { status: 'USED', usedAt: new Date() });
      const userId = await seedUser(prisma, 'USER');

      expect(await tryConsumeVoucherUnreserved(w, voucherId, userId)).toBe(false);
    });
  });
});
