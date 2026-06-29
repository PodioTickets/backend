import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventStatus, Prisma } from '@prisma/client';
import { EmailService } from '../../common/services/email.service';
import { withPastEventsAsCompleted as markPastEventsCompleted } from '../../common/utils/event-status.util';

export interface AdminEventsQuery {
  page: number;
  limit: number;
  search?: string;
  status?: EventStatus;
  organizationId?: string;
  city?: string;
  state?: string;
  country?: string;
  eventDateFrom?: Date;
  eventDateTo?: Date;
  createdFrom?: Date;
  createdTo?: Date;
  hasAudit?: boolean;
  sortBy?: 'eventDate' | 'createdAt' | 'name' | 'registrations' | 'revenue';
  sortOrder?: 'asc' | 'desc';
}

@Injectable()
export class AdminEventsService {
  private readonly logger = new Logger(AdminEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async getEvents(query: AdminEventsQuery) {
    const {
      page,
      limit,
      search,
      status,
      organizationId,
      city,
      state,
      country,
      eventDateFrom,
      eventDateTo,
      createdFrom,
      createdTo,
      hasAudit,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = query;

    const prismaRead = this.prisma.getReadClient();
    const skip = (page - 1) * limit;

    const where: Prisma.EventWhereInput = {};

    if (status) where.status = status;
    if (organizationId) where.organizationId = organizationId;
    if (city) where.city = { contains: city, mode: 'insensitive' };
    if (state) where.state = { contains: state, mode: 'insensitive' };
    if (country) where.country = { contains: country, mode: 'insensitive' };
    if (hasAudit !== undefined) where.audit = hasAudit ? { isNot: null } : { is: null };

    if (eventDateFrom || eventDateTo) {
      where.eventDate = {};
      if (eventDateFrom) where.eventDate.gte = eventDateFrom;
      if (eventDateTo) where.eventDate.lte = eventDateTo;
    }

    if (createdFrom || createdTo) {
      where.createdAt = {};
      if (createdFrom) where.createdAt.gte = createdFrom;
      if (createdTo) where.createdAt.lte = createdTo;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
        { organization: { name: { contains: search, mode: 'insensitive' } } },
        { organization: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    // Ordenação por agregados de relação exige SQL raw — campos simples via orderBy
    const simpleSort = sortBy === 'registrations' || sortBy === 'revenue'
      ? { createdAt: sortOrder as Prisma.SortOrder }
      : sortBy === 'name'
        ? { name: sortOrder as Prisma.SortOrder }
        : sortBy === 'eventDate'
          ? { eventDate: sortOrder as Prisma.SortOrder }
          : { createdAt: sortOrder as Prisma.SortOrder };

    const [events, total] = await Promise.all([
      prismaRead.event.findMany({
        where,
        orderBy: simpleSort,
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          bannerUrl: true,
          status: true,
          city: true,
          state: true,
          country: true,
          location: true,
          eventDate: true,
          registrationStartDate: true,
          registrationEndDate: true,
          organizerFeePercent: true,
          retentionRate: true,
          createdAt: true,
          updatedAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              tradeName: true,
              email: true,
              logoUrl: true,
              document: true,
              phone: true,
            },
          },
          audit: { select: { id: true, createdAt: true, retentionReleased: true } },
          _count: {
            select: {
              registrations: true,
              orders: true,
              tickets: true,
              withdrawals: true,
            },
          },
        },
      }),
      prismaRead.event.count({ where }),
    ]);

    const eventIds = events.map((e) => e.id);

    // groupBy não suporta filtros de relação — SQL raw para os dois agregados
    const [revenueRows, confirmedRows] = await Promise.all([
      prismaRead.$queryRaw<{ eventId: string; revenue: bigint }[]>(
        Prisma.sql`
          SELECT o."eventId", COALESCE(SUM(o."finalAmount"), 0)::bigint AS revenue
          FROM "Order" o
          INNER JOIN "Payment" p ON p."orderId" = o.id
          WHERE o."eventId" = ANY(${eventIds}::uuid[])
            AND p.status = 'PAID'
          GROUP BY o."eventId"
        `,
      ),
      prismaRead.$queryRaw<{ eventId: string; confirmed: bigint }[]>(
        Prisma.sql`
          SELECT "eventId", COUNT(id)::bigint AS confirmed
          FROM "Registration"
          WHERE "eventId" = ANY(${eventIds}::uuid[])
            AND status IN ('CONFIRMED', 'COMPLETED')
          GROUP BY "eventId"
        `,
      ),
    ]);

    const revenueByEvent = new Map(
      revenueRows.map((r) => [r.eventId, Number(r.revenue)]),
    );
    const confirmedByEvent = new Map(
      confirmedRows.map((r) => [r.eventId, Number(r.confirmed)]),
    );

    // MESMA regra da lista do organizador: evento cuja DATA já passou (fim do dia
    // BRT) é exibido como COMPLETED. Antes o admin devolvia o status cru do banco,
    // divergindo do organizador. Fonte única em `event-status.util`.
    const data = markPastEventsCompleted(
      events.map((event) => ({
        ...event,
        revenue: revenueByEvent.get(event.id) ?? 0,
        confirmedRegistrations: confirmedByEvent.get(event.id) ?? 0,
      })),
    );

    // Ordenação em memória para campos de agregado (registrations/revenue) após enriquecimento
    if (sortBy === 'registrations') {
      data.sort((a, b) =>
        sortOrder === 'asc'
          ? a.confirmedRegistrations - b.confirmedRegistrations
          : b.confirmedRegistrations - a.confirmedRegistrations,
      );
    } else if (sortBy === 'revenue') {
      data.sort((a, b) =>
        sortOrder === 'asc' ? a.revenue - b.revenue : b.revenue - a.revenue,
      );
    }

    return {
      message: 'Events fetched successfully',
      data: {
        events: data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  async getRevisionEvents(page: number, limit: number, search?: string, organizationId?: string) {
    const prismaRead = this.prisma.getReadClient();
    const skip = (page - 1) * limit;

    const where: Prisma.EventWhereInput = { status: EventStatus.REVISION };

    if (organizationId) where.organizationId = organizationId;

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
        { organization: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [events, total] = await Promise.all([
      prismaRead.event.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          bannerUrl: true,
          status: true,
          city: true,
          state: true,
          country: true,
          location: true,
          eventDate: true,
          registrationStartDate: true,
          registrationEndDate: true,
          organizerFeePercent: true,
          retentionRate: true,
          createdAt: true,
          updatedAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              tradeName: true,
              email: true,
              logoUrl: true,
              document: true,
              phone: true,
            },
          },
          _count: { select: { registrations: true, tickets: true } },
        },
      }),
      prismaRead.event.count({ where }),
    ]);

    return {
      message: 'Revision events fetched successfully',
      data: {
        events,
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
   * Aprova evento em revisão: muda status REVISION → PUBLISHED, trava configurações
   * financeiras e notifica o organizador por e-mail (fire-and-forget).
   */
  async approveEvent(adminUserId: string, eventId: string) {
    const prismaWrite = this.prisma.getWriteClient();

    const event = await prismaWrite.event.findUnique({
      where: { id: eventId },
      include: {
        organization: {
          select: {
            email: true,
            name: true,
            tradeName: true,
            members: {
              where: { role: 'OWNER' },
              select: { user: { select: { email: true } } },
              take: 1,
            },
          },
        },
      },
    });

    if (!event) throw new NotFoundException('Evento não encontrado');
    if (event.status !== EventStatus.REVISION) {
      throw new BadRequestException('Somente eventos em revisão podem ser publicados pelo admin');
    }

    const now = new Date();

    const updatedEvent = await prismaWrite.event.update({
      where: { id: eventId },
      data: {
        status: EventStatus.PUBLISHED,
        financialSettingsLockedAt: now,
      },
      select: { id: true, name: true, status: true, financialSettingsLockedAt: true, updatedAt: true },
    });

    this.logger.log(`Admin ${adminUserId} aprovou evento ${eventId} (${event.name}) — status REVISION → PUBLISHED`);

    // Notifica organizador por e-mail (fire-and-forget — falha não bloqueia resposta).
    // Contato da org primeiro; fallback pro e-mail do dono — senão orgs sem
    // e-mail de contato nunca recebiam o aviso de aprovação/publicação.
    const organizerEmail =
      event.organization?.email || event.organization?.members?.[0]?.user?.email;
    if (organizerEmail) {
      const weekdays = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
      const eventDt = new Date(event.eventDate);
      const eventDateFormatted = `${eventDt.toLocaleDateString('pt-BR')} · ${weekdays[eventDt.getDay()]}`;
      // Card do e-mail exibe apenas Estado, Cidade (sem endereço completo)
      const eventLocation = [event.state, event.city].filter(Boolean).join(', ');

      const submittedHH = String(now.getHours()).padStart(2, '0');
      const submittedMM = String(now.getMinutes()).padStart(2, '0');
      const submittedAtFormatted = `${now.toLocaleDateString('pt-BR')} · ${submittedHH}h${submittedMM}`;

      const organizerName = event.organization?.tradeName ?? event.organization?.name ?? '';

      this.emailService
        .sendEventApproved({
          recipientEmail: organizerEmail,
          organizerName,
          eventName: event.name,
          // Template usa imagem 308x308 = imagem do CARD (logoUrl), não o banner.
          eventBannerUrl: (event as any).logoUrl ?? event.bannerUrl ?? '',
          eventDate: eventDateFormatted,
          eventLocation,
          submittedAt: submittedAtFormatted,
        })
        .catch((err) =>
          this.logger.warn(`Falha ao enviar e-mail de evento aprovado (eventId=${eventId}): ${err?.message ?? err}`),
        );
    }

    return {
      message: 'Event approved and published successfully',
      data: { event: updatedEvent },
    };
  }

  async updateFinancialSettings(
    eventId: string,
    dto: {
      organizerFeePercent?: number;
      participantFeePercent?: number;
      maxInstallments?: number;
      totalFee?: number;
      retentionRate?: number;
      refundFeeRate?: number;
    },
  ) {
    const w = this.prisma.getWriteClient();

    const event = await w.event.findUnique({ where: { id: eventId }, select: { id: true } });
    if (!event) throw new NotFoundException('Evento não encontrado');

    const data: any = {};
    if (dto.organizerFeePercent !== undefined) data.organizerFeePercent = dto.organizerFeePercent;
    if (dto.participantFeePercent !== undefined) data.participantFeePercent = dto.participantFeePercent;
    if (dto.maxInstallments !== undefined) data.maxInstallments = dto.maxInstallments;
    // Taxas Podio↔organizador por evento. Editar aqui afeta SÓ este evento (e seus
    // cálculos vivos de repasse); novos eventos seguem o default do EventsService.create.
    if (dto.retentionRate !== undefined) data.retentionRate = dto.retentionRate;
    if (dto.refundFeeRate !== undefined) data.refundFeeRate = dto.refundFeeRate;

    const updated = await w.event.update({
      where: { id: eventId },
      data,
      select: {
        id: true,
        organizerFeePercent: true,
        participantFeePercent: true,
        maxInstallments: true,
        retentionRate: true,
        refundFeeRate: true,
        financialSettingsLockedAt: true,
      },
    });

    return {
      message: 'Financial settings updated successfully',
      data: {
        eventId: updated.id,
        organizerFeePercent: updated.organizerFeePercent,
        participantFeePercent: updated.participantFeePercent,
        maxInstallments: updated.maxInstallments,
        retentionRate: updated.retentionRate,
        refundFeeRate: updated.refundFeeRate,
        lockedAt: updated.financialSettingsLockedAt ?? null,
      },
    };
  }
}
