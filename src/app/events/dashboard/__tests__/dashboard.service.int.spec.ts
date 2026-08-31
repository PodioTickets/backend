/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o PAINEL (dashboard) do organizador de um evento.
 *           São os números e gráficos que o organizador vê: quanto faturou,
 *           quantas inscrições foram pagas / canceladas / estornadas, de quais
 *           cidades vieram os participantes e quando as vendas aconteceram.
 *
 *  EM RESUMO:
 *    O serviço lê o banco com consultas SQL pesadas e devolve métricas prontas:
 *      • OVERVIEW  → receita líquida, ticket médio, contagens por status e um
 *                    gráfico de tendência (receita/contagem por período).
 *      • RANKINGS  → ranking de ingressos mais vendidos e vendas por método.
 *      • SECONDARY → cidades que mais inscreveram e mapa de calor de vendas.
 *
 *  REGRA DE DINHEIRO (a mais importante para conferir):
 *    A "receita líquida" de um pedido é:
 *        (valorFinal − taxaDeServiço) × (1 − taxaDoOrganizador%)
 *    Cada PEDIDO é contado UMA vez (mesmo que tenha vários participantes).
 *    Só entram pedidos com inscrição CONFIRMADA e pagamento PAGO.
 *
 *  REGRA DE CONTAGEM POR STATUS:
 *    • paga      = inscrição CONFIRMED + pagamento PAID
 *    • cancelada = inscrição CANCELLED (independente do pagamento)
 *    • estornada = pagamento REFUNDED  (independente da inscrição)
 *
 *  COMO CONFERIMOS:
 *    Teste DE VERDADE contra um Postgres de teste (descartável). Criamos
 *    evento, ingressos, pedidos, pagamentos e inscrições REAIS com valores
 *    escolhidos a dedo, chamamos o serviço e conferimos que as somas/contagens
 *    batem EXATAMENTE com o que semeamos. O cache Redis é simulado como
 *    "sempre vazio" (fail-open) para garantir que o cálculo real sempre roda.
 * ============================================================================
 *
 *  PREMISSAS / DECISÕES DE SEED:
 *    - Período usado nos cenários principais: GERAL (sem filtro de data) →
 *      torna as somas determinísticas, independentes da data de execução.
 *    - `organizerFeePercent` é gravado no PRÓPRIO pedido (snapshot), então a
 *      fórmula não depende da config viva do evento. Usamos valores redondos.
 *    - O acesso é liberado via usuário ADMIN (seedUser default), que faz bypass
 *      na checagem de organização (assertCanAccessEvent).
 *    - A seção geográfica (topCities + mapa) sai do endereço de COBRANÇA do
 *      pedido, então os cenários preenchem `billing*` no seedOrder — o cadastro
 *      do User não influencia.
 */
import { PrismaService } from '../../../../prisma/prisma.service';
import { DashboardService } from '../dashboard.service';
import { OrganizerMemberAccessService } from '../../../organizations/organizer-member-access.service';
import { DashboardPeriod } from '../dashboard-period.util';
import {
  createTestPrisma,
  resetDb,
  seedOrgUserEvent,
  seedUser,
} from '../../../../common/testing/integration-db';

// ---------------------------------------------------------------------------
// Cache Redis simulado: fail-open. getJson sempre null (miss) → força cálculo
// real; setJson vira no-op. Garante que NUNCA servimos resposta cacheada.
// ---------------------------------------------------------------------------
const cacheStub: any = {
  getJson: async () => null,
  setJson: async () => undefined,
  del: async () => undefined,
  isAvailable: () => false,
};

// TicketsService é exercitado só pelo bloco `tickets` do rankings; mockamos
// para um retorno previsível e focamos os asserts no SQL do dashboard.
const ticketsServiceStub: any = {
  findAll: async () => ({ data: { tickets: [], pagination: { total: 0 } } }),
};

// GeoService: sem geocoding no teste — devolve coords nulas (locais "pendentes").
const geoServiceStub: any = {
  resolveMany: async (locs: any[]) => locs.map(() => ({ coord: null, pending: true })),
};

