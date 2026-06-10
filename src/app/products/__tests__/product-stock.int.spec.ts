/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: controle de estoque + contagem de vendas das VARIAÇÕES de produto.
 *
 *  Campos em ProductVariation:
 *    • stock          = LIMITE configurado pelo organizador (0 = ilimitado).
 *    • availableStock = restante (segura no checkout, devolve no cancel/estorno).
 *    • soldCount      = unidades vendidas (confirmadas no pay, revertidas no estorno).
 *
 *  EM RESUMO, conferimos contra um Postgres REAL o SQL atômico dos helpers:
 *    • acquireVariationHold: decrementa availableStock; BLOQUEIA (0 linhas) se faltar;
 *      no-op para ilimitado (stock = 0).
 *    • releaseVariationHold: devolve com clamp LEAST(.., stock) — nunca passa do limite.
 *    • increment/decrementVariationSold: soldCount com clamp GREATEST(.., 0).
 *    • reverseSaleSideEffects (estorno/chargeback): por RegistrationProduct, soldCount--
 *      sempre e availableStock++ só para itens que seguraram estoque (productSnapshot.stockHeld).
 *      Mantém a invariante availableStock + soldCount == stock para stock > 0.
 * ============================================================================
 */
import { PrismaService } from '../../../prisma/prisma.service';
import {
  createTestPrisma,
  resetDb,
  seedOrgUserEvent,
} from '../../../common/testing/integration-db';
import { OrderFinalizationService } from '../../payments/order-finalization.service';
import {
  acquireVariationHold,
  releaseVariationHold,
  incrementVariationSold,
  decrementVariationSold,
} from '../../../common/utils/product-stock.util';

