import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventStatus, Prisma } from '@prisma/client';
import { EmailService } from '../../common/services/email.service';
import {
  withPastEventsAsCompleted as markPastEventsCompleted,
  pastEventDateCutoff,
} from '../../common/utils/event-status.util';
import { formatEventCardAddress } from '../../common/utils/event-email-format.util';

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

  /**
   * Receita paga e inscrições confirmadas por evento.
   *
   * `groupBy` do Prisma não suporta filtro por relação (receita depende de
   * `Payment.status = PAID`), então os dois agregados vão em SQL cru. Chamado
   * tanto para enriquecer a página quanto para ORDENAR o conjunto inteiro
   * (sortBy = registrations/revenue) — daí ser um helper e não código inline.
   */
  private async fetchEventAggregates(
    prismaRead: ReturnType<PrismaService['getReadClient']>,
    eventIds: string[],
  ): Promise<{
    revenueByEvent: Map<string, number>;
    confirmedByEvent: Map<string, number>;
  }> {
    if (eventIds.length === 0) {
      return { revenueByEvent: new Map(), confirmedByEvent: new Map() };
    }

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

    return {
      revenueByEvent: new Map(
        revenueRows.map((r) => [r.eventId, Number(r.revenue)]),
      ),
      confirmedByEvent: new Map(
        confirmedRows.map((r) => [r.eventId, Number(r.confirmed)]),
      ),
    };
  }

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

    if (organizationId) where.organizationId = organizationId;
    if (city) where.city = { contains: city, mode: 'insensitive' };
    if (state) where.state = { contains: state, mode: 'insensitive' };
    if (country) where.country = { contains: country, mode: 'insensitive' };
    if (hasAudit !== undefined) where.audit = hasAudit ? { isNot: null } : { is: null };

    const eventDateFilter: Prisma.DateTimeFilter = {};
    if (eventDateFrom) eventDateFilter.gte = eventDateFrom;
    if (eventDateTo) eventDateFilter.lte = eventDateTo;

    // O status EXIBIDO não é o do banco: COMPLETED é derivado da data
    // (`withPastEventsAsCompleted`). Filtrar pelo status cru devolvia ZERO em
    // "Concluído" (nenhuma linha tem COMPLETED persistido) e, pior, devolvia
    // eventos já concluídos dentro de "Publicado"/"Rascunho". Filtro e exibição
    // usam agora a MESMA regra — `pastEventDateCutoff` é indexável
    // (@@index([eventDate]) / @@index([status, eventDate])).
    const completedCutoff = pastEventDateCutoff();
    if (status === EventStatus.COMPLETED) {
      // "Concluído" = data já passou, seja qual for o status cru — é exatamente o
      // conjunto que a lista rotula assim.
      eventDateFilter.lt = completedCutoff;
    } else if (status) {
      where.status = status;
      // Evento com data passada aparece como "Concluído", nunca no status cru.
      // Se já houver um `gte` do filtro de data, vale o mais restritivo.
      eventDateFilter.gte =
        eventDateFrom && eventDateFrom > completedCutoff
          ? eventDateFrom
          : completedCutoff;
    }

    if (Object.keys(eventDateFilter).length > 0) {
      where.eventDate = eventDateFilter;
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

    // Ordenação por AGREGADO (inscritos/receita) não existe no banco como coluna:
    // é derivada de Registration/Order. Ordenar depois de paginar ordenaria só a
    // página corrente (e, com muitos zeros empatados, o sort estável devolvia
    // exatamente a ordem do banco — o filtro parecia não funcionar). Por isso o
    // caminho de agregado resolve o conjunto INTEIRO antes de fatiar a página.
    const isAggregateSort = sortBy === 'registrations' || sortBy === 'revenue';

    // Desempate por `id` mantém a paginação determinística (sem ele, empates em
    // name/eventDate podem repetir ou omitir registros entre páginas).
    const simpleSort: Prisma.EventOrderByWithRelationInput[] =
      sortBy === 'name'
        ? [{ name: sortOrder as Prisma.SortOrder }, { id: sortOrder as Prisma.SortOrder }]
        : sortBy === 'eventDate'
          ? [{ eventDate: sortOrder as Prisma.SortOrder }, { id: sortOrder as Prisma.SortOrder }]
          : [{ createdAt: sortOrder as Prisma.SortOrder }, { id: sortOrder as Prisma.SortOrder }];

    const eventSelect = {
      id: true,
      name: true,
      slug: true,
      bannerUrl: true,
      status: true,
      city: true,
      state: true,
      country: true,
      location: true,
      eventDate: true,
      registrationStartDate: true,
      registrationEndDate: true,
      featuredOrder: true,
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
    } satisfies Prisma.EventSelect;

    let events: Prisma.EventGetPayload<{ select: typeof eventSelect }>[];
    let total: number;
    let revenueByEvent: Map<string, number>;
    let confirmedByEvent: Map<string, number>;

    if (isAggregateSort) {
      // 1) IDs do conjunto filtrado inteiro (projeção mínima — o `where` continua
      //    sendo fonte única, sem duplicar os filtros em SQL cru).
      const idRows = await prismaRead.event.findMany({
        where,
        select: { id: true, createdAt: true },
      });
      total = idRows.length;
      const allIds = idRows.map((r) => r.id);

      ({ revenueByEvent, confirmedByEvent } = await this.fetchEventAggregates(
        prismaRead,
        allIds,
      ));

      const metric = sortBy === 'revenue' ? revenueByEvent : confirmedByEvent;
      const dir = sortOrder === 'asc' ? 1 : -1;
      // Desempate por createdAt desc (e id) → ordem estável entre páginas.
      const pageIds = idRows
        .sort(
          (a, b) =>
            dir * ((metric.get(a.id) ?? 0) - (metric.get(b.id) ?? 0)) ||
            b.createdAt.getTime() - a.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        )
        .slice(skip, skip + limit)
        .map((r) => r.id);

      const rows = await prismaRead.event.findMany({
        where: { id: { in: pageIds } },
        select: eventSelect,
      });
      // `findMany` com `in` não preserva a ordem do array — reordenar pelo índice.
      const byId = new Map(rows.map((r) => [r.id, r]));
      events = pageIds
        .map((id) => byId.get(id))
        .filter((e): e is (typeof rows)[number] => Boolean(e));
    } else {
      [events, total] = await Promise.all([
        prismaRead.event.findMany({
          where,
          orderBy: simpleSort,
          skip,
          take: limit,
          select: eventSelect,
        }),
        prismaRead.event.count({ where }),
      ]);

      ({ revenueByEvent, confirmedByEvent } = await this.fetchEventAggregates(
        prismaRead,
        events.map((e) => e.id),
      ));
    }

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

    // NÃO reordenar aqui: quando `sortBy` é agregado a ordem já veio resolvida
    // sobre o conjunto inteiro (acima) e `events` está na ordem final da página.

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
          bannerUrl: true,
          status: true,
          city: true,
          state: true,
          country: true,
          location: true,
          eventDate: true,
          registrationStartDate: true,
          registrationEndDate: true,
          featuredOrder: true,
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
      // Endereço do card = Local, Cidade, Estado (igual ao card da home).
      const eventLocation = formatEventCardAddress(event);

      const submittedHH = String(now.getHours()).padStart(2, '0');
      const submittedMM = String(now.getMinutes()).padStart(2, '0');
      const submittedAtFormatted = `${now.toLocaleDateString('pt-BR')} · ${submittedHH}h${submittedMM}`;

      const organizerName = event.organization?.tradeName ?? event.organization?.name ?? '';

      this.emailService
        .sendEventApproved({
          recipientEmail: organizerEmail,
          organizerName,
          eventName: event.name,
          // Imagem do e-mail = BANNER do evento (logoUrl descontinuado).
          eventBannerUrl: event.bannerUrl ?? '',
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

  /**
   * Recusa evento em revisão: REVISION → CHANGES_REQUESTED, grava o motivo e
   * notifica o organizador por e-mail (fire-and-forget, igual ao approve).
   *
   * O `financialSettingsLockedAt` continua setado: quem destrava é a volta para
   * DRAFT (`EventsService.revertToDraft`), quando o organizador de fato decide
   * editar. Assim um evento parado em CHANGES_REQUESTED não fica com a taxa
   * editável pelas costas da auditoria.
   */
  async rejectEvent(adminUserId: string, eventId: string, reason: string) {
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
      throw new BadRequestException('Somente eventos em revisão podem ser recusados');
    }

    const now = new Date();
    const trimmedReason = reason.trim();

    const updatedEvent = await prismaWrite.event.update({
      where: { id: eventId },
      data: {
        status: EventStatus.CHANGES_REQUESTED,
        rejectionReason: trimmedReason,
        rejectedAt: now,
        rejectedById: adminUserId,
      },
      select: {
        id: true,
        name: true,
        status: true,
        rejectionReason: true,
        rejectedAt: true,
        updatedAt: true,
      },
    });

    // Motivo NÃO entra no log: é texto livre do admin e pode citar dados do
    // organizador. Fica só no banco, lido pela própria tela.
    this.logger.log(
      `Admin ${adminUserId} recusou evento ${eventId} (${event.name}) — status REVISION → CHANGES_REQUESTED`,
    );

    // Notifica organizador por e-mail (fire-and-forget — falha não bloqueia a
    // resposta). Contato da org primeiro, com fallback pro e-mail do dono:
    // mesma regra do `approveEvent`.
    const organizerEmail =
      event.organization?.email || event.organization?.members?.[0]?.user?.email;
    if (organizerEmail) {
      const weekdays = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
      const eventDt = new Date(event.eventDate);
      const eventDateFormatted = `${eventDt.toLocaleDateString('pt-BR')} · ${weekdays[eventDt.getDay()]}`;
      // Endereço do card = Local, Cidade, Estado (igual ao card da home).
      const eventLocation = formatEventCardAddress(event);

      const reviewedHH = String(now.getHours()).padStart(2, '0');
      const reviewedMM = String(now.getMinutes()).padStart(2, '0');
      const reviewedAtFormatted = `${now.toLocaleDateString('pt-BR')} · ${reviewedHH}h${reviewedMM}`;

      const organizerName = event.organization?.tradeName ?? event.organization?.name ?? '';

      this.emailService
        .sendEventChangesRequested({
          recipientEmail: organizerEmail,
          organizerName,
          eventName: event.name,
          // Imagem do e-mail = BANNER do evento (logoUrl descontinuado).
          eventBannerUrl: event.bannerUrl ?? '',
          eventDate: eventDateFormatted,
          eventLocation,
          reviewedAt: reviewedAtFormatted,
          reason: trimmedReason,
        })
        .catch((err) =>
          this.logger.warn(
            `Falha ao enviar e-mail de ajustes solicitados (eventId=${eventId}): ${err?.message ?? err}`,
          ),
        );
    }

    return {
      message: 'Event rejected successfully',
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

  // ── Eventos em destaque (carrossel da home + prioridade na busca) ───────────
  // Modelo: `Event.featuredOrder` (Int?, null = não destacado). A ordem é sempre
  // renumerada de forma CONTÍGUA (1..N) a cada escrita, então o índice do array
  // reflete exatamente a posição — o front nunca precisa reconciliar buracos.

  /** Select mínimo do card de destaque (thumb + nome + local + datas p/ status). */
  private static readonly FEATURED_SELECT = {
    id: true,
    name: true,
    slug: true,
    bannerUrl: true,
    city: true,
    state: true,
    locationName: true,
    status: true,
    eventDate: true,
    registrationStartDate: true,
    registrationEndDate: true,
    featuredOrder: true,
  } as const;

  /** Lista os destacados na ordem definida. Recebe o client da transação quando
   *  chamado após uma escrita; fora de txn usa a read replica. */
  private async readFeatured(
    client: Prisma.TransactionClient = this.prisma.getReadClient(),
  ) {
    return client.event.findMany({
      where: { featuredOrder: { not: null } },
      orderBy: { featuredOrder: 'asc' },
      select: AdminEventsService.FEATURED_SELECT,
    });
  }

  /** GET — eventos em destaque, na ordem do carrossel. */
  async listFeatured() {
    const events = await this.readFeatured();
    return { message: 'Featured events fetched successfully', data: { events } };
  }

  /** POST — adiciona o evento ao fim do carrossel (featuredOrder = max + 1). */
  async addFeatured(eventId: string) {
    const w = this.prisma.getWriteClient();
    const events = await w.$transaction(async (tx) => {
      const event = await tx.event.findUnique({
        where: { id: eventId },
        select: { id: true, status: true, featuredOrder: true },
      });
      if (!event) throw new NotFoundException('Evento não encontrado');

      // Idempotente: já em destaque → não duplica nem reordena.
      if (event.featuredOrder == null) {
        // Só eventos PUBLICADOS aparecem no carrossel/busca pública — impedir
        // destacar DRAFT/REVISION/SUSPENDED/etc. evita "furo" no público.
        if (event.status !== EventStatus.PUBLISHED) {
          throw new BadRequestException(
            'Apenas eventos publicados podem entrar em destaque',
          );
        }
        const agg = await tx.event.aggregate({ _max: { featuredOrder: true } });
        const next = (agg._max.featuredOrder ?? 0) + 1;
        await tx.event.update({ where: { id: eventId }, data: { featuredOrder: next } });
      }
      return this.readFeatured(tx);
    });
    return { message: 'Event added to featured', data: { events } };
  }

  /** DELETE — remove do destaque e renumera o restante de forma contígua. */
  async removeFeatured(eventId: string) {
    const w = this.prisma.getWriteClient();
    const events = await w.$transaction(async (tx) => {
      const event = await tx.event.findUnique({
        where: { id: eventId },
        select: { id: true, featuredOrder: true },
      });
      if (!event) throw new NotFoundException('Evento não encontrado');

      if (event.featuredOrder != null) {
        await tx.event.update({ where: { id: eventId }, data: { featuredOrder: null } });
        await this.renumberFeatured(tx);
      }
      return this.readFeatured(tx);
    });
    return { message: 'Event removed from featured', data: { events } };
  }

  /** PATCH — reordena o carrossel. `orderedIds` deve ser EXATAMENTE o conjunto
   *  atual de destacados (previne destacar/remover por engano via reorder). */
  async reorderFeatured(orderedIds: string[]) {
    const w = this.prisma.getWriteClient();
    const events = await w.$transaction(async (tx) => {
      const current = await tx.event.findMany({
        where: { featuredOrder: { not: null } },
        select: { id: true },
      });
      const currentIds = new Set(current.map((e) => e.id));
      const uniqueIncoming = new Set(orderedIds);
      const sameSet =
        orderedIds.length === currentIds.size &&
        uniqueIncoming.size === orderedIds.length &&
        orderedIds.every((id) => currentIds.has(id));
      if (!sameSet) {
        throw new BadRequestException(
          'A ordem enviada não corresponde aos eventos em destaque atuais',
        );
      }
      // Renumera 1..N na ordem recebida.
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.event.update({
          where: { id: orderedIds[i] },
          data: { featuredOrder: i + 1 },
        });
      }
      return this.readFeatured(tx);
    });
    return { message: 'Featured events reordered', data: { events } };
  }

  /** Renumera os destacados restantes para 1..N (sem buracos), na ordem atual. */
  private async renumberFeatured(tx: Prisma.TransactionClient) {
    const rest = await tx.event.findMany({
      where: { featuredOrder: { not: null } },
      orderBy: { featuredOrder: 'asc' },
      select: { id: true },
    });
    for (let i = 0; i < rest.length; i++) {
      await tx.event.update({
        where: { id: rest[i].id },
        data: { featuredOrder: i + 1 },
      });
    }
  }
}
