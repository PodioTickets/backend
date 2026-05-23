import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminUserActivityListQueryDto } from './dto/admin-list-activity.dto';

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
      if (query.from) {
        occurredAt.gte = new Date(query.from);
      }
      if (query.to) {
        const t = new Date(query.to);
        t.setUTCHours(23, 59, 59, 999);
        occurredAt.lte = t;
      }
      where.occurredAt = occurredAt;
    }

    const userSearch = query.userSearch?.trim();
    if (userSearch) {
      // Quando filtra por user, exclui anônimos (sem `userId`). Mesmo
      // padrão do `listAuditLogsAsAdmin` da Organization.
      where.user = {
        OR: [
          { firstName: { contains: userSearch, mode: 'insensitive' } },
          { lastName: { contains: userSearch, mode: 'insensitive' } },
          { email: { contains: userSearch, mode: 'insensitive' } },
        ],
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
}
