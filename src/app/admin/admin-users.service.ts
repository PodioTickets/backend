import { Injectable } from '@nestjs/common';
import { Prisma, RegistrationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Listagem admin de USUÁRIOS (participantes). Espelha o padrão do
 * `AdminOrganizationsService.getOrganizations` (paginação + busca + status),
 * com baseline `accountType: 'USER'` (não lista contas de organizador) e a
 * contagem de ingressos por usuário via `_count` filtrado (1 query, sem N+1).
 */
@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getUsers(params: {
    page: number;
    limit: number;
    search?: string;
    isActive?: boolean;
  }) {
    const { page, limit, search, isActive } = params;
    const skip = (page - 1) * limit;

    const prismaRead = this.prisma.getReadClient();

    // Baseline: só participantes (accountType USER) — a tela é de "participantes
    // cadastrados", não de contas de organizador/admin.
    const where: Prisma.UserWhereInput = { accountType: 'USER' };
    if (isActive !== undefined) where.isActive = isActive;

    const q = search?.trim();
    if (q) {
      if (UUID_RE.test(q)) {
        // Busca por ID exato (uuid é @db.Uuid → não suporta LIKE/contains).
        where.id = q;
      } else {
        // Token-AND: "João Silva" casa quando CADA token bate em algum campo
        // (firstName/lastName/email/documento). Mesma tática da busca de
        // inscrições — nome completo não casa com OR isolado de firstName/lastName.
        const tokens = q.split(/\s+/).filter(Boolean);
        where.AND = tokens.map((tok) => {
          const digits = tok.replace(/\D/g, '');
          const or: Prisma.UserWhereInput[] = [
            { firstName: { contains: tok, mode: 'insensitive' } },
            { lastName: { contains: tok, mode: 'insensitive' } },
            { email: { contains: tok, mode: 'insensitive' } },
            { documentNumber: { contains: tok, mode: 'insensitive' } },
          ];
          // Documento por dígitos (busca "11412" casa o CPF mascarado guardado).
          if (digits) or.push({ documentNumberClean: { contains: digits } });
          return { OR: or };
        });
      }
    }

    const [users, total] = await Promise.all([
      prismaRead.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          avatarUrl: true,
          documentNumber: true,
          documentType: true,
          country: true,
          phone: true,
          isActive: true,
          createdAt: true,
          // Ingressos = inscrições CONFIRMADAS do participante (1 reg = 1 unidade
          // no fluxo de reserva). `_count` filtrado → sem N+1 na paginação.
          _count: {
            select: {
              registrations: { where: { status: RegistrationStatus.CONFIRMED } },
            },
          },
        },
      }),
      prismaRead.user.count({ where }),
    ]);

    return {
      message: 'Users fetched successfully',
      data: {
        users: users.map((u) => ({
          id: u.id,
          firstName: u.firstName,
          lastName: u.lastName,
          email: u.email,
          avatarUrl: u.avatarUrl,
          documentNumber: u.documentNumber,
          documentType: u.documentType,
          country: u.country,
          phone: u.phone,
          isActive: u.isActive,
          createdAt: u.createdAt,
          ticketsCount: u._count.registrations,
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
