import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { brtDayStartUtc, brtDayEndUtc } from '../../common/utils/brt-date.util';
import {
  AdminUserActivityFunnelQueryDto,
  AdminUserActivityListQueryDto,
  AdminUserActivityStatsQueryDto,
} from './dto/admin-list-activity.dto';

/**
 * Ação canônica do page view da página pública do evento (telemetria do
 * front). Mantida aqui porque stats/funil agregam sobre ela.
 */
export const EVENT_PAGE_VIEW_ACTION = 'page:event';

/**
 * Etapas do funil de compra, na ordem da jornada. Os actions de checkout
 * espelham os `@TrackActivity` do OrdersController + o `order.paid` do
 * OrderFinalizationService.
 */
export const PURCHASE_FUNNEL_STAGES = [
  EVENT_PAGE_VIEW_ACTION,
  'order.reserve',
  'order.billing-address',
  'order.pay',
  'order.paid',
] as const;

/**
 * Leitura admin de `UserActivityLog`. Separado do `UserActivityService`
 * (que é write-only, com buffer) por dois motivos:
 *   1. Leitura não toca buffer — query Prisma direta.
 *   2. Evita dependência circular se um dia a leitura precisar de
 *      acesso a outro service (ex: enriquecer com dados de Order).
 *
 * Performance:
 *   - `userId + occurredAt` é índice composto → filtro por userId + range
 *     de data é range-scan barato.
 *   - `category + occurredAt` idem.
 *   - `q` (substring em `action`) é o filtro mais caro (full-table scan
 *     com ILIKE) — combinado com outros filtros indexados, ainda é OK.
 *   - Paginação offset é viável até ~100k linhas; acima disso considerar
 *     cursor-based.
 */