describe('Controle de estoque de variação (integração, banco real)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  /** Cria um produto com 1 variação e devolve os ids + um leitor do estado da variação. */
  async function seedProductVariation(opts: {
    eventId: string;
    isIncludedInTicket?: boolean;
    isRequired?: boolean;
    stock: number;
    availableStock?: number;
    soldCount?: number;
  }) {
    const w = prisma.getWriteClient();
    const product = await w.product.create({
      data: {
        eventId: opts.eventId,
        name: 'Camiseta',
        isIncludedInTicket: opts.isIncludedInTicket ?? false,
        isRequired: opts.isRequired ?? false,
        basePrice: 5000,
        variations: {
          create: {
            name: 'M',
            price: 0,
            stock: opts.stock,
            availableStock: opts.availableStock ?? opts.stock,
            soldCount: opts.soldCount ?? 0,
          },
        },
      },
      include: { variations: true },
    });
    const variationId = product.variations[0].id;
    const read = async () =>
      prisma.getReadClient().productVariation.findUnique({
        where: { id: variationId },
        select: { stock: true, availableStock: true, soldCount: true },
      });
    return { productId: product.id, variationId, read };
  }

  describe('hold atômico (acquireVariationHold)', () => {
    it('segura quando há estoque; BLOQUEIA (0 linhas) quando falta — availableStock intacto', async () => {
      const { eventId } = await seedOrgUserEvent(prisma);
      const { variationId, read } = await seedProductVariation({ eventId, stock: 10 });
      const w = prisma.getWriteClient();

      const ok = await acquireVariationHold(w, variationId, 8);
      expect(ok).toBe(1);
      expect((await read())?.availableStock).toBe(2);

      // Pede 5, só há 2 → guard `availableStock >= qty` falha → 0 linhas, sem mexer no restante.
      const blocked = await acquireVariationHold(w, variationId, 5);
      expect(blocked).toBe(0);
      expect((await read())?.availableStock).toBe(2);
    });

    it('estoque ilimitado (stock = 0) → no-op (guard stock > 0), nunca bloqueia', async () => {
      const { eventId } = await seedOrgUserEvent(prisma);
      const { variationId, read } = await seedProductVariation({ eventId, stock: 0 });
      const w = prisma.getWriteClient();

      const r = await acquireVariationHold(w, variationId, 999);
      expect(r).toBe(0); // 0 linhas, mas é no-op (não é "esgotado" — caller só segura quando stock > 0)
      expect((await read())?.availableStock).toBe(0);
    });
  });

  describe('release (releaseVariationHold) — clamp no limite', () => {
    it('devolve sem ultrapassar o stock (LEAST)', async () => {
      const { eventId } = await seedOrgUserEvent(prisma);
      const { variationId, read } = await seedProductVariation({ eventId, stock: 10, availableStock: 4 });
      const w = prisma.getWriteClient();

      await releaseVariationHold(w, variationId, 3);
      expect((await read())?.availableStock).toBe(7);

      // Devolver 100 não passa do limite 10.
      await releaseVariationHold(w, variationId, 100);
      expect((await read())?.availableStock).toBe(10);
    });
  });

  describe('soldCount (increment/decrement) — clamp em 0', () => {
    it('incrementa e decrementa, nunca abaixo de 0 (GREATEST)', async () => {
      const { eventId } = await seedOrgUserEvent(prisma);
      const { variationId, read } = await seedProductVariation({ eventId, stock: 10, soldCount: 0 });
      const w = prisma.getWriteClient();

      await incrementVariationSold(w, variationId, 3);
      expect((await read())?.soldCount).toBe(3);

      await decrementVariationSold(w, variationId, 5); // replay/over-revert
      expect((await read())?.soldCount).toBe(0);
    });
  });

  describe('reverseSaleSideEffects — estorno devolve estoque/venda corretamente', () => {
    it('item que segurou estoque → soldCount-- E availableStock++; incluso+obrigatório → só soldCount--', async () => {
      const { eventId, adminUserId } = await seedOrgUserEvent(prisma);
      const w = prisma.getWriteClient();

      // Variação OPCIONAL (segurou estoque): vendeu 2 → stock 10, avail 8, sold 2.
      const opt = await seedProductVariation({
        eventId, isIncludedInTicket: false, isRequired: false,
        stock: 10, availableStock: 8, soldCount: 2,
      });
      // Variação INCLUSA+OBRIGATÓRIA (não segura estoque): vendeu 2 → avail intacto (10), sold 2.
      const inc = await seedProductVariation({
        eventId, isIncludedInTicket: true, isRequired: true,
        stock: 10, availableStock: 10, soldCount: 2,
      });

      // Pedido PAGO mínimo com 1 inscrição confirmada + 2 RegistrationProduct.
      const order = await w.order.create({
        data: { userId: adminUserId, eventId, status: 'PAID', totalAmount: 0, serviceFee: 0, finalAmount: 0 },
        select: { id: true },
      });
      const reg = await w.registration.create({
        data: { orderId: order.id, userId: adminUserId, eventId, status: 'CONFIRMED' },
        select: { id: true },
      });
      await w.registrationProduct.create({
        data: {
          registrationId: reg.id, productId: opt.productId, variationId: opt.variationId,
          quantity: 2, unitPrice: 5000, totalPrice: 10000,
          productSnapshot: { isIncludedInTicket: false, isRequired: false, stockHeld: true },
        },
      });
      await w.registrationProduct.create({
        data: {
          registrationId: reg.id, productId: inc.productId, variationId: inc.variationId,
          quantity: 2, unitPrice: 0, totalPrice: 0,
          productSnapshot: { isIncludedInTicket: true, isRequired: true, stockHeld: false },
        },
      });

      const finalization = new OrderFinalizationService(prisma, { record: () => {} } as any);
      await prisma.getWriteClient().$transaction((tx: any) =>
        finalization.reverseSaleSideEffects(tx, order.id),
      );

      const optAfter = await opt.read();
      const incAfter = await inc.read();

      // Opcional: venda revertida (sold 0) e estoque devolvido (avail 10). Invariante 10+0=10.
      expect(optAfter).toMatchObject({ stock: 10, availableStock: 10, soldCount: 0 });
      // Incluso+obrigatório: só a venda reverte; availableStock NUNCA foi tocado.
      expect(incAfter).toMatchObject({ stock: 10, availableStock: 10, soldCount: 0 });
    });
  });
});
