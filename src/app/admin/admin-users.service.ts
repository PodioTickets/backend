import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RegistrationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsService } from '../events/events.service';
import { ExportRegistrationsService } from '../events/export-registrations.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `refundType` (REFUND/CHARGEBACK) vive no metadata do pagamento. */
function extractRefundType(metadata: unknown): string | null {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const v = (metadata as Record<string, unknown>).refundType;
    if (typeof v === 'string') return v;
  }
  return null;
}


/**
 * Listagem admin de USUÁRIOS (participantes). Espelha o padrão do
 * `AdminOrganizationsService.getOrganizations` (paginação + busca + status),
 * com baseline `accountType: 'USER'` (não lista contas de organizador) e a
 * contagem de ingressos por usuário via `_count` filtrado (1 query, sem N+1).
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    // Reusa o MESMO gerador + shape de dados do export de inscrições do evento,
    // porém filtrado por usuário (getUserRegistrationsForExport).
    private readonly events: EventsService,
    private readonly exportService: ExportRegistrationsService,
  ) {}

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

  /** Perfil completo de um usuário (participante) para o drawer de detalhes. */
  async getUser(id: string) {
    const prismaRead = this.prisma.getReadClient();
    const user = await prismaRead.user.findUnique({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        gender: true,
        genderDetails: true,
        dateOfBirth: true,
        country: true,
        phone: true,
        reservePhone: true,
        documentType: true,
        documentNumber: true,
        avatarUrl: true,
        isActive: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    return { message: 'User fetched successfully', data: { user } };
  }

  /**
   * Ingressos (INSCRIÇÕES) de um usuário — 1 linha por Registration. `id` é o
   * registrationId (os modais de "Ver pedido"/"Ver ingresso" resolvem por ele).
   */
  async getUserRegistrations(id: string, params: { page: number; limit: number }) {
    const { page, limit } = params;
    const skip = (page - 1) * limit;
    const prismaRead = this.prisma.getReadClient();

    const exists = await prismaRead.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Usuário não encontrado');

    const where: Prisma.RegistrationWhereInput = { userId: id };
    const [rows, total] = await Promise.all([
      prismaRead.registration.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          createdAt: true,
          status: true,
          // Campos crus do pagamento p/ o front replicar EXATAMENTE o status da
          // tela de inscrições do evento (getFinalStatus: estorno/chargeback etc).
          order: {
            select: { id: true, payment: { select: { status: true, metadata: true } } },
          },
          event: { select: { id: true, name: true } },
        },
      }),
      prismaRead.registration.count({ where }),
    ]);

    return {
      message: 'Registrations fetched successfully',
      data: {
        registrations: rows.map((r) => {
          const pay = r.order?.payment ?? null;
          const refundType = extractRefundType(pay?.metadata);
          return {
            id: r.id,
            createdAt: r.createdAt,
            status: r.status,
            eventName: r.event?.name ?? '',
            orderId: r.order?.id ?? null,
            // Mesma shape (subset) que RegistrationListRow → o front chama getFinalStatus.
            order: {
              payment: pay
                ? {
                    status: pay.status,
                    refundType,
                    metadata: refundType ? { refundType } : null,
                  }
                : null,
            },
          };
        }),
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
   * CSV dos ingressos do usuário — MESMO gerador/colunas do export de inscrições
   * do evento (ExportRegistrationsService.generateTxt), porém filtrado por usuário.
   */
  async exportUserRegistrationsCsv(
    id: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const exists = await this.prisma.getReadClient().user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Usuário não encontrado');

    const { registrations, eventName } =
      await this.events.getUserRegistrationsForExport(id);
    // Todos os campos (mesmo default do export de inscrições sem `fields`).
    const fields = this.exportService.parseFields(undefined);
    const buffer = this.exportService.generateTxt(registrations, fields, eventName);
    return { buffer, filename: `ingressos-${id.slice(0, 8)}.csv` };
  }
}
