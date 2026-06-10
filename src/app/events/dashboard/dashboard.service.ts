import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { CacheRedisService } from '../../../common/services/cache-redis.service';
import { OrganizerMemberAccessService } from '../../organizations/organizer-member-access.service';
import { TicketsService } from '../../tickets/tickets.service';
import { DashboardOverviewQueryDto } from './dto/overview.dto';
import { DashboardRankingsQueryDto } from './dto/rankings.dto';
import { DashboardSecondaryQueryDto } from './dto/secondary.dto';
import {
  DashboardPeriod,
  calculateDateRange,
  getComparisonBounds,
  percentChange,
  eachUtcDayKeys,
  lastSixMonthKeys,
  DateRange,
} from './dashboard-period.util';

/**
 * Linhas brutas vindas do Postgres — `BIGINT` chega como `bigint` em JS.
 * Helpers `toNum` cuidam da conversão pra `number` (centavos cabem em Number.MAX_SAFE_INTEGER).
 */
interface MetricsAggregateRow {
  order_count: bigint;
  net_revenue: bigint;
}
interface RegCountsRow {
  paid_regs: bigint;
  cancelled_regs: bigint;
  refunded_regs: bigint;
}
interface OrderBucketRow {
  bucket_key: string;
  status_bucket: 'confirmed' | 'canceled' | 'refunded' | 'other';
  net_revenue: bigint;
  order_count: bigint;
}
interface RegBucketRow {
  bucket_key: string;
  confirmed: bigint;
  canceled: bigint;
  refunded: bigint;
}
interface TicketRankingRow {
  item_id: string;
  item_name: string;
  category_name: string | null;
  is_modality: boolean;
  quantity: bigint;
  total_net: bigint;
}
interface CityRow {
  city: string;
  state: string | null;
  participants: bigint;
}
interface HeatmapRow {
  dow: number;
  hour: number;
  sales: bigint;
}