@Injectable()
export class UserActivityAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listAsAdmin(query: AdminUserActivityListQueryDto) {
    const prismaRead = this.prisma.getReadClient();
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);

    const where: Prisma.UserActivityLogWhereInput = {};

    if (query.category) {
      where.category = query.category;
    }
    if (query.source) {
      where.source = query.source;
    }
    if (query.userId) {
      where.userId = query.userId;
    }
    if (query.sessionId) {
      where.sessionId = query.sessionId;
    }
    if (query.ip) {
      where.ip = query.ip;
    }
    if (query.q?.trim()) {
      where.action = {
        contains: query.q.trim(),
        mode: 'insensitive',
      };
    }

    if (query.from || query.to) {
      const occurredAt: Prisma.DateTimeFilter = {};
      // Dia civil do seletor → fronteiras do DIA BRT (occurredAt é timestamp real).
      if (query.from) {
        occurredAt.gte = brtDayStartUtc(query.from);
      }
      if (query.to) {
        occurredAt.lte = brtDayEndUtc(query.to);
      }
      where.occurredAt = occurredAt;
    }

    const userSearch = query.userSearch?.trim();
    if (userSearch) {
      // Quando filtra por user, exclui anônimos (sem `userId`). Mesmo
      // padrão do `listAuditLogsAsAdmin` da Organization.
      //
      // O termo é quebrado em palavras e cada uma precisa casar com ALGUM
      // dos campos (AND de ORs): sem isso, "Fulano de Teste" nunca casa,
      // porque nenhum campo isolado contém o nome completo — o admin digita
      // o nome como aparece na lista (`fullName`), não só o primeiro nome.
      const terms = userSearch.split(/\s+/).filter(Boolean).slice(0, 5);
      where.user = {
        AND: terms.map((term) => ({
          OR: [
            { firstName: { contains: term, mode: 'insensitive' as const } },
            { lastName: { contains: term, mode: 'insensitive' as const } },
            { email: { contains: term, mode: 'insensitive' as const } },
          ],
        })),
      };
    }

    const [items, total] = await Promise.all([
      prismaRead.userActivityLog.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { occurredAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              accountType: true,
              avatarUrl: true,
            },
          },
        },
      }),
      prismaRead.userActivityLog.count({ where }),
    ]);

    return {
      message: 'User activity logs fetched successfully (admin)',
      data: {
        items: items.map((row) => ({
          id: row.id,
          userId: row.userId,
          // Anônimo (sem userId) → `user: null`. ResponseCompressionInterceptor
          // dropa a chave do response, mas o front pode distinguir pelo
          // `userId: null` que também some — sintoma claro de anônimo.
          user: row.user
            ? {
                id: row.user.id,
                fullName: `${row.user.firstName} ${row.user.lastName}`.trim(),
                email: row.user.email,
                accountType: row.user.accountType,
                avatarUrl: row.user.avatarUrl,
              }
            : null,
          sessionId: row.sessionId,
          ip: row.ip,
          userAgent: row.userAgent,
          source: row.source,
          category: row.category,
          action: row.action,
          path: row.path,
          referrer: row.referrer,
          metadata: row.metadata,
          occurredAt: row.occurredAt,
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  /**
   * Métricas agregadas pro dashboard admin. Todas as agregações rodam no
   * Postgres (GROUP BY/COUNT) sobre os índices `category+occurredAt` etc. —
   * nada de paginar a tabela no cliente.
   *
   * Janela default de 30 dias quando from/to ausentes: dashboards são
   * consultados com frequência e sem default a query varreria a tabela
   * inteira a cada visita.
   *
   * `uniqueUsers`/`uniqueSessions` via groupBy (uma linha por grupo trafega
   * do banco). Aceitável pra janelas de até alguns meses; se o volume
   * crescer, trocar por `COUNT(DISTINCT ...)` em raw SQL.
   */
  async statsAsAdmin(query: AdminUserActivityStatsQueryDto) {
    const prismaRead = this.prisma.getReadClient();

    // `to`/`from` explícitos = dia civil do seletor → fronteiras do DIA BRT. Sem eles,
    // mantém a janela relativa de 30 dias (default), que é instante e não tem skew de dia.
    const to = query.to
      ? brtDayEndUtc(query.to)
      : (() => {
          const d = new Date();
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })();
    const from = query.from
      ? brtDayStartUtc(query.from)
      : (() => {
          const d = new Date(to);
          d.setUTCDate(d.getUTCDate() - 29);
          d.setUTCHours(0, 0, 0, 0);
          return d;
        })();

    // Filtro por evento esportivo: match no JSONB `metadata.eventId` (índice
    // de expressão `metadata->>'eventId'` na migration). Registros antigos
    // sem o vínculo ficam de fora — documentado no DTO.
    const eventIdFilter: Prisma.UserActivityLogWhereInput = query.eventId
      ? { metadata: { path: ['eventId'], equals: query.eventId } }
      : {};

    const where: Prisma.UserActivityLogWhereInput = {
      occurredAt: { gte: from, lte: to },
      ...(query.category ? { category: query.category } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...eventIdFilter,
    };

    // Métricas de semântica FIXA (views da página do evento / pagamentos
    // confirmados): respeitam período + eventId, mas IGNORAM category/source
    // de propósito — são contadores de ação específica, não do recorte.
    const fixedMetricWhere: Prisma.UserActivityLogWhereInput = {
      occurredAt: { gte: from, lte: to },
      ...eventIdFilter,
    };

    const eventIdSqlFilter = query.eventId
      ? Prisma.sql`AND "metadata"->>'eventId' = ${query.eventId}`
      : Prisma.empty;

    const [
      total,
      anonymousEvents,
      byCategory,
      bySource,
      topActions,
      uniqueUserGroups,
      uniqueSessionGroups,
      perDayRaw,
      eventPageViews,
      paymentsConfirmed,
      viewsPerDayRaw,
    ] = await Promise.all([
      prismaRead.userActivityLog.count({ where }),
      prismaRead.userActivityLog.count({ where: { ...where, userId: null } }),
      prismaRead.userActivityLog.groupBy({
        by: ['category'],
        where,
        _count: { _all: true },
      }),
      prismaRead.userActivityLog.groupBy({
        by: ['source'],
        where,
        _count: { _all: true },
      }),
      prismaRead.userActivityLog.groupBy({
        by: ['action'],
        where,
        _count: { _all: true },
        orderBy: { _count: { action: 'desc' } },
        take: 10,
      }),
      prismaRead.userActivityLog.groupBy({
        by: ['userId'],
        where: { ...where, userId: { not: null } },
      }),
      prismaRead.userActivityLog.groupBy({
        by: ['sessionId'],
        where: { ...where, sessionId: { not: null } },
      }),
      // Série diária: date_trunc não existe no groupBy do Prisma → raw SQL.
      // Cast `::text` nos enums evita o cast explícito pro tipo do Postgres.
      prismaRead.$queryRaw<Array<{ day: Date; count: bigint }>>(Prisma.sql`
        SELECT date_trunc('day', "occurredAt") AS day, COUNT(*)::bigint AS count
        FROM "UserActivityLog"
        WHERE "occurredAt" >= ${from} AND "occurredAt" <= ${to}
        ${query.category ? Prisma.sql`AND "category"::text = ${query.category}` : Prisma.empty}
        ${query.source ? Prisma.sql`AND "source"::text = ${query.source}` : Prisma.empty}
        ${eventIdSqlFilter}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
      prismaRead.userActivityLog.count({
        where: { ...fixedMetricWhere, action: EVENT_PAGE_VIEW_ACTION },
      }),
      prismaRead.userActivityLog.count({
        where: { ...fixedMetricWhere, action: 'order.paid' },
      }),
      // Views da página de evento por dia — métrica pedida pelo produto
      // ("quantos eventos deu no dia"). Índice (action, occurredAt).
      prismaRead.$queryRaw<Array<{ day: Date; count: bigint }>>(Prisma.sql`
        SELECT date_trunc('day', "occurredAt") AS day, COUNT(*)::bigint AS count
        FROM "UserActivityLog"
        WHERE "occurredAt" >= ${from} AND "occurredAt" <= ${to}
          AND "action" = ${EVENT_PAGE_VIEW_ACTION}
        ${eventIdSqlFilter}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
    ]);

    const sortDesc = (a: { count: number }, b: { count: number }) =>
      b.count - a.count;

    return {
      message: 'User activity stats fetched successfully (admin)',
      data: {
        range: { from: from.toISOString(), to: to.toISOString() },
        totals: {
          events: total,
          uniqueUsers: uniqueUserGroups.length,
          uniqueSessions: uniqueSessionGroups.length,
          anonymousEvents,
          eventPageViews,
          paymentsConfirmed,
        },
        byCategory: byCategory
          .map((g) => ({ category: g.category, count: g._count._all }))
          .sort(sortDesc),
        bySource: bySource
          .map((g) => ({ source: g.source, count: g._count._all }))
          .sort(sortDesc),
        topActions: topActions.map((g) => ({
          action: g.action,
          count: g._count._all,
        })),
        // BigInt do COUNT raw não serializa em JSON — converte pra Number.
        perDay: perDayRaw.map((row) => ({
          day: row.day.toISOString().slice(0, 10),
          count: Number(row.count),
        })),
        viewsPerDay: viewsPerDayRaw.map((row) => ({
          day: row.day.toISOString().slice(0, 10),
          count: Number(row.count),
        })),
      },
    };
  }

  /**
   * Funil de compra — sessões/usuários ÚNICOS por etapa da jornada
   * (`page:event` → reserve → billing-address → pay → paid).
   *
   * Identidade: `COALESCE(sessionId, userId)`. O front manda `x-session-id`
   * em toda chamada de API, então as etapas de checkout (BACKEND) carregam o
   * MESMO sessionId do page view (FRONTEND) — a jornada anônimo→logado conta
   * como UMA pessoa. Linhas antigas sem sessionId caem pro userId.
   *
   * Por evento: `metadata.eventId` direto quando existe; fallback via join
   * `Order` por `metadata.orderId` (cobre falhas de /pay e registros do
   * interceptor sem eventId na resposta). Join por PK sobre o recorte já
   * filtrado por action+período (indexado) — custo marginal.
   */
  async funnelAsAdmin(query: AdminUserActivityFunnelQueryDto) {
    const prismaRead = this.prisma.getReadClient();

    // `to`/`from` explícitos = dia civil do seletor → fronteiras do DIA BRT. Sem eles,
    // mantém a janela relativa de 30 dias (default), que é instante e não tem skew de dia.
    const to = query.to
      ? brtDayEndUtc(query.to)
      : (() => {
          const d = new Date();
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })();
    const from = query.from
      ? brtDayStartUtc(query.from)
      : (() => {
          const d = new Date(to);
          d.setUTCDate(d.getUTCDate() - 29);
          d.setUTCHours(0, 0, 0, 0);
          return d;
        })();

    const actions = Prisma.join(
      PURCHASE_FUNNEL_STAGES.map((a) => Prisma.sql`${a}`),
    );

    // Sem eventId: agregação direta, sem join.
    // Com eventId: resolve o evento por metadata OU pelo Order do orderId —
    //   o cast pra uuid é seguro porque o interceptor só grava UUID validado.
    const rows = query.eventId
      ? await prismaRead.$queryRaw<
          Array<{ action: string; total: bigint; uniq: bigint }>
        >(Prisma.sql`
          SELECT l."action" AS action,
                 COUNT(*)::bigint AS total,
                 COUNT(DISTINCT COALESCE(l."sessionId", l."userId"::text))::bigint AS uniq
          FROM "UserActivityLog" l
          LEFT JOIN "Order" o
            ON l."metadata"->>'eventId' IS NULL
           AND l."metadata"->>'orderId' IS NOT NULL
           AND o."id" = (l."metadata"->>'orderId')::uuid
          WHERE l."occurredAt" >= ${from} AND l."occurredAt" <= ${to}
            AND l."action" IN (${actions})
            AND COALESCE(l."metadata"->>'eventId', o."eventId"::text) = ${query.eventId}
          GROUP BY 1
        `)
      : await prismaRead.$queryRaw<
          Array<{ action: string; total: bigint; uniq: bigint }>
        >(Prisma.sql`
          SELECT "action" AS action,
                 COUNT(*)::bigint AS total,
                 COUNT(DISTINCT COALESCE("sessionId", "userId"::text))::bigint AS uniq
          FROM "UserActivityLog"
          WHERE "occurredAt" >= ${from} AND "occurredAt" <= ${to}
            AND "action" IN (${actions})
          GROUP BY 1
        `);

    const byAction = new Map(rows.map((r) => [r.action, r]));

    return {
      message: 'Purchase funnel fetched successfully (admin)',
      data: {
        range: { from: from.toISOString(), to: to.toISOString() },
        eventId: query.eventId ?? null,
        // Ordem canônica do funil, com zero-fill — o front não precisa saber
        // a ordem das etapas nem lidar com etapa ausente.
        stages: PURCHASE_FUNNEL_STAGES.map((action) => ({
          action,
          total: Number(byAction.get(action)?.total ?? 0),
          unique: Number(byAction.get(action)?.uniq ?? 0),
        })),
      },
    };
  }
}