describe('DashboardService (integração, banco real)', () => {
  let prisma: PrismaService;
  let service: DashboardService;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    const access = new OrganizerMemberAccessService(prisma);
    service = new DashboardService(prisma, cacheStub, access, ticketsServiceStub, geoServiceStub);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  // -------------------------------------------------------------------------
  // Helpers de seed (linhas REAIS no banco de teste)
  // -------------------------------------------------------------------------
  const db = () => prisma.getWriteClient();

  /** Cria um ingresso real (Ticket) sob o evento, com 1 lote (TicketBatch). */
  async function seedTicketWithBatch(
    eventId: string,
    opts: { name?: string; quantity?: number; categoryId?: string | null } = {},
  ) {
    const ticket = await db().ticket.create({
      data: {
        eventId,
        categoryId: opts.categoryId ?? null,
        name: opts.name ?? 'Ingresso',
        modality: 'Corrida',
        isActive: true,
      },
      select: { id: true },
    });
    const quantity = opts.quantity ?? 100;
    const batch = await db().ticketBatch.create({
      data: {
        ticketId: ticket.id,
        quantity,
        availableQuantity: quantity,
        price: 5000,
        sortOrder: 0,
      },
      select: { id: true },
    });
    return { ticketId: ticket.id, batchId: batch.id };
  }

  /**
   * Cria um PEDIDO completo: Order + Payment + N Registrations (1 por
   * participante), cada uma com 1 RegistrationTicket no ticket informado.
   *
   * Permite controlar status de pedido/pagamento/inscrição para cobrir os
   * cenários pago/cancelado/estornado.
   */
  async function seedOrder(opts: {
    eventId: string;
    buyerUserId: string;
    ticketId: string;
    batchId?: string;
    finalAmount: number;
    serviceFee: number;
    organizerFeePercent: number;
    orderStatus?: 'PAID' | 'CANCELLED' | 'PENDING';
    paymentStatus?: 'PAID' | 'REFUNDED' | 'PENDING' | 'FAILED' | null;
    paymentMethod?: 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'BOLETO' | 'CRYPTO';
    registrationStatus?: 'CONFIRMED' | 'CANCELLED' | 'PENDING' | 'COMPLETED';
    participants?: { userId: string }[];
    createdAt?: Date;
    totalAmount?: number;
    billingNeighborhood?: string;
    billingCity?: string;
    billingStateUf?: string;
  }) {
    const createdAt = opts.createdAt ?? new Date('2026-05-15T13:00:00.000Z');
    const order = await db().order.create({
      data: {
        userId: opts.buyerUserId,
        eventId: opts.eventId,
        totalAmount: opts.totalAmount ?? opts.finalAmount,
        serviceFee: opts.serviceFee,
        finalAmount: opts.finalAmount,
        organizerFeePercent: opts.organizerFeePercent,
        status: (opts.orderStatus ?? 'PAID') as any,
        billingNeighborhood: opts.billingNeighborhood ?? null,
        billingCity: opts.billingCity ?? null,
        billingStateUf: opts.billingStateUf ?? null,
        createdAt,
      },
      select: { id: true },
    });

    // Por padrão um pedido é PAGO (alinhado aos defaults orderStatus=PAID /
    // registrationStatus=CONFIRMED). Só pulamos a criação do Payment quando o
    // cenário pede EXPLICITAMENTE `paymentStatus: null` (pedido sem pagamento).
    const paymentStatus =
      opts.paymentStatus === undefined ? 'PAID' : opts.paymentStatus;
    if (paymentStatus) {
      await db().payment.create({
        data: {
          orderId: order.id,
          userId: opts.buyerUserId,
          method: (opts.paymentMethod ?? 'PIX') as any,
          status: paymentStatus as any,
          amount: opts.finalAmount,
          createdAt,
        },
      });
    }

    const participants = opts.participants ?? [{ userId: opts.buyerUserId }];
    const regIds: string[] = [];
    for (const p of participants) {
      const reg = await db().registration.create({
        data: {
          eventId: opts.eventId,
          orderId: order.id,
          userId: p.userId,
          status: (opts.registrationStatus ?? 'CONFIRMED') as any,
          createdAt,
        },
        select: { id: true },
      });
      await db().registrationTicket.create({
        data: {
          registrationId: reg.id,
          ticketId: opts.ticketId,
          batchId: opts.batchId ?? null,
        },
      });
      regIds.push(reg.id);
    }

    return { orderId: order.id, registrationIds: regIds };
  }

  /** Net revenue esperado de UM pedido (fórmula do serviço, arredondamento bigint). */
  const expectedNet = (finalAmount: number, serviceFee: number, feePercent: number) =>
    Math.round(Math.max(finalAmount - serviceFee, 0) * (1 - feePercent / 100));

  // =========================================================================
  // OVERVIEW
  // =========================================================================
  describe('getOverview', () => {
    it('soma a receita líquida só de pedidos pagos+confirmados e conta cada pedido 1x', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const { ticketId, batchId } = await seedTicketWithBatch(eventId);

      // Pedido pago A: final 10000, taxa 1000, organizador 10% → (10000-1000)*0.9 = 8100
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 10000,
        serviceFee: 1000,
        organizerFeePercent: 10,
      });
      // Pedido pago B com 2 participantes (deve continuar contando 1 pedido):
      // final 20000, taxa 2000, organizador 10% → (20000-2000)*0.9 = 16200
      const p2 = await seedUser(prisma, 'USER');
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 20000,
        serviceFee: 2000,
        organizerFeePercent: 10,
        participants: [{ userId: adminUserId }, { userId: p2 }],
      });
      // Pedido NÃO pago (pagamento PENDING) — não deve entrar na receita.
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 99999,
        serviceFee: 0,
        organizerFeePercent: 10,
        paymentStatus: 'PENDING',
        registrationStatus: 'PENDING',
        orderStatus: 'PENDING',
      });

      const res: any = await service.getOverview(adminUserId, eventId, {
        period: DashboardPeriod.GERAL,
      } as any);

      const expected =
        expectedNet(10000, 1000, 10) + expectedNet(20000, 2000, 10); // 8100 + 16200
      expect(res.data.metrics.netRevenue).toBe(expected);
      // 2 pedidos pagos distintos (o pedido B com 2 participantes ainda é 1).
      // averageTicket = receita / nº de pedidos.
      expect(res.data.metrics.averageTicket).toBeCloseTo(expected / 2, 5);
    });

    it('conta inscrições pagas, canceladas e estornadas corretamente', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const { ticketId, batchId } = await seedTicketWithBatch(eventId);
      const u = async () => seedUser(prisma, 'USER');

      // 2 inscrições pagas (CONFIRMED + PAID)
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 5000,
        serviceFee: 500,
        organizerFeePercent: 0,
        participants: [{ userId: await u() }, { userId: await u() }],
      });
      // 1 inscrição cancelada (CANCELLED)
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 5000,
        serviceFee: 500,
        organizerFeePercent: 0,
        registrationStatus: 'CANCELLED',
        orderStatus: 'CANCELLED',
        paymentStatus: 'FAILED',
        participants: [{ userId: await u() }],
      });
      // 1 inscrição estornada (reg CONFIRMED + payment REFUNDED)
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 5000,
        serviceFee: 500,
        organizerFeePercent: 0,
        registrationStatus: 'CONFIRMED',
        paymentStatus: 'REFUNDED',
        participants: [{ userId: await u() }],
      });

      const res: any = await service.getOverview(adminUserId, eventId, {
        period: DashboardPeriod.GERAL,
      } as any);

      expect(res.data.metrics.totalRegistrations).toBe(2); // pagas
      expect(res.data.metrics.cancellations).toBe(1);
      expect(res.data.metrics.refunds).toBe(1);
    });

    it('zera tudo quando o evento não tem nenhum pedido', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);

      const res: any = await service.getOverview(adminUserId, eventId, {
        period: DashboardPeriod.GERAL,
      } as any);

      expect(res.data.metrics.netRevenue).toBe(0);
      expect(res.data.metrics.totalRegistrations).toBe(0);
      expect(res.data.metrics.averageTicket).toBe(0);
      // GERAL não tem comparação → todas as variações são 0.
      expect(res.data.metrics.netRevenueChange).toBe(0);
    });

    it('chart por status: receita de pedido cai no bucket de maior prioridade (refunded > confirmed > canceled)', async () => {
      // No período GERAL o chart agrupa por mês (YYYY-MM). Semeamos tudo em
      // 2026-05 para concentrar num único bucket e somar de forma determinística.
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const { ticketId, batchId } = await seedTicketWithBatch(eventId);
      const may = new Date('2026-05-10T10:00:00.000Z');

      // Pedido confirmado: net = (10000-0)*1.0 = 10000 → bucket confirmed
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 10000,
        serviceFee: 0,
        organizerFeePercent: 0,
        createdAt: may,
      });
      // Pedido estornado: net = 7000 → bucket refunded (prioridade máxima)
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 7000,
        serviceFee: 0,
        organizerFeePercent: 0,
        registrationStatus: 'CONFIRMED',
        paymentStatus: 'REFUNDED',
        createdAt: may,
      });
      // Pedido cancelado: net = 3000 → bucket canceled
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 3000,
        serviceFee: 0,
        organizerFeePercent: 0,
        registrationStatus: 'CANCELLED',
        orderStatus: 'CANCELLED',
        paymentStatus: 'FAILED',
        createdAt: may,
      });

      const res: any = await service.getOverview(adminUserId, eventId, {
        period: DashboardPeriod.GERAL,
      } as any);

      const chart = res.data.registrationsTrend.chartData;
      const mayPoint = chart.dailyData.find((d: any) => d.date === '2026-05');
      expect(mayPoint).toBeDefined();
      // revenue do chart = receita do bucket confirmed
      expect(mayPoint.revenue).toBe(10000);
      expect(mayPoint.refundedRevenue).toBe(7000);
      expect(mayPoint.canceledRevenue).toBe(3000);
      // contagens por status no bucket (1 cada)
      expect(mayPoint.confirmed).toBe(1);
      expect(mayPoint.canceled).toBe(1);
      expect(mayPoint.refunded).toBe(1);

      // topo do registrationsTrend espelha as métricas agregadas
      expect(res.data.registrationsTrend.confirmed).toBe(1);
      expect(res.data.registrationsTrend.canceled).toBe(1);
      expect(res.data.registrationsTrend.refunded).toBe(1);
    });
  });

  // =========================================================================
  // RANKINGS
  // =========================================================================
  describe('getRankings', () => {
    it('ranqueia ingressos por quantidade vendida e rateia a receita líquida por item do pedido', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const a = await seedTicketWithBatch(eventId, { name: 'Ingresso A' });
      const b = await seedTicketWithBatch(eventId, { name: 'Ingresso B' });

      // Pedido 1: 1 participante no ingresso A. final 10000, organizador 0 →
      // net 10000, 1 item → A recebe 10000.
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId: a.ticketId,
        batchId: a.batchId,
        finalAmount: 10000,
        serviceFee: 0,
        organizerFeePercent: 0,
      });
      // Pedido 2: 1 participante no ingresso A (mais 1 venda de A).
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId: a.ticketId,
        batchId: a.batchId,
        finalAmount: 6000,
        serviceFee: 0,
        organizerFeePercent: 0,
        participants: [{ userId: await seedUser(prisma, 'USER') }],
      });
      // Pedido 3: 1 participante no ingresso B.
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId: b.ticketId,
        batchId: b.batchId,
        finalAmount: 4000,
        serviceFee: 0,
        organizerFeePercent: 0,
        participants: [{ userId: await seedUser(prisma, 'USER') }],
      });

      const res: any = await service.getRankings(adminUserId, eventId, {
        period: DashboardPeriod.GERAL,
      } as any);

      const ranking = res.data.ticketRanking.data;
      expect(ranking).toHaveLength(2);
      // A vendeu 2, B vendeu 1 → A em primeiro.
      expect(ranking[0].name).toBe('Ingresso A');
      expect(ranking[0].quantity).toBe(2);
      expect(ranking[0].total).toBe(16000); // 10000 + 6000
      expect(ranking[1].name).toBe('Ingresso B');
      expect(ranking[1].quantity).toBe(1);
      expect(ranking[1].total).toBe(4000);
      expect(res.data.ticketRanking.pagination.total).toBe(2);
    });

    it('injeta organizerNet em cada ingresso do bloco tickets (mesma fonte do ticketRanking; 0 sem venda)', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const a = await seedTicketWithBatch(eventId, { name: 'Ingresso A' });
      const b = await seedTicketWithBatch(eventId, { name: 'Ingresso B' });
      const c = await seedTicketWithBatch(eventId, { name: 'Ingresso C (sem venda)' });

      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId: a.ticketId,
        batchId: a.batchId,
        finalAmount: 10000,
        serviceFee: 0,
        organizerFeePercent: 0,
      });
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId: b.ticketId,
        batchId: b.batchId,
        finalAmount: 4000,
        serviceFee: 0,
        organizerFeePercent: 0,
        participants: [{ userId: await seedUser(prisma, 'USER') }],
      });

      // Stub do bloco `tickets` espelha o catálogo (inclui o ingresso sem venda).
      const originalFindAll = ticketsServiceStub.findAll;
      ticketsServiceStub.findAll = async () => ({
        message: 'Tickets fetched successfully',
        data: {
          tickets: [
            { id: a.ticketId, name: 'Ingresso A' },
            { id: b.ticketId, name: 'Ingresso B' },
            { id: c.ticketId, name: 'Ingresso C (sem venda)' },
          ],
          pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
        },
      });

      try {
        const res: any = await service.getRankings(adminUserId, eventId, {
          period: DashboardPeriod.GERAL,
        } as any);

        const list = res.data.tickets.data.tickets;
        const byId = new Map(list.map((t: any) => [t.id, t.organizerNet]));
        expect(byId.get(a.ticketId)).toBe(10000);
        expect(byId.get(b.ticketId)).toBe(4000);
        // Sem venda no período → 0 (e bate com o ticketRanking).
        expect(byId.get(c.ticketId)).toBe(0);
      } finally {
        ticketsServiceStub.findAll = originalFindAll;
      }
    });

    it('vendas por método de pagamento somam o líquido por método (1 pedido = 1 venda)', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const { ticketId, batchId } = await seedTicketWithBatch(eventId);

      // 2 pedidos PIX (net 9000 cada) + 1 pedido CREDIT_CARD (net 8000)
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 10000,
        serviceFee: 1000,
        organizerFeePercent: 0,
        paymentMethod: 'PIX',
      });
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 10000,
        serviceFee: 1000,
        organizerFeePercent: 0,
        paymentMethod: 'PIX',
        participants: [{ userId: await seedUser(prisma, 'USER') }],
      });
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 10000,
        serviceFee: 2000,
        organizerFeePercent: 0,
        paymentMethod: 'CREDIT_CARD',
        participants: [{ userId: await seedUser(prisma, 'USER') }],
      });

      const res: any = await service.getRankings(adminUserId, eventId, {
        period: DashboardPeriod.GERAL,
      } as any);

      const byMethod = res.data.salesByPaymentMethod;
      const pix = byMethod.items.find((i: any) => i.method === 'PIX');
      const credit = byMethod.items.find((i: any) => i.method === 'CREDIT_CARD');
      expect(pix.salesCount).toBe(2);
      expect(pix.totalAmount).toBe(18000); // 9000 * 2
      expect(credit.salesCount).toBe(1);
      expect(credit.totalAmount).toBe(8000);
      expect(byMethod.totals.salesCount).toBe(3);
      expect(byMethod.totals.totalAmount).toBe(26000);
      // percentuais somam ~100
      const sumPct = byMethod.items.reduce((s: number, i: any) => s + i.percentage, 0);
      expect(sumPct).toBeCloseTo(100, 5);
    });
  });

  // =========================================================================
  // SECONDARY
  // =========================================================================
  describe('getSecondary', () => {
    it('topCities soma os bairros do billing e conta 1 por PEDIDO pago (mesma base do mapa)', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const { ticketId, batchId } = await seedTicketWithBatch(eventId);
      const acompanhante = await seedUser(prisma, 'USER');

      // SP: 3 pedidos pagos em 2 bairros, variando acento/caixa na cidade. O 3º
      // leva 2 ingressos — continua valendo 1 compra (a unidade é o PEDIDO).
      const pedidosSp = [
        { neighborhood: 'Moema', city: 'São Paulo', uf: 'SP', participants: undefined as any },
        { neighborhood: 'Pinheiros', city: 'sao paulo', uf: 'sp', participants: undefined as any },
        {
          neighborhood: 'Moema',
          city: 'SAO PAULO',
          uf: 'SP',
          participants: [{ userId: adminUserId }, { userId: acompanhante }],
        },
      ];
      for (const p of pedidosSp) {
        await seedOrder({
          eventId,
          buyerUserId: adminUserId,
          ticketId,
          batchId,
          finalAmount: 5000,
          serviceFee: 0,
          organizerFeePercent: 0,
          billingNeighborhood: p.neighborhood,
          billingCity: p.city,
          billingStateUf: p.uf,
          participants: p.participants,
        });
      }
      // Rio: 1 pedido pago.
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 5000,
        serviceFee: 0,
        organizerFeePercent: 0,
        billingNeighborhood: 'Copacabana',
        billingCity: 'Rio de Janeiro',
        billingStateUf: 'RJ',
      });

      const res: any = await service.getSecondary(adminUserId, eventId, {
        period: DashboardPeriod.GERAL,
      } as any);

      const norm = (s: string) =>
        s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
      const cities = res.data.topCities;

      // São Paulo consolidada em 1 entrada com 3 COMPRAS (não 4 inscrições).
      expect(cities[0].purchases).toBe(3);
      expect(norm(cities[0].city)).toBe('sao paulo');
      const rioEntry = cities.find((c: any) => c.city.includes('Rio'));
      expect(rioEntry?.purchases).toBe(1);

      // Card e mapa saem da mesma agregação: o número da cidade é exatamente a
      // soma dos bairros dela no mapa.
      const spNoMapa = res.data.purchaseLocations
        .filter((l: any) => norm(l.city) === 'sao paulo')
        .reduce((acc: number, l: any) => acc + l.purchases, 0);
      expect(spNoMapa).toBe(cities[0].purchases);
      // Os 2 bairros de SP continuam separados no mapa (2 em Moema, 1 em Pinheiros).
      const moema = res.data.purchaseLocations.find((l: any) => l.neighborhood === 'Moema');
      expect(moema?.purchases).toBe(2);
    });

    it('salesHeatmap conta vendas pagas+confirmadas por dia-da-semana e hora do pedido', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const { ticketId, batchId } = await seedTicketWithBatch(eventId);

      // 2026-05-15 é uma sexta-feira (DOW=5). Hora 13 UTC.
      const sexta13 = new Date('2026-05-15T13:00:00.000Z');
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 5000,
        serviceFee: 0,
        organizerFeePercent: 0,
        createdAt: sexta13,
      });
      await seedOrder({
        eventId,
        buyerUserId: adminUserId,
        ticketId,
        batchId,
        finalAmount: 5000,
        serviceFee: 0,
        organizerFeePercent: 0,
        createdAt: sexta13,
        participants: [{ userId: await seedUser(prisma, 'USER') }],
      });

      const res: any = await service.getSecondary(adminUserId, eventId, {
        period: DashboardPeriod.GERAL,
      } as any);

      const heatmap = res.data.salesHeatmap;
      // 2 inscrições pagas em sexta 13h.
      const cell = heatmap.find((h: any) => h.hour === 13);
      expect(cell).toBeDefined();
      expect(cell.sales).toBe(2);
    });
  });
});