const CACHE_TTL_OVERVIEW = 30;
const CACHE_TTL_RANKINGS = 30;
const CACHE_TTL_SECONDARY = 60;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheRedisService,
    private readonly organizerMemberAccess: OrganizerMemberAccessService,
    private readonly ticketsService: TicketsService,
  ) {}

  // ============================================================
  // OVERVIEW — métricas KPI + chart de tendência
  // ============================================================

  async getOverview(userId: string, eventId: string, query: DashboardOverviewQueryDto) {
    await this.assertAccess(userId, eventId);

    const period = query.period ?? DashboardPeriod.GERAL;
    const ticketIds = query.ticketIds ?? null;

    const cacheKey = this.buildCacheKey('overview', eventId, { period, ticketIds });
    const cached = await this.cache.getJson<unknown>(cacheKey);
    if (cached) return cached;

    const prismaRead = this.prisma.getReadClient();
    const eventConfig = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizerFeePercent: true },
    });
    const organizerFeeRate = (eventConfig?.organizerFeePercent ?? 0) / 100;

    const dateRange = calculateDateRange(period);
    const comparison = getComparisonBounds(dateRange, new Date(), period);

    const [
      currentAgg,
      currentRegs,
      prevAgg,
      prevRegs,
      orderBuckets,
      regBuckets,
    ] = await Promise.all([
      this.queryMetricsAggregate(eventId, dateRange, ticketIds, organizerFeeRate),
      this.queryRegCounts(eventId, dateRange, ticketIds),
      comparison
        ? this.queryMetricsAggregate(
            eventId,
            { start: comparison.prevStart, end: comparison.prevEndExclusive },
            ticketIds,
            organizerFeeRate,
          )
        : Promise.resolve({ order_count: BigInt(0), net_revenue: BigInt(0) } as MetricsAggregateRow),
      comparison
        ? this.queryRegCounts(
            eventId,
            { start: comparison.prevStart, end: comparison.prevEndExclusive },
            ticketIds,
          )
        : Promise.resolve({
            paid_regs: BigInt(0),
            cancelled_regs: BigInt(0),
            refunded_regs: BigInt(0),
          } as RegCountsRow),
      this.queryChartOrderBuckets(eventId, period, dateRange, ticketIds, organizerFeeRate),
      this.queryChartRegBuckets(eventId, period, dateRange, ticketIds),
    ]);

    const netRevenue = Number(currentAgg.net_revenue);
    const orderCount = Number(currentAgg.order_count);
    const totalRegistrations = Number(currentRegs.paid_regs);
    const cancellations = Number(currentRegs.cancelled_regs);
    const refunds = Number(currentRegs.refunded_regs);
    const averageTicket = orderCount > 0 ? netRevenue / orderCount : 0;

    const prevNetRevenue = Number(prevAgg.net_revenue);
    const prevOrderCount = Number(prevAgg.order_count);
    const prevTotalRegistrations = Number(prevRegs.paid_regs);
    const prevAverageTicket = prevOrderCount > 0 ? prevNetRevenue / prevOrderCount : 0;

    const totalFinalized = totalRegistrations + cancellations;
    const cancellationRate = totalFinalized > 0 ? (cancellations / totalFinalized) * 100 : 0;
    const refundRate = totalFinalized > 0 ? (refunds / totalFinalized) * 100 : 0;

    const chartData = this.assembleChartData(period, dateRange, orderBuckets, regBuckets);

    const response = {
      message: 'Dashboard overview fetched successfully',
      data: {
        period: {
          selected: period,
          startDate: dateRange.start?.toISOString() ?? null,
          endDate: dateRange.end?.toISOString() ?? null,
        },
        metrics: {
          netRevenue,
          netRevenueChange: comparison ? percentChange(netRevenue, prevNetRevenue) : 0,
          averageTicket,
          averageTicketChange: comparison ? percentChange(averageTicket, prevAverageTicket) : 0,
          totalRegistrations,
          totalRegistrationsChange: comparison
            ? percentChange(totalRegistrations, prevTotalRegistrations)
            : 0,
          cancellations,
          cancellationsStatus: this.statusFromRate(cancellationRate, { warn: 5, critical: 10 }),
          refunds,
          refundsStatus: this.statusFromRate(refundRate, { warn: 2, critical: 5 }),
        },
        registrationsTrend: {
          amount: netRevenue,
          change: comparison ? percentChange(netRevenue, prevNetRevenue) : 0,
          confirmed: totalRegistrations,
          canceled: cancellations,
          refunded: refunds,
          chartData,
        },
      },
    };

    await this.cache.setJson(cacheKey, response, CACHE_TTL_OVERVIEW);
    return response;
  }

  // ============================================================
  // RANKINGS — ticketRanking, tickets, topProductVariations, lotsNearDepletion
  // ============================================================

  async getRankings(userId: string, eventId: string, query: DashboardRankingsQueryDto) {
    await this.assertAccess(userId, eventId);

    const period = query.period ?? DashboardPeriod.GERAL;
    const ticketIds = query.ticketIds ?? null;
    const ticketRankingPage = query.ticketRankingPage ?? 1;
    const ticketRankingLimit = query.ticketRankingLimit ?? 10;
    const ticketsPage = query.ticketsPage ?? 1;
    const ticketsLimit = query.ticketsLimit ?? 20;

    const cacheKey = this.buildCacheKey('rankings', eventId, {
      period,
      ticketIds,
      ticketRankingPage,
      ticketRankingLimit,
      ticketsPage,
      ticketsLimit,
    });
    const cached = await this.cache.getJson<unknown>(cacheKey);
    if (cached) return cached;

    const prismaRead = this.prisma.getReadClient();
    const eventConfig = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizerFeePercent: true },
    });
    const organizerFeeRate = (eventConfig?.organizerFeePercent ?? 0) / 100;
    const dateRange = calculateDateRange(period);

    const [
      rankingRows,
      tickets,
      topProductVariations,
      lotsNearDepletion,
      salesByPaymentMethod,
    ] = await Promise.all([
      this.queryTicketRanking(eventId, dateRange, ticketIds, organizerFeeRate),
      this.ticketsService.findAll(eventId, {
        page: ticketsPage,
        limit: ticketsLimit,
        includeInactive: true,
      }),
      this.buildTopProductVariations(eventId, dateRange, ticketIds, organizerFeeRate),
      this.buildLotsNearDepletion(eventId),
      this.buildSalesByPaymentMethod(eventId, dateRange, ticketIds, organizerFeeRate),
    ]);

    const total = rankingRows.length;
    const start = (ticketRankingPage - 1) * ticketRankingLimit;
    const pagedRanking = rankingRows
      .slice(start, start + ticketRankingLimit)
      .map((r) => ({
        ticketId: r.item_id,
        name: r.item_name,
        category: r.category_name ?? 'Sem categoria',
        quantity: Number(r.quantity),
        total: Number(r.total_net),
      }));

    // Líquido do organizador POR INGRESSO (centavos), reusando o mesmo rateio do
    // ticketRanking (fonte única de verdade: queryTicketRanking → mesma fórmula do
    // repasse/computeRefundImpact, já considera cupom e produtos via finalAmount).
    // Sem query extra: derivamos do rankingRows já carregado. Só itens de ticket
    // (is_modality=false) têm item_id == ticket.id.
    const netByTicketId = new Map<string, number>(
      rankingRows
        .filter((r) => !r.is_modality)
        .map((r) => [r.item_id, Number(r.total_net)]),
    );
    const ticketsWithNet = this.injectOrganizerNetIntoTickets(tickets, netByTicketId);

    const response = {
      message: 'Dashboard rankings fetched successfully',
      data: {
        ticketRanking: {
          data: pagedRanking,
          pagination: {
            page: ticketRankingPage,
            limit: ticketRankingLimit,
            total,
            totalPages: Math.ceil(total / ticketRankingLimit),
          },
        },
        tickets: ticketsWithNet,
        topProductVariations,
        lotsNearDepletion,
        salesByPaymentMethod,
      },
    };

    await this.cache.setJson(cacheKey, response, CACHE_TTL_RANKINGS);
    return response;
  }

  // ============================================================
  // SECONDARY — topCities, salesHeatmap, mostAnsweredQuestions
  // ============================================================

  async getSecondary(userId: string, eventId: string, query: DashboardSecondaryQueryDto) {
    await this.assertAccess(userId, eventId);

    const period = query.period ?? DashboardPeriod.GERAL;
    const ticketIds = query.ticketIds ?? null;

    const cacheKey = this.buildCacheKey('secondary', eventId, { period, ticketIds });
    const cached = await this.cache.getJson<unknown>(cacheKey);
    if (cached) return cached;

    const dateRange = calculateDateRange(period);

    const [topCities, salesHeatmap, mostAnsweredQuestions] = await Promise.all([
      this.queryTopCities(eventId, dateRange, ticketIds),
      this.queryHeatmap(eventId, dateRange, ticketIds),
      this.buildMostAnsweredQuestions(eventId),
    ]);

    const response = {
      message: 'Dashboard secondary fetched successfully',
      data: {
        topCities,
        salesHeatmap,
        mostAnsweredQuestions,
      },
    };

    await this.cache.setJson(cacheKey, response, CACHE_TTL_SECONDARY);
    return response;
  }

  // ============================================================
  // SQL queries (raw — Prisma.sql para safety contra injection)
  // ============================================================

  /**
   * Agregado de orders pagas + confirmadas no período:
   * `order_count` (DISTINCT) e `net_revenue` (Σ `(finalAmount−serviceFee) × (1−feeRate)` por order única).
   */
  private async queryMetricsAggregate(
    eventId: string,
    dateRange: DateRange,
    ticketIds: string[] | null,
    organizerFeeRate: number,
  ): Promise<MetricsAggregateRow> {
    const rows = await this.prisma.getReadClient().$queryRaw<MetricsAggregateRow[]>(Prisma.sql`
      WITH paid_orders AS (
        SELECT DISTINCT o.id, o."finalAmount", o."serviceFee", o."organizerFeePercent"
        FROM "Order" o
        INNER JOIN "Registration" r ON r."orderId" = o.id
        INNER JOIN "Payment" p ON p."orderId" = o.id
        WHERE r."eventId" = ${eventId}::uuid
          AND r.status = 'CONFIRMED'::"RegistrationStatus"
          AND p.status = 'PAID'::"PaymentStatus"
          ${this.sqlDateFilter(dateRange, 'o')}
          ${this.sqlTicketIdsFilter(ticketIds, 'r')}
      )
      SELECT
        COUNT(*)::bigint AS order_count,
        COALESCE(
          SUM(GREATEST("finalAmount" - "serviceFee", 0) * (1 - COALESCE("organizerFeePercent"::numeric / 100, ${organizerFeeRate}::numeric)))::bigint,
          0::bigint
        ) AS net_revenue
      FROM paid_orders;
    `);
    return rows[0] ?? { order_count: BigInt(0), net_revenue: BigInt(0) };
  }

  /**
   * Contagens por status (em registrations, não orders):
   * - paid: CONFIRMED + payment PAID
   * - cancelled: CANCELLED (qualquer status de payment)
   * - refunded: payment REFUNDED (qualquer status de registration)
   * Exclui PENDING (placeholder de reserva não paga).
   */
  private async queryRegCounts(
    eventId: string,
    dateRange: DateRange,
    ticketIds: string[] | null,
  ): Promise<RegCountsRow> {
    const rows = await this.prisma.getReadClient().$queryRaw<RegCountsRow[]>(Prisma.sql`
      SELECT
        COUNT(*) FILTER (
          WHERE r.status = 'CONFIRMED'::"RegistrationStatus"
            AND p.status = 'PAID'::"PaymentStatus"
        )::bigint AS paid_regs,
        COUNT(*) FILTER (
          WHERE r.status = 'CANCELLED'::"RegistrationStatus"
        )::bigint AS cancelled_regs,
        COUNT(*) FILTER (
          WHERE p.status = 'REFUNDED'::"PaymentStatus"
        )::bigint AS refunded_regs
      FROM "Registration" r
      INNER JOIN "Order" o ON o.id = r."orderId"
      LEFT JOIN "Payment" p ON p."orderId" = o.id
      WHERE r."eventId" = ${eventId}::uuid
        AND r.status IN ('CONFIRMED'::"RegistrationStatus", 'CANCELLED'::"RegistrationStatus", 'COMPLETED'::"RegistrationStatus")
        ${this.sqlDateFilter(dateRange, 'o')}
        ${this.sqlTicketIdsFilter(ticketIds, 'r')};
    `);
    return rows[0] ?? { paid_regs: BigInt(0), cancelled_regs: BigInt(0), refunded_regs: BigInt(0) };
  }

  /**
   * Per-order bucket pra chart (revenue por status). Cada order conta 1× —
   * status bucket é determinístico:
   *   refunded > confirmed-paid > canceled > other
   * Resolve a ambiguidade que existia no buildChartData antigo (dependia da
   * ordem de iteração das registrations).
   */
  private async queryChartOrderBuckets(
    eventId: string,
    period: DashboardPeriod,
    dateRange: DateRange,
    ticketIds: string[] | null,
    organizerFeeRate: number,
  ): Promise<OrderBucketRow[]> {
    const bucketExpr =
      period === DashboardPeriod.GERAL
        ? Prisma.sql`to_char(o."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM')`
        : Prisma.sql`to_char(o."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

    const effectiveRange = this.effectiveChartRange(period, dateRange);

    return this.prisma.getReadClient().$queryRaw<OrderBucketRow[]>(Prisma.sql`
      WITH order_status AS (
        SELECT
          o.id,
          ${bucketExpr} AS bucket_key,
          o."finalAmount",
          o."serviceFee",
          o."organizerFeePercent",
          CASE
            WHEN BOOL_OR(p.status = 'REFUNDED'::"PaymentStatus") THEN 'refunded'
            WHEN BOOL_OR(
              r.status = 'CONFIRMED'::"RegistrationStatus"
              AND p.status = 'PAID'::"PaymentStatus"
            ) THEN 'confirmed'
            WHEN BOOL_OR(r.status = 'CANCELLED'::"RegistrationStatus") THEN 'canceled'
            ELSE 'other'
          END AS status_bucket
        FROM "Order" o
        INNER JOIN "Registration" r ON r."orderId" = o.id
        LEFT JOIN "Payment" p ON p."orderId" = o.id
        WHERE r."eventId" = ${eventId}::uuid
          AND r.status IN ('CONFIRMED'::"RegistrationStatus", 'CANCELLED'::"RegistrationStatus", 'COMPLETED'::"RegistrationStatus")
          ${this.sqlDateFilter(effectiveRange, 'o')}
          ${this.sqlTicketIdsFilter(ticketIds, 'r')}
        GROUP BY o.id, bucket_key
      )
      SELECT
        bucket_key,
        status_bucket,
        COUNT(*)::bigint AS order_count,
        COALESCE(
          SUM(GREATEST("finalAmount" - "serviceFee", 0) * (1 - COALESCE("organizerFeePercent"::numeric / 100, ${organizerFeeRate}::numeric)))::bigint,
          0::bigint
        ) AS net_revenue
      FROM order_status
      GROUP BY bucket_key, status_bucket;
    `);
  }

  /**
   * Per-registration count por bucket — confirmed/canceled/refunded.
   * Cada registration conta 1×, sem dedupe (ao contrário do revenue).
   */
  private async queryChartRegBuckets(
    eventId: string,
    period: DashboardPeriod,
    dateRange: DateRange,
    ticketIds: string[] | null,
  ): Promise<RegBucketRow[]> {
    const bucketExpr =
      period === DashboardPeriod.GERAL
        ? Prisma.sql`to_char(o."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM')`
        : Prisma.sql`to_char(o."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

    const effectiveRange = this.effectiveChartRange(period, dateRange);

    return this.prisma.getReadClient().$queryRaw<RegBucketRow[]>(Prisma.sql`
      SELECT
        ${bucketExpr} AS bucket_key,
        COUNT(*) FILTER (
          WHERE r.status = 'CONFIRMED'::"RegistrationStatus"
            AND p.status = 'PAID'::"PaymentStatus"
        )::bigint AS confirmed,
        COUNT(*) FILTER (
          WHERE r.status = 'CANCELLED'::"RegistrationStatus"
        )::bigint AS canceled,
        COUNT(*) FILTER (
          WHERE p.status = 'REFUNDED'::"PaymentStatus"
        )::bigint AS refunded
      FROM "Registration" r
      INNER JOIN "Order" o ON o.id = r."orderId"
      LEFT JOIN "Payment" p ON p."orderId" = o.id
      WHERE r."eventId" = ${eventId}::uuid
        AND r.status IN ('CONFIRMED'::"RegistrationStatus", 'CANCELLED'::"RegistrationStatus", 'COMPLETED'::"RegistrationStatus")
        ${this.sqlDateFilter(effectiveRange, 'o')}
        ${this.sqlTicketIdsFilter(ticketIds, 'r')}
      GROUP BY bucket_key;
    `);
  }

  /**
   * Injeta `organizerNet` (centavos, líquido do organizador no período) em cada
   * ingresso do bloco `tickets`, sem mutar o objeto recebido (que pode vir do
   * cache compartilhado do TicketsService). Ingressos sem venda no período → 0.
   *
   * Defensivo contra mudanças de shape do TicketsService.findAll: se a estrutura
   * esperada não existir, retorna o objeto original intacto.
   */
  private injectOrganizerNetIntoTickets(
    tickets: any,
    netByTicketId: Map<string, number>,
  ): any {
    const list = tickets?.data?.tickets;
    if (!Array.isArray(list)) return tickets;

    return {
      ...tickets,
      data: {
        ...tickets.data,
        tickets: list.map((t: any) => ({
          ...t,
          organizerNet: netByTicketId.get(t.id) ?? 0,
        })),
      },
    };
  }

  /**
   * Ranking de ingressos vendidos (PAID+CONFIRMED) — quantidade + receita
   * líquida proporcional rateada por item dentro da order (mesma lógica do
   * buildTicketRanking antigo).
   *
   * Total da order é dividido entre seus items (rt + rm) usando UNION ALL
   * em CTE pra obter contagem total de items por order antes do rateio.
   */
  private async queryTicketRanking(
    eventId: string,
    dateRange: DateRange,
    ticketIds: string[] | null,
    organizerFeeRate: number,
  ): Promise<TicketRankingRow[]> {
    return this.prisma.getReadClient().$queryRaw<TicketRankingRow[]>(Prisma.sql`
      WITH paid_orders AS (
        SELECT DISTINCT o.id, o."finalAmount", o."serviceFee", o."organizerFeePercent"
        FROM "Order" o
        INNER JOIN "Registration" r ON r."orderId" = o.id
        INNER JOIN "Payment" p ON p."orderId" = o.id
        WHERE r."eventId" = ${eventId}::uuid
          AND r.status = 'CONFIRMED'::"RegistrationStatus"
          AND p.status = 'PAID'::"PaymentStatus"
          ${this.sqlDateFilter(dateRange, 'o')}
          ${this.sqlTicketIdsFilter(ticketIds, 'r')}
      ),
      ticket_items AS (
        SELECT
          r."orderId",
          t.id AS item_id,
          t.name AS item_name,
          tc.name AS category_name,
          FALSE AS is_modality
        FROM "Registration" r
        INNER JOIN paid_orders po ON po.id = r."orderId"
        INNER JOIN "RegistrationTicket" rt ON rt."registrationId" = r.id
        INNER JOIN "Ticket" t ON t.id = rt."ticketId"
        LEFT JOIN "TicketCategory" tc ON tc.id = t."categoryId"
        WHERE r.status = 'CONFIRMED'::"RegistrationStatus"
      ),
      modality_items AS (
        SELECT
          r."orderId",
          m.id AS item_id,
          m.name AS item_name,
          NULL::text AS category_name,
          TRUE AS is_modality
        FROM "Registration" r
        INNER JOIN paid_orders po ON po.id = r."orderId"
        INNER JOIN "RegistrationModality" rm ON rm."registrationId" = r.id
        INNER JOIN "Modality" m ON m.id = rm."modalityId"
        WHERE r.status = 'CONFIRMED'::"RegistrationStatus"
          AND NOT EXISTS (
            SELECT 1 FROM "RegistrationTicket" rt2 WHERE rt2."registrationId" = r.id
          )
      ),
      all_items AS (
        SELECT * FROM ticket_items
        UNION ALL
        SELECT * FROM modality_items
      ),
      items_per_order AS (
        SELECT "orderId", COUNT(*) AS total_items
        FROM all_items
        GROUP BY "orderId"
      )
      SELECT
        ai.item_id,
        ai.item_name,
        ai.category_name,
        ai.is_modality,
        COUNT(*)::bigint AS quantity,
        ROUND(SUM(
          CASE WHEN ipo.total_items > 0 THEN
            (GREATEST(po."finalAmount" - po."serviceFee", 0) * (1 - COALESCE(po."organizerFeePercent"::numeric / 100, ${organizerFeeRate}::numeric))) / ipo.total_items
          ELSE 0 END
        ))::bigint AS total_net
      FROM all_items ai
      INNER JOIN paid_orders po ON po.id = ai."orderId"
      INNER JOIN items_per_order ipo ON ipo."orderId" = ai."orderId"
      GROUP BY ai.item_id, ai.item_name, ai.category_name, ai.is_modality
      ORDER BY quantity DESC;
    `);
  }

  /**
   * Top cidades — participantes (1 por registration paga+confirmada) agrupados
   * por (lower(unaccent(city)), lower(unaccent(state))) pra evitar duplicar
   * "São Paulo" vs "sao paulo". Retorna o casing da PRIMEIRA ocorrência.
   *
   * Requer extensão `unaccent` no Postgres. Caímos pra normalização em JS
   * se a extensão não estiver disponível (catch + fallback).
   */
  private async queryTopCities(
    eventId: string,
    dateRange: DateRange,
    ticketIds: string[] | null,
  ): Promise<{ city: string; state?: string; participants: number }[]> {
    const rows = await this.prisma.getReadClient().$queryRaw<CityRow[]>(Prisma.sql`
      SELECT
        BTRIM(u.city) AS city,
        BTRIM(u.state) AS state,
        COUNT(*)::bigint AS participants
      FROM "Registration" r
      INNER JOIN "Order" o ON o.id = r."orderId"
      INNER JOIN "Payment" p ON p."orderId" = o.id
      INNER JOIN "User" u ON u.id = r."userId"
      WHERE r."eventId" = ${eventId}::uuid
        AND r.status = 'CONFIRMED'::"RegistrationStatus"
        AND p.status = 'PAID'::"PaymentStatus"
        AND u.city IS NOT NULL
        AND BTRIM(u.city) <> ''
        ${this.sqlDateFilter(dateRange, 'o')}
        ${this.sqlTicketIdsFilter(ticketIds, 'r')}
      GROUP BY BTRIM(u.city), BTRIM(u.state);
    `);

    // Coalesce case/acentos no app (sem depender de extensão Postgres `unaccent`).
    const normalize = (s: string) =>
      s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

    const merged = new Map<string, { city: string; state?: string; participants: number }>();
    for (const r of rows) {
      const state = r.state || undefined;
      const key = `${normalize(r.city)}|${state ? normalize(state) : ''}`;
      const existing = merged.get(key);
      if (existing) {
        existing.participants += Number(r.participants);
      } else {
        merged.set(key, { city: r.city, state, participants: Number(r.participants) });
      }
    }

    return Array.from(merged.values())
      .sort((a, b) => b.participants - a.participants)
      .slice(0, 2);
  }

  /**
   * Heatmap de vendas — registrations PAID+CONFIRMED agrupadas por dia da
   * semana (0=Dom...6=Sáb) e hora (0..23) do `Order.createdAt`.
   */
  private async queryHeatmap(
    eventId: string,
    dateRange: DateRange,
    ticketIds: string[] | null,
  ): Promise<{ day: string; hour: number; sales: number }[]> {
    const rows = await this.prisma.getReadClient().$queryRaw<HeatmapRow[]>(Prisma.sql`
      SELECT
        EXTRACT(DOW FROM o."createdAt")::int AS dow,
        EXTRACT(HOUR FROM o."createdAt")::int AS hour,
        COUNT(*)::bigint AS sales
      FROM "Registration" r
      INNER JOIN "Order" o ON o.id = r."orderId"
      INNER JOIN "Payment" p ON p."orderId" = o.id
      WHERE r."eventId" = ${eventId}::uuid
        AND r.status = 'CONFIRMED'::"RegistrationStatus"
        AND p.status = 'PAID'::"PaymentStatus"
        ${this.sqlDateFilter(dateRange, 'o')}
        ${this.sqlTicketIdsFilter(ticketIds, 'r')}
      GROUP BY dow, hour;
    `);

    const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
    return rows.map((r) => ({
      day: dayNames[r.dow] ?? 'Dom',
      hour: r.hour,
      sales: Number(r.sales),
    }));
  }

  // ============================================================
  // Helpers de chart — montagem dos buckets ordenados + zero-fill
  // ============================================================

  /**
   * Para GERAL, o chart cobre os últimos 6 meses calendário —
   * estende o range pra cobrir esses meses na query SQL.
   */
  private effectiveChartRange(period: DashboardPeriod, dateRange: DateRange): DateRange {
    if (period !== DashboardPeriod.GERAL) return dateRange;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 5, 1, 0, 0, 0, 0);
    return { start, end: now };
  }

  private assembleChartData(
    period: DashboardPeriod,
    dateRange: DateRange,
    orderBuckets: OrderBucketRow[],
    regBuckets: RegBucketRow[],
  ) {
    const keys =
      period === DashboardPeriod.GERAL
        ? lastSixMonthKeys()
        : dateRange.start && dateRange.end
          ? eachUtcDayKeys(dateRange.start, dateRange.end)
          : [];

    const labels = this.formatLabels(period, keys);

    // Indexa buckets pra lookup O(1)
    const orderByKey = new Map<string, { confirmed: number; canceled: number; refunded: number }>();
    for (const ob of orderBuckets) {
      const entry = orderByKey.get(ob.bucket_key) ?? { confirmed: 0, canceled: 0, refunded: 0 };
      if (ob.status_bucket === 'confirmed') entry.confirmed += Number(ob.net_revenue);
      else if (ob.status_bucket === 'canceled') entry.canceled += Number(ob.net_revenue);
      else if (ob.status_bucket === 'refunded') entry.refunded += Number(ob.net_revenue);
      orderByKey.set(ob.bucket_key, entry);
    }
    const regByKey = new Map<string, RegBucketRow>();
    for (const rb of regBuckets) regByKey.set(rb.bucket_key, rb);

    const dailyData = keys.map((key) => {
      const rev = orderByKey.get(key) ?? { confirmed: 0, canceled: 0, refunded: 0 };
      const cnt = regByKey.get(key);
      return {
        date: key,
        revenue: rev.confirmed,
        confirmed: cnt ? Number(cnt.confirmed) : 0,
        canceled: cnt ? Number(cnt.canceled) : 0,
        refunded: cnt ? Number(cnt.refunded) : 0,
        canceledRevenue: rev.canceled,
        refundedRevenue: rev.refunded,
      };
    });

    const revenue = dailyData.map((d) => d.revenue);
    return { labels, revenue, dailyData };
  }

  private formatLabels(period: DashboardPeriod, keys: string[]): string[] {
    if (period === DashboardPeriod.GERAL) {
      const monthNames = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
      return keys.map((k) => {
        const [year, month] = k.split('-');
        return `${monthNames[parseInt(month, 10) - 1]}/${year.slice(-2)}`;
      });
    }
    return keys.map((k) => {
      const [y, m, d] = k.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('pt-BR', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
    });
  }

  // ============================================================
  // Top product variations (sql + composição no app — produto+variação tem
  // shape complexo, vale fazer 2 queries focadas).
  // ============================================================

  /**
   * Agrega vendas confirmadas por método de pagamento.
   *
   * Considera apenas Payment com status PAID, agrupado por method. Retorna
   * para cada método: quantidade de vendas (count), valor LÍQUIDO recebido
   * pelo organizador em centavos, e o percentual sobre o total (calculado em
   * JS pra evitar divisão por zero no SQL).
   *
   * Líquido = (finalAmount - serviceFee) × (1 - organizerFeeRate), mesma
   * fórmula usada em buildTopProductVariations e queryTicketRanking. Aplica
   * agregação por order (DISTINCT) usando subquery — evita multiplicar valor
   * pelo número de registrations quando há múltiplos atletas no pedido.
   *
   * Métodos: PIX, CREDIT_CARD, DEBIT_CARD, BOLETO, CRYPTO, FREE (ver enum
   * PaymentMethod). Sempre retorna entradas pros métodos presentes — não
   * inclui zeros pra métodos sem vendas, pra UI poder renderizar só barras
   * com dados.
   */
  private async buildSalesByPaymentMethod(
    eventId: string,
    dateRange: DateRange,
    ticketIds: string[] | null,
    organizerFeeRate: number,
  ) {
    const prismaRead = this.prisma.getReadClient();

    const rows = await prismaRead.$queryRaw<
      { method: string; sales_count: bigint; total_amount: bigint }[]
    >(Prisma.sql`
      WITH order_methods AS (
        SELECT DISTINCT
          o.id AS order_id,
          p.method::text AS method,
          o."finalAmount" AS final_amount,
          o."serviceFee" AS service_fee,
          o."organizerFeePercent" AS organizer_fee_percent
        FROM "Order" o
        INNER JOIN "Payment" p ON p."orderId" = o.id
        INNER JOIN "Registration" r ON r."orderId" = o.id
        WHERE r."eventId" = ${eventId}::uuid
          AND p.status = 'PAID'::"PaymentStatus"
          AND o.status = 'PAID'::"OrderStatus"
          ${this.sqlDateFilter(dateRange, 'o')}
          ${this.sqlTicketIdsFilter(ticketIds, 'r')}
      )
      SELECT
        method,
        COUNT(*)::bigint AS sales_count,
        COALESCE(
          SUM(
            GREATEST(final_amount - service_fee, 0) * (1 - COALESCE(organizer_fee_percent::numeric / 100, ${organizerFeeRate}::numeric))
          )::bigint,
          0::bigint
        ) AS total_amount
      FROM order_methods
      GROUP BY method
      ORDER BY total_amount DESC;
    `);

    const items = rows.map((r) => ({
      method: r.method,
      salesCount: Number(r.sales_count),
      totalAmount: Number(r.total_amount),
    }));

    const totalSales = items.reduce((acc, r) => acc + r.salesCount, 0);
    const totalAmount = items.reduce((acc, r) => acc + r.totalAmount, 0);

    return {
      items: items.map((r) => ({
        ...r,
        percentage: totalAmount > 0 ? (r.totalAmount / totalAmount) * 100 : 0,
      })),
      totals: { salesCount: totalSales, totalAmount },
    };
  }

  private async buildTopProductVariations(
    eventId: string,
    dateRange: DateRange,
    ticketIds: string[] | null,
    organizerFeeRate: number,
  ) {
    const prismaRead = this.prisma.getReadClient();

    const salesRows = await prismaRead.$queryRaw<
      {
        product_id: string;
        variation_id: string | null;
        quantity: bigint;
        net_sold: bigint;
      }[]
    >(Prisma.sql`
      SELECT
        rp."productId" AS product_id,
        rp."variationId" AS variation_id,
        SUM(rp.quantity)::bigint AS quantity,
        ROUND(SUM(
          rp."totalPrice" * (
            CASE WHEN o."finalAmount" > 0
              THEN (GREATEST(o."finalAmount" - o."serviceFee", 0)::numeric / o."finalAmount") * (1 - COALESCE(o."organizerFeePercent"::numeric / 100, ${organizerFeeRate}::numeric))
              ELSE 0
            END
          )
        ))::bigint AS net_sold
      FROM "RegistrationProduct" rp
      INNER JOIN "Registration" r ON r.id = rp."registrationId"
      INNER JOIN "Order" o ON o.id = r."orderId"
      INNER JOIN "Payment" p ON p."orderId" = o.id
      WHERE r."eventId" = ${eventId}::uuid
        AND r.status = 'CONFIRMED'::"RegistrationStatus"
        AND p.status = 'PAID'::"PaymentStatus"
        ${this.sqlDateFilter(dateRange, 'o')}
        ${this.sqlTicketIdsFilter(ticketIds, 'r')}
      GROUP BY rp."productId", rp."variationId";
    `);

    if (salesRows.length === 0) return [];

    const productIds = [...new Set(salesRows.map((r) => r.product_id))];
    const products = await prismaRead.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        name: true,
        image: true,
        variations: { select: { id: true, name: true, stock: true }, orderBy: { name: 'asc' } },
      },
    });

    const productsById = new Map(products.map((p) => [p.id, p]));

    const grouped = new Map<
      string,
      {
        totalSoldAmount: number;
        byVariation: Map<string | null, number>;
      }
    >();

    for (const row of salesRows) {
      const entry = grouped.get(row.product_id) ?? {
        totalSoldAmount: 0,
        byVariation: new Map<string | null, number>(),
      };
      entry.totalSoldAmount += Number(row.net_sold);
      entry.byVariation.set(
        row.variation_id,
        (entry.byVariation.get(row.variation_id) ?? 0) + Number(row.quantity),
      );
      grouped.set(row.product_id, entry);
    }

    const result = Array.from(grouped.entries())
      .map(([productId, sales]) => {
        const product = productsById.get(productId);
        if (!product) return null;

        const totalSold = Array.from(sales.byVariation.values()).reduce((s, v) => s + v, 0);
        const variations: {
          variationId: string | null;
          variationName: string;
          quantitySold: number;
          percentage: number;
          remainingStock: number | null;
          totalStock: number | null;
        }[] = [];

        for (const v of product.variations) {
          const quantitySold = sales.byVariation.get(v.id) ?? 0;
          const percentage = totalSold > 0 ? Math.round((quantitySold / totalSold) * 10000) / 100 : 0;
          const isUnlimited = v.stock === null || v.stock === 0;
          const remainingStock = isUnlimited ? null : v.stock;
          const totalStock = isUnlimited ? null : (v.stock ?? 0) + quantitySold;
          variations.push({
            variationId: v.id,
            variationName: v.name,
            quantitySold,
            percentage,
            remainingStock,
            totalStock,
          });
        }

        const noVariation = sales.byVariation.get(null);
        if (noVariation && noVariation > 0) {
          const percentage = totalSold > 0 ? Math.round((noVariation / totalSold) * 10000) / 100 : 0;
          variations.push({
            variationId: null,
            variationName: 'Sem variação',
            quantitySold: noVariation,
            percentage,
            remainingStock: null,
            totalStock: null,
          });
        }

        variations.sort((a, b) => b.quantitySold - a.quantitySold);

        return {
          productId: product.id,
          productName: product.name,
          productImage: product.image ?? null,
          totalQuantitySold: totalSold,
          totalSoldAmount: sales.totalSoldAmount,
          variations,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    return result.sort((a, b) => b.totalQuantitySold - a.totalQuantitySold);
  }

  // ============================================================
  // Lots near depletion — mantém lógica complexa de orphan-allocation;
  // já era SQL puro (groupBy do Prisma) no original.
  // ============================================================

  private async buildLotsNearDepletion(eventId: string) {
    const prismaRead = this.prisma.getReadClient();
    const paidRegistrationWhere = {
      status: 'CONFIRMED' as const,
      eventId,
      order: { payment: { status: 'PAID' as const } },
    };

    const now = new Date();
    const allBatches = await prismaRead.ticketBatch.findMany({
      where: { ticket: { eventId, isActive: true }, quantity: { gt: 0 } },
      include: { ticket: { select: { id: true, name: true } } },
      orderBy: [{ ticketId: 'asc' }, { sortOrder: 'asc' }],
    });

    const activeBatchByTicket = new Map<string, { id: string; number: number }>();
    const batchesByTicket = new Map<string, typeof allBatches>();
    for (const b of allBatches) {
      const list = batchesByTicket.get(b.ticketId) ?? [];
      list.push(b);
      batchesByTicket.set(b.ticketId, list);
    }
    for (const [ticketId, tBatches] of batchesByTicket) {
      const active = tBatches.find((b) => b.availableQuantity > 0);
      if (active) {
        activeBatchByTicket.set(ticketId, {
          id: active.id,
          number: tBatches.indexOf(active) + 1,
        });
      }
    }

    const batches = allBatches.filter((b) => {
      if (b.startDate && new Date(b.startDate) > now) return false;
      if (b.endDate && new Date(b.endDate) < now) return false;
      return true;
    });

    if (batches.length === 0) return [];

    const batchIds = batches.map((b) => b.id);
    const [soldByBatch, soldByTicket] = await Promise.all([
      prismaRead.registrationTicket.groupBy({
        by: ['batchId'],
        where: { batchId: { in: batchIds }, registration: paidRegistrationWhere },
        _count: { _all: true },
      }),
      prismaRead.registrationTicket.groupBy({
        by: ['ticketId'],
        where: { ticket: { eventId, isActive: true }, registration: paidRegistrationWhere },
        _count: { _all: true },
      }),
    ]);

    const soldCountByBatchId = new Map<string, number>();
    for (const row of soldByBatch) {
      if (row.batchId) soldCountByBatchId.set(row.batchId, row._count._all);
    }
    const totalSoldByTicketId = new Map<string, number>();
    for (const row of soldByTicket) {
      totalSoldByTicketId.set(row.ticketId, row._count._all);
    }

    const byTicket = new Map<string, typeof batches>();
    for (const b of batches) {
      const list = byTicket.get(b.ticketId) ?? [];
      list.push(b);
      byTicket.set(b.ticketId, list);
    }

    const effectiveSold = new Map<string, number>();
    for (const b of batches) effectiveSold.set(b.id, soldCountByBatchId.get(b.id) ?? 0);

    // Orphan FIFO: vendas com batchId NULL ficam alocadas no lote ativo do ticket.
    for (const [, ticketBatches] of byTicket) {
      const ticketId = ticketBatches[0].ticketId;
      const total = totalSoldByTicketId.get(ticketId) ?? 0;
      const assigned = ticketBatches.reduce((s, bt) => s + (effectiveSold.get(bt.id) ?? 0), 0);
      let orphan = total - assigned;
      if (orphan <= 0) continue;
      for (const bt of ticketBatches) {
        if (orphan <= 0) break;
        const current = effectiveSold.get(bt.id) ?? 0;
        const room = Math.max(0, bt.quantity - current);
        const add = Math.min(orphan, room);
        effectiveSold.set(bt.id, current + add);
        orphan -= add;
      }
    }

    const statusOf = (remaining: number, pct: number): 'Normal' | 'Atenção' | 'Crítico' => {
      const lowStock = remaining > 0 && remaining <= 25;
      if (pct >= 90 || remaining === 0 || (lowStock && pct >= 50)) return 'Crítico';
      if (pct >= 75 || (lowStock && pct >= 25)) return 'Atenção';
      return 'Normal';
    };

    const tickets = new Map<
      string,
      {
        ticketId: string;
        ticketName: string;
        total: number;
        sold: number;
        batches: Array<{
          id: string;
          name: string;
          total: number;
          sold: number;
          remaining: number;
          percentageSold: number;
          status: string;
        }>;
      }
    >();

    for (const batch of batches) {
      const soldRaw = effectiveSold.get(batch.id) ?? 0;
      const batchSold = Math.min(soldRaw, batch.quantity);
      const batchRemaining = Math.max(0, batch.quantity - batchSold);
      const batchPct = batch.quantity > 0 ? Math.round((batchSold / batch.quantity) * 10000) / 100 : 0;

      const entry = tickets.get(batch.ticketId) ?? {
        ticketId: batch.ticket.id,
        ticketName: batch.ticket.name,
        total: 0,
        sold: 0,
        batches: [],
      };
      entry.total += batch.quantity;
      entry.sold += batchSold;
      entry.batches.push({
        id: batch.id,
        name: `Lote ${(batch.sortOrder ?? entry.batches.length) + 1}`,
        total: batch.quantity,
        sold: batchSold,
        remaining: batchRemaining,
        percentageSold: batchPct,
        status: statusOf(batchRemaining, batchPct),
      });
      tickets.set(batch.ticketId, entry);
    }

    return Array.from(tickets.values())
      .map((t) => {
        const remaining = Math.max(0, t.total - t.sold);
        const pct = t.total > 0 ? Math.round((t.sold / t.total) * 10000) / 100 : 0;
        const active = activeBatchByTicket.get(t.ticketId) ?? null;
        return {
          ticketId: t.ticketId,
          ticketName: t.ticketName,
          status: statusOf(remaining, pct),
          sold: t.sold,
          total: t.total,
          remaining,
          percentageSold: pct,
          activeBatch: active
            ? { id: active.id, number: active.number, label: `Lote ${active.number}` }
            : null,
          batches: t.batches,
        };
      })
      .sort((a, b) => {
        if (a.remaining !== b.remaining) return a.remaining - b.remaining;
        return b.percentageSold - a.percentageSold;
      });
  }

  // ============================================================
  // Most answered questions — agregação de respostas por questionário.
  // ============================================================

  private async buildMostAnsweredQuestions(eventId: string) {
    const prismaRead = this.prisma.getReadClient();
    const answers = await prismaRead.questionAnswer.findMany({
      where: { registration: { eventId } },
      select: {
        answer: true,
        question: {
          select: { id: true, question: true, order: true, type: true, options: true, isRequired: true },
        },
      },
    });
    if (answers.length === 0) return [];

    const byQuestion = new Map<
      string,
      {
        questionId: string;
        question: string;
        order: number;
        type: string;
        options: unknown;
        isRequired: boolean;
        participantCount: number;
        answersByValue: Map<string, number>;
      }
    >();

    for (const a of answers) {
      const q = a.question;
      if (!q) continue;
      const entry = byQuestion.get(q.id) ?? {
        questionId: q.id,
        question: q.question,
        order: q.order,
        type: q.type ?? 'text',
        options: q.options ?? null,
        isRequired: q.isRequired ?? false,
        participantCount: 0,
        answersByValue: new Map<string, number>(),
      };
      entry.participantCount += 1;
      for (const val of this.normalizeAnswer(a.answer, entry.type)) {
        entry.answersByValue.set(val, (entry.answersByValue.get(val) ?? 0) + 1);
      }
      byQuestion.set(q.id, entry);
    }

    return Array.from(byQuestion.values())
      .map((entry) => {
        const total = entry.participantCount;
        const answersRanking = Array.from(entry.answersByValue.entries())
          .map(([answer, count]) => ({
            answer,
            count,
            percentage: total > 0 ? Math.round((count / total) * 10000) / 100 : 0,
          }))
          .sort((x, y) => y.count - x.count);
        return {
          questionId: entry.questionId,
          question: entry.question,
          order: entry.order,
          type: entry.type,
          options: entry.options,
          isRequired: entry.isRequired,
          participantCount: entry.participantCount,
          answersRanking,
        };
      })
      .sort((a, b) => b.participantCount - a.participantCount);
  }

  private normalizeAnswer(raw: unknown, type: string): string[] {
    const str = (raw ?? '').toString().trim();
    if (str === '') return ['(vazio)'];
    if (str.startsWith('[')) {
      try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed)) {
          const items = parsed.map((v: unknown) => String(v).trim()).filter(Boolean);
          return items.length > 0 ? items : ['(vazio)'];
        }
      } catch {
        // not JSON — fallthrough
      }
    }
    if (type === 'true_false') {
      if (str === 'true' || str === '1') return ['Verdadeiro'];
      if (str === 'false' || str === '0') return ['Falso'];
    }
    return [str];
  }

  // ============================================================
  // SQL fragment helpers
  // ============================================================

  /** Filtro de data sobre `<alias>."createdAt"`. Sem filtro quando GERAL. */
  private sqlDateFilter(dateRange: DateRange, alias: 'o'): Prisma.Sql {
    const aliasSql = alias === 'o' ? Prisma.sql`o` : Prisma.sql`r`;
    if (dateRange.start && dateRange.end) {
      return Prisma.sql`AND ${aliasSql}."createdAt" >= ${dateRange.start} AND ${aliasSql}."createdAt" <= ${dateRange.end}`;
    }
    if (dateRange.start) {
      return Prisma.sql`AND ${aliasSql}."createdAt" >= ${dateRange.start}`;
    }
    if (dateRange.end) {
      return Prisma.sql`AND ${aliasSql}."createdAt" <= ${dateRange.end}`;
    }
    return Prisma.empty;
  }

  /** Filtro `EXISTS RegistrationTicket WHERE ticketId IN (...)` sobre `<alias>` (registrations). */
  private sqlTicketIdsFilter(ticketIds: string[] | null, alias: 'r'): Prisma.Sql {
    if (!ticketIds || ticketIds.length === 0) return Prisma.empty;
    const aliasSql = Prisma.sql`r`;
    return Prisma.sql`AND EXISTS (
      SELECT 1 FROM "RegistrationTicket" rt_filter
      WHERE rt_filter."registrationId" = ${aliasSql}.id
        AND rt_filter."ticketId" = ANY(${ticketIds}::uuid[])
    )`;
  }

  // ============================================================
  // Misc
  // ============================================================

  private async assertAccess(userId: string, eventId: string) {
    await this.organizerMemberAccess.assertCanAccessEvent(userId, eventId, 'dashboard');
  }

  private statusFromRate(
    rate: number,
    thresholds: { warn: number; critical: number },
  ): 'Normal' | 'Atenção' | 'Crítico' {
    if (rate > thresholds.critical) return 'Crítico';
    if (rate > thresholds.warn) return 'Atenção';
    return 'Normal';
  }

  /**
   * Chave de cache estável: hash sha1 dos params (curto, determinístico).
   * Permission check ocorre ANTES de qualquer hit no cache — o cache só
   * serializa o payload, nunca pula auth.
   */
  private buildCacheKey(slot: string, eventId: string, params: Record<string, unknown>): string {
    const sorted = JSON.stringify(params, Object.keys(params).sort());
    const hash = crypto.createHash('sha1').update(sorted).digest('hex').slice(0, 12);
    return `dash:${slot}:${eventId}:${hash}`;
  }
}
