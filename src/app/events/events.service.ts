import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrganizerMemberAccessService } from '../organizations/organizer-member-access.service';
import { OrganizationsService } from '../organizations/organizations.service';
import type { OrganizerPermissionKey } from '../organizations/constants/organizer-permissions';
import { effectivePermissionsForMember } from '../organizations/constants/organizer-permissions';
import {
  CreateEventDto,
  UpdateEventDto,
  FilterEventsDto,
  type SearchEventsDto,
  type SearchEventLocationsDto,
} from './dto/create-event.dto';
import {
  CreateEventTopicDto,
  UpdateEventTopicDto,
  ReorderEventTopicsDto,
  CreateEventLocationDto,
} from './dto/event-topic.dto';
import { DashboardQueryDto, DashboardPeriod } from './dto/dashboard.dto';
import { FinancialQueryDto, FinancialPeriod } from './dto/financial.dto';
import { RegistrationsQueryDto } from './dto/registrations.dto';
import {
  EventStatus,
  RegistrationStatus,
  PaymentStatus,
  PaymentMethod,
  WithdrawalStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { generateSlug, generateUniqueSlug } from '../../helpers/SlugHelper';
import { diffEventUpdateAgainstData } from './event-audit.helpers';
import {
  UNCATEGORIZED_CATEGORY_KEY,
  type EventKitSelectionDisplayDto,
} from './dto/kit-selection-display.dto';
import { UpdateEventAdsTrackingDto } from './dto/event-ads-tracking.dto';
import { TicketsService } from '../tickets/tickets.service';
import { EmailService } from '../../common/services/email.service';
import { RepasseService } from '../repasse/repasse.service';
import { CacheRedisService } from '../../common/services/cache-redis.service';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizerMemberAccess: OrganizerMemberAccessService,
    private readonly organizationsService: OrganizationsService,
    private readonly ticketsService: TicketsService,
    private readonly emailService: EmailService,
    private readonly repasseService: RepasseService,
    private readonly cache: CacheRedisService,
  ) { }

  /** Cache key + TTL para findOne/findBySlug. Invalidado em update/delete. */
  private static readonly EVENT_CACHE_TTL_SECONDS = 30;
  private eventCacheKeyById(id: string): string { return `event:byId:${id}`; }
  private eventCacheKeyBySlug(slug: string): string { return `event:bySlug:${slug}`; }

  /** Fire-and-forget — cache miss é seguro (degrada pra query). */
  private invalidateEventCacheById(id: string): void {
    this.cache.del(this.eventCacheKeyById(id)).catch(() => undefined);
  }

  /**
   * Retorna o valor em centavos (valores já estão em centavos no banco)
   */
  private normalizeToCents(value: number | null | undefined): number {
    if (!value || value === 0) return 0;
    return value; // Valor exato, sem arredondamento
  }

  /**
   * Valida se uma string é um UUID válido
   */
  private isValidUUID(id: string): boolean {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
  }

  /**
   * Valida UUID e lança exceção se inválido
   */
  private validateUUID(id: string, fieldName: string = 'ID'): void {
    if (!this.isValidUUID(id)) {
      throw new BadRequestException(
        `Invalid ${fieldName} format. Expected UUID.`,
      );
    }
  }

  /**
   * Endereço de cobrança: colunas do Order; fallback para payment.metadata.billingAddress (pedidos antigos).
   */
  private resolveOrderBillingAddress(
    order: any,
    payment?: { metadata?: unknown } | null,
  ): {
    country: string;
    postalCode: string | null;
    stateUf: string | null;
    street: string | null;
    number: string | null;
    complement: string | null;
    neighborhood: string | null;
    city: string | null;
  } | null {
    if (!order) return null;
    const hasDb =
      order.billingCountry != null && String(order.billingCountry).trim() !== '';
    if (hasDb) {
      return {
        country: String(order.billingCountry).trim(),
        postalCode: order.billingPostalCode ?? null,
        stateUf: order.billingStateUf ?? null,
        street: order.billingStreet ?? null,
        number: order.billingNumber ?? null,
        complement: order.billingComplement ?? null,
        neighborhood: order.billingNeighborhood ?? null,
        city: order.billingCity ?? null,
      };
    }
    let metadata: any = payment?.metadata;
    if (typeof metadata === 'string') {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = null;
      }
    }
    const b = metadata?.billingAddress;
    if (b && typeof b === 'object' && b.country) {
      return {
        country: String(b.country),
        postalCode: b.postalCode ?? null,
        stateUf: b.stateUf ?? null,
        street: b.street ?? null,
        number: b.number ?? null,
        complement: b.complement ?? null,
        neighborhood: b.neighborhood ?? null,
        city: b.city ?? null,
      };
    }
    return null;
  }

  /**
   * Garante que kitSelectionDisplay referencia apenas tickets/categorias/produtos do evento.
   * Duas leituras em paralelo (ingressos + categorias).
   */
  private async assertKitSelectionDisplayConsistent(
    prismaRead: ReturnType<PrismaService['getReadClient']>,
    eventId: string,
    payload: EventKitSelectionDisplayDto,
  ): Promise<void> {
    const [tickets, categories] = await Promise.all([
      prismaRead.ticket.findMany({ where: { eventId }, select: { id: true } }),
      prismaRead.ticketCategory.findMany({ where: { eventId }, select: { id: true } }),
    ]);

    const ticketIds = new Set(tickets.map((t) => t.id));
    const categoryIds = new Set(categories.map((c) => c.id));

    for (const tid of Object.keys(payload.primaryKitProductByTicketId)) {
      this.validateUUID(tid, 'ticketId in primaryKitProductByTicketId');
      if (!ticketIds.has(tid)) {
        throw new BadRequestException(
          `kitSelectionDisplay: ticket "${tid}" does not belong to this event`,
        );
      }
    }

    for (const catKey of Object.keys(payload.primaryKitProductByCategoryId)) {
      if (catKey === UNCATEGORIZED_CATEGORY_KEY) continue;
      this.validateUUID(catKey, 'categoryId in primaryKitProductByCategoryId');
      if (!categoryIds.has(catKey)) {
        throw new BadRequestException(
          `kitSelectionDisplay: category "${catKey}" does not belong to this event`,
        );
      }
    }
  }

  /**
   * Verifica se um slug já existe no banco de dados
   */
  private async slugExists(slug: string, excludeEventId?: string): Promise<boolean> {
    const prismaRead = this.prisma.getReadClient();
    const event = await prismaRead.event.findUnique({
      where: { slug },
      select: { id: true },
    });

    if (!event) return false;

    // Se estamos atualizando um evento, ignorar o próprio evento
    if (excludeEventId && event.id === excludeEventId) {
      return false;
    }

    return true;
  }

  /**
   * Para listagens GET: eventos cuja data já passou são retornados com status COMPLETED (Finalized).
   */
  private withPastEventsAsCompleted<T extends { eventDate: Date; status: EventStatus }>(
    events: T[],
  ): T[] {
    const now = new Date();
    return events.map((e) =>
      e.eventDate < now ? { ...e, status: EventStatus.COMPLETED } : e,
    ) as T[];
  }

  /**
   * Extrai a segunda parte do UUID (ex: 2ba25f04-4b98-4e5e-9da6-ddb4e272ded4 -> 4b98)
   */
  private extractUuidSecondPart(uuid: string): string {
    const parts = uuid.split('-');
    return parts.length >= 2 ? parts[1] : '';
  }

  /**
   * Gera um slug único para o evento incluindo a segunda parte do UUID
   */
  private async generateEventSlug(
    name: string,
    eventId: string,
    customSlug?: string,
    excludeEventId?: string,
  ): Promise<string> {
    const baseSlug = customSlug || name;
    const uuidPart = this.extractUuidSecondPart(eventId);
    const slugWithUuid = uuidPart ? `${baseSlug}-${uuidPart}` : baseSlug;

    // Gerar slug amigável
    const slug = generateSlug(slugWithUuid);

    // Verificar se já existe e gerar único se necessário
    return generateUniqueSlug(slug, (s) =>
      this.slugExists(s, excludeEventId),
    );
  }

  async create(
    userId: string,
    createEventDto: CreateEventDto,
    clientIp?: string | null,
  ) {
    // Verificar se o usuário tem permissão para criar eventos
    const prismaWrite = this.prisma.getWriteClient();

    const memberships = await prismaWrite.organizationMember.findMany({
      where: { userId },
      include: { organization: true },
    });

    if (!memberships.length) {
      throw new BadRequestException('Usuário não é membro de nenhuma organização');
    }

    // Prefere OWNER; fallback para EMPLOYEE com create_event
    let member = memberships.find((m) => m.role === 'OWNER') ?? null;
    if (!member) {
      member =
        memberships.find((m) => {
          if (m.role !== 'EMPLOYEE') return false;
          const perms = effectivePermissionsForMember({
            role: m.role,
            permissionsJson: m.permissions,
          });
          return perms.create_event;
        }) ?? null;
    }

    if (!member) {
      throw new ForbiddenException('Missing permission: create_event');
    }

    // Verificar se já existe um evento com o mesmo nome, data e organização
    const eventDate = new Date(createEventDto.eventDate);
    const existingEvent = await prismaWrite.event.findFirst({
      where: {
        organizationId: member.organizationId,
        name: createEventDto.name,
        eventDate: {
          gte: new Date(eventDate.getTime() - 24 * 60 * 60 * 1000), // 1 dia antes
          lte: new Date(eventDate.getTime() + 24 * 60 * 60 * 1000), // 1 dia depois
        },
      },
    });

    if (existingEvent) {
      throw new BadRequestException(
        'An event with the same name and date already exists for this organization',
      );
    }

    const { cardImageUrl, ...createEventRest } = createEventDto;

    // Criar evento primeiro para ter o ID
    const event = await prismaWrite.event.create({
      data: {
        ...createEventRest,
        state: EventsService.normalizeState(createEventRest.state),
        logoUrl: createEventDto.logoUrl ?? cardImageUrl,
        slug: null, // Será gerado depois com o ID
        organizationId: member.organizationId,
        eventDate: new Date(createEventDto.eventDate),
        registrationStartDate: new Date(createEventDto.registrationStartDate),
        registrationEndDate: new Date(createEventDto.registrationEndDate),
      },
      include: {
        organization: {
          include: {
            members: {
              where: { role: 'OWNER' },
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                  },
                },
              },
              take: 1,
            },
          },
        },
      },
    });

    // Gerar slug único com a segunda parte do UUID
    const slug = await this.generateEventSlug(
      createEventDto.name,
      event.id,
      createEventDto.slug,
    );

    // Atualizar o evento com o slug gerado
    const updatedEvent = await prismaWrite.event.update({
      where: { id: event.id },
      data: { slug },
      include: {
        organization: {
          include: {
            members: {
              where: { role: 'OWNER' },
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                  },
                },
              },
              take: 1,
            },
          },
        },
      },
    });

    await this.ensureDefaultDescriptionTopic(
      prismaWrite,
      updatedEvent.id,
      createEventDto.description,
    );

    // Garante que o EMPLOYEE criador tenha acesso ao evento que acabou de criar,
    // independente de restrictedToEvents ou whitelist prévia.
    if (member.role === 'EMPLOYEE') {
      await prismaWrite.organizationMemberEventAccess.upsert({
        where: {
          organizationMemberId_eventId: {
            organizationMemberId: member.id,
            eventId: updatedEvent.id,
          },
        },
        create: {
          organizationMemberId: member.id,
          eventId: updatedEvent.id,
        },
        update: {},
      });
    }

    const topics = await prismaWrite.eventTopic.findMany({
      where: { eventId: updatedEvent.id },
      orderBy: { order: 'asc' },
    });

    await this.organizationsService.recordOrganizationAuditLog({
      organizationId: member.organizationId,
      actorUserId: userId,
      ip: clientIp ?? null,
      action: `Criou o evento "${updatedEvent.name}"`,
      metadata: {
        kind: 'EVENT_CREATE',
        eventId: updatedEvent.id,
        changes: [
          {
            field: 'evento',
            old: null,
            new: {
              id: updatedEvent.id,
              name: updatedEvent.name,
              slug: updatedEvent.slug,
              status: updatedEvent.status,
              location: updatedEvent.location,
              city: updatedEvent.city,
              state: updatedEvent.state,
              country: updatedEvent.country,
              eventDate: updatedEvent.eventDate,
              registrationStartDate: updatedEvent.registrationStartDate,
              registrationEndDate: updatedEvent.registrationEndDate,
              bannerUrl: updatedEvent.bannerUrl,
              logoUrl: updatedEvent.logoUrl,
            },
          },
        ],
      },
    });

    return {
      message: 'Event created successfully',
      data: { event: { ...updatedEvent, topics } },
    };
  }

  /** Garante o tópico padrão de descrição (o front pode não criar tópicos no POST do evento). */
  private async ensureDefaultDescriptionTopic(
    prismaWrite: ReturnType<PrismaService['getWriteClient']>,
    eventId: string,
    description?: string | null,
  ) {
    const topicData = {
      eventId,
      title: 'Descrição do evento',
      content: (description ?? '').trim(),
      isEnabled: true,
      isDefault: true,
      isRequired: true,
      order: 0,
    };
    await prismaWrite.eventTopic.create({
      data: topicData as Prisma.EventTopicUncheckedCreateInput,
    });
  }

  private static readonly BRAZIL_UF_NAMES: Record<string, string> = {
    AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia',
    CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás',
    MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais',
    PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí',
    RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul',
    RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo',
    SE: 'Sergipe', TO: 'Tocantins',
  };

  private static readonly BRAZIL_NAME_TO_UF: Record<string, string> = Object.fromEntries(
    Object.entries(EventsService.BRAZIL_UF_NAMES).map(([uf, name]) => [name.toLowerCase(), uf]),
  );

  /** Normaliza o campo state para sigla UF canônica (ex: "São Paulo" → "SP"). */
  private static normalizeState(raw: string | undefined | null): string | undefined {
    if (!raw) return raw ?? undefined;
    const t = raw.trim();
    if (t.length === 2) {
      const uf = t.toUpperCase();
      return EventsService.BRAZIL_UF_NAMES[uf] ? uf : t;
    }
    return EventsService.BRAZIL_NAME_TO_UF[t.toLowerCase()] ?? t;
  }

  /** Mapeamento de código de modalidade -> label armazenado em Ticket.modality */
  private static readonly MODALITY_CODE_TO_LABEL: Record<string, string> = {
    corrida: 'Corrida',
    natacao: 'Natação',
    ciclismo: 'Ciclismo',
    triathlon: 'Triathlon',
    outros: 'Outros',
  };

  private async findEventIdsMatchingText(q: string): Promise<string[]> {
    const prismaRead = this.prisma.getReadClient();
    const term = `%${q.trim()}%`;
    const rows = await prismaRead.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Event"
      WHERE
        unaccent(name)        ILIKE unaccent(${term}) OR
        unaccent(description) ILIKE unaccent(${term}) OR
        unaccent(location)    ILIKE unaccent(${term}) OR
        unaccent(city)        ILIKE unaccent(${term}) OR
        unaccent(state)       ILIKE unaccent(${term})
    `;
    return rows.map((r) => r.id);
  }

  private buildPublicEventSearchWhere(params: {
    q?: string;
    country?: string;
    state?: string;
    city?: string;
    startDate?: string;
    endDate?: string;
    status?: EventStatus;
    includePast?: boolean;
    modalities?: string;
    textMatchIds?: string[];
  }): Prisma.EventWhereInput {
    const {
      q,
      country,
      state,
      city,
      startDate,
      endDate,
      status,
      includePast = false,
      modalities,
      textMatchIds,
    } = params;

    const where: Prisma.EventWhereInput = {
      status: status || EventStatus.PUBLISHED,
    };

    if (q && q.trim().length > 0) {
      // IDs pré-filtrados via unaccent no DB (accent-insensitive)
      where.id = { in: textMatchIds ?? [] };
    }

    if (country) {
      where.country = country;
    }

    if (state) {
      where.state = state;
    }

    if (city) {
      where.city = city;
    }

    if (startDate && endDate) {
      where.eventDate = {
        gte: new Date(startDate),
        lte: new Date(endDate),
      };
    } else if (!includePast) {
      where.eventDate = {
        gte: new Date(),
      };
    }

    if (modalities && modalities.trim().length > 0) {
      const codes = modalities
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const labels = codes
        .map((c) => EventsService.MODALITY_CODE_TO_LABEL[c])
        .filter((label): label is string => label !== undefined);

      if (labels.length > 0) {
        where.tickets = {
          some: {
            isActive: true,
            modality: { in: labels },
          },
        };
      }
    }

    return where;
  }

  async searchLocationFacets(dto: SearchEventLocationsDto) {
    const textMatchIds = dto.q?.trim().length
      ? await this.findEventIdsMatchingText(dto.q)
      : undefined;

    const where = this.buildPublicEventSearchWhere({ ...dto, textMatchIds });

    const prismaRead = this.prisma.getReadClient();
    const rows = await prismaRead.event.groupBy({
      by: ['state', 'city'],
      where,
      _count: { _all: true },
    });

    const byState = new Map<string, Set<string>>();
    for (const row of rows) {
      const s = row.state.trim();
      const c = row.city.trim();
      if (!s || !c) {
        continue;
      }
      if (!byState.has(s)) {
        byState.set(s, new Set());
      }
      byState.get(s)!.add(c);
    }

    const collator = new Intl.Collator('pt-BR');
    const states = Array.from(byState.entries())
      .map(([state, cities]) => ({
        state,
        cities: Array.from(cities).sort((a, b) => collator.compare(a, b)),
      }))
      .sort((a, b) => collator.compare(a.state, b.state));

    const pairCount = states.reduce((n, s) => n + s.cities.length, 0);

    return {
      message: 'Location facets retrieved successfully',
      data: {
        states,
        meta: {
          stateCount: states.length,
          pairCount,
        },
      },
    };
  }

  async search(searchDto: SearchEventsDto) {
    const { page = 1, limit = 20, ...searchFilters } = searchDto;

    const textMatchIds = searchFilters.q?.trim().length
      ? await this.findEventIdsMatchingText(searchFilters.q)
      : undefined;

    const where = this.buildPublicEventSearchWhere({ ...searchFilters, textMatchIds });

    // Usar read replica para performance
    const prismaRead = this.prisma.getReadClient();

    // Buscar eventos e total em paralelo
    const [events, total] = await Promise.all([
      prismaRead.event.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          description: true,
          bannerUrl: true,
          logoUrl: true,
          slug: true,
          location: true,
          city: true,
          state: true,
          country: true,
          eventDate: true,
          registrationStartDate: true,
          registrationEndDate: true,
          status: true,
          createdAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              email: true,
              logoUrl: true,
            },
          },
          _count: {
            select: {
              registrations: true,
              modalities: true,
            },
          },
        },
        orderBy: {
          eventDate: 'asc',
        },
      }),
      prismaRead.event.count({ where }),
    ]);

    return {
      message: 'Events search completed successfully',
      data: {
        events: this.withPastEventsAsCompleted(events),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        query: searchDto.q || null,
      },
    };
  }

  async findAll(filterDto: FilterEventsDto, userId?: string) {
    const {
      page = 1,
      limit = 10,
      country,
      state,
      city,
      name,
      startDate,
      endDate,
      thisWeek,
      thisMonth,
      status,
      includeDraft,
      includePast,
      includeHasSlots,
    } = filterDto;

    const where: any = {};

    // Catálogo público: nunca listar SUSPENDED (nem por padrão nem via includeDraft).
    // Sem status na query: apenas PUBLISHED. Com status na query: filtra pelo valor (exceto que SUSPENDED continua excluído pelo AND global abaixo).
    const statusFilter =
      status != null ? status : EventStatus.PUBLISHED;

    if (includeDraft && userId) {
      const prismaRead = this.prisma.getReadClient();
      const member = await prismaRead.organizationMember.findFirst({
        where: {
          userId,
          role: 'OWNER',
        },
      });

      if (member) {
        where.OR = [
          { status: EventStatus.PUBLISHED },
          { organizationId: member.organizationId },
        ];
      } else {
        where.status = statusFilter;
      }
    } else {
      where.status = statusFilter;
    }

    // Retornar todos os eventos (futuros e passados). Eventos passados são exibidos com status COMPLETED.
    // includePast é mantido por compatibilidade mas não filtra mais; includeDraft+userId ainda controla drafts do organizador.

    if (country) {
      where.country = country;
    }

    if (state) {
      where.state = state;
    }

    if (city) {
      where.city = city;
    }

    if (name) {
      where.name = {
        contains: name,
        mode: 'insensitive',
      };
    }

    if (thisWeek) {
      const today = new Date();
      const nextWeek = new Date(today);
      nextWeek.setDate(today.getDate() + 7);
      // Se já tiver eventDate definido, combinar com AND
      if (where.eventDate) {
        where.AND = [
          { eventDate: where.eventDate },
          {
            eventDate: {
              gte: today,
              lte: nextWeek,
            },
          },
        ];
        delete where.eventDate;
      } else {
        where.eventDate = {
          gte: today,
          lte: nextWeek,
        };
      }
    }

    if (thisMonth) {
      const today = new Date();
      const nextMonth = new Date(today);
      nextMonth.setMonth(today.getMonth() + 1);
      // Se já tiver eventDate definido, combinar com AND
      if (where.eventDate) {
        where.AND = [
          ...(where.AND || []),
          {
            eventDate: {
              gte: today,
              lte: nextMonth,
            },
          },
        ];
        delete where.eventDate;
      } else {
        where.eventDate = {
          gte: today,
          lte: nextMonth,
        };
      }
    }

    if (startDate && endDate) {
      // Se já tiver eventDate definido, combinar com AND
      if (where.eventDate) {
        where.AND = [
          ...(where.AND || []),
          {
            eventDate: {
              gte: new Date(startDate),
              lte: new Date(endDate),
            },
          },
        ];
        delete where.eventDate;
      } else {
        where.eventDate = {
          gte: new Date(startDate),
          lte: new Date(endDate),
        };
      }
    }

    const whereFinal: Prisma.EventWhereInput = {
      AND: [{ status: { not: EventStatus.SUSPENDED } }, where],
    };

    // Usar read client para operações de leitura
    const prismaRead = this.prisma.getReadClient();

    const [events, total] = await Promise.all([
      prismaRead.event.findMany({
        where: whereFinal,
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          organizationId: true,
          name: true,
          slug: true,
          description: true,
          bannerUrl: true,
          logoUrl: true,
          location: true,
          city: true,
          state: true,
          country: true,
          zipCode: true,
          neighborhood: true,
          googleMapsLink: true,
          contactEmail: true,
          instagram: true,
          facebook: true,
          youtube: true,
          tiktok: true,
          website: true,
          regulationUrl: true,
          eventDate: true,
          registrationStartDate: true,
          registrationEndDate: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              email: true,
              logoUrl: true,
            },
          },
        },
        orderBy: {
          eventDate: 'asc',
        },
      }),
      prismaRead.event.count({ where: whereFinal }),
    ]);

    const eventsCompleted = this.withPastEventsAsCompleted(events);
    const shouldIncludeSlots = includeHasSlots !== false;

    let eventsPayload = eventsCompleted;
    if (shouldIncludeSlots && eventsCompleted.length > 0) {
      const slotMaps = await this.loadRegistrationSlotCountMapsForTickets(
        prismaRead,
        eventsCompleted.map((e) => e.id),
      );
      eventsPayload = eventsCompleted.map((e) => ({
        ...e,
        hasRegistrationSlotsAvailable: this.computeSlotsFromCounts(
          e.status,
          e.eventDate instanceof Date ? e.eventDate : new Date(e.eventDate),
          slotMaps.ticketsByEvent.get(e.id) ?? [],
          slotMaps.totalByTicket,
          slotMaps.soldWithBatchByTicket,
          slotMaps.soldByBatch,
        ),
      }));
    }

    return {
      message: 'Events fetched successfully',
      data: {
        events: eventsPayload,
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
   * Busca eventos de um organizador de forma performática
   * Usa read replica e índice [organizationId, createdAt]
   */
  async findByOrganizer(
    userId: string,
    filterDto: {
      page?: number;
      limit?: number;
      status?: EventStatus;
      includePast?: boolean;
      startDate?: string;
      endDate?: string;
      name?: string;
    } = {},
  ) {
    const {
      page = 1,
      limit = 20,
      status,
      /** Por padrão lista toda a linha do tempo (passados e futuros), com paginação. */
      includePast = true,
      startDate,
      endDate,
      name,
    } = filterDto;

    const prismaRead = this.prisma.getReadClient();

    const orgMember =
      await this.organizerMemberAccess.getMemberForOrganizerUser(userId);

    const scopeWhere = this.organizerMemberAccess.buildOrganizerEventsWhere(
      orgMember,
    );

    // Construir where clause otimizado para usar índice [organizationId, createdAt]
    const where: any = {
      ...scopeWhere,
    };

    // Filtro por status
    if (status) {
      where.status = status;
    }

    // Filtro por data
    if (startDate && endDate) {
      where.eventDate = {
        gte: new Date(startDate),
        lte: new Date(endDate),
      };
    } else if (!includePast) {
      // Por padrão, apenas eventos futuros
      where.eventDate = {
        gte: new Date(),
      };
    }

    // Filtro por nome
    if (name) {
      where.name = {
        contains: name,
        mode: 'insensitive',
      };
    }

    // Query performática usando Promise.all para paralelizar
    const [events, total] = await Promise.all([
      prismaRead.event.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        select: {
          // Selecionar apenas campos necessários para performance
          id: true,
          name: true,
          description: true,
          bannerUrl: true,
          logoUrl: true,
          slug: true,
          location: true,
          city: true,
          state: true,
          country: true,
          eventDate: true,
          registrationEndDate: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          kitSelectionDisplay: true,
          // Contadores úteis sem carregar relações completas
          _count: {
            select: {
              registrations: true,
              modalities: true,
            },
          },
        },
        // Ordenar por createdAt desc para usar índice [organizationId, createdAt]
        orderBy: {
          createdAt: 'desc',
        },
      }),
      prismaRead.event.count({ where }),
    ]);

    // Uma query agregada por eventId (evita N aggregates — um por evento da página)
    const salesByEventId = new Map<string, number>();
    if (events.length > 0) {
      const salesRows = await prismaRead.order.groupBy({
        by: ['eventId'],
        where: {
          eventId: { in: events.map((e) => e.id) },
          payment: {
            status: PaymentStatus.PAID,
          },
        },
        _sum: {
          finalAmount: true,
        },
      });
      for (const row of salesRows) {
        salesByEventId.set(
          row.eventId,
          this.normalizeToCents(row._sum.finalAmount),
        );
      }
    }

    const eventsWithSales = events.map((event) => ({
      ...event,
      totalSales: salesByEventId.get(event.id) ?? 0,
    }));

    return {
      message: 'Organizer events fetched successfully',
      data: {
        events: this.withPastEventsAsCompleted(eventsWithSales),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  async findOne(id: string, userId?: string) {
    this.validateUUID(id, 'event ID');

    // Cache curto (30s) — invalida-se no update/delete. Reduz 39ms → ~3ms em hit.
    // Fail-open: se Redis off, cai pra query normal sem degradar.
    // Bypass quando há userId: organizadores recebem `registrationsCount` extra que
    // não pode vazar no cache compartilhado de anônimos.
    const cacheKey = this.eventCacheKeyById(id);
    if (!userId) {
      const cached = await this.cache.getJson<{ message: string; data: { event: Record<string, unknown> } }>(cacheKey);
      if (cached) return cached;
    }

    // Usar read replica para query de leitura
    const prismaRead = this.prisma.getReadClient();

    // Endpoint público: não traz email/phone do owner (vazamento desnecessário)
    // e usa selects granulares pra reduzir payload e CPU de hidratação.
    const event = await prismaRead.event.findUnique({
      where: { id },
      include: {
        organization: {
          include: {
            members: {
              where: { role: 'OWNER' },
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                  },
                },
              },
              take: 1,
            },
          },
        },
        topics: {
          where: { isEnabled: true },
          orderBy: { order: 'asc' },
        },
        questions: {
          orderBy: { order: 'asc' },
        },
      },
    });

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    // Se autenticado, verifica se é organizador (OWNER/EMPLOYEE da org com acesso
    // ao evento) ou admin. Em caso afirmativo, agrega `registrationsCount`.
    // Não lança em falha — a rota é pública.
    const isOrganizerCaller = userId
      ? await this.isOrganizerCallerForEvent(userId, (event as any).organizationId, id)
      : false;

    let registrationsCount: number | undefined;
    if (isOrganizerCaller) {
      registrationsCount = await prismaRead.registration.count({
        where: { eventId: id, status: RegistrationStatus.CONFIRMED },
      });
    }

    const eventPublic = this.stripPublicEventForSlug(
      event as unknown as Record<string, unknown>,
    );

    const response = {
      message: 'Event fetched successfully',
      data: {
        event:
          registrationsCount !== undefined
            ? { ...eventPublic, registrationsCount }
            : eventPublic,
      },
    };

    // Só cacheia a resposta anônima — versão organizadora carrega contagem dinâmica
    // (muda a cada inscrição) e não deve ser servida a outros consumidores.
    if (!isOrganizerCaller) {
      await this.cache.setJson(cacheKey, response, EventsService.EVENT_CACHE_TTL_SECONDS);
    }
    return response;
  }

  /**
   * True quando `userId` é admin (PODIOGO_STAFF/ADMIN) ou membro ativo da organização
   * do evento (OWNER, ou EMPLOYEE com acesso ao evento). Não lança — pensado para
   * decidir agregação opcional em rotas públicas.
   */
  private async isOrganizerCallerForEvent(
    userId: string,
    organizationId: string,
    eventId: string,
  ): Promise<boolean> {
    const prismaRead = this.prisma.getReadClient();
    const [user, member] = await Promise.all([
      prismaRead.user.findUnique({
        where: { id: userId },
        select: { role: true },
      }),
      prismaRead.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: {
          role: true,
          restrictedToEvents: true,
          eventAccesses: {
            where: { eventId },
            select: { eventId: true },
            take: 1,
          },
        },
      }),
    ]);

    if (user && (user.role === 'PODIOGO_STAFF' || user.role === 'ADMIN')) {
      return true;
    }
    if (!member) return false;
    if (member.role === 'OWNER') return true;
    if (member.role !== 'EMPLOYEE') return false;
    // EMPLOYEE: tem acesso explícito ao evento, ou não é restrito a eventos.
    if (member.eventAccesses.length > 0) return true;
    return !member.restrictedToEvents;
  }

  async findBySlug(slug: string) {
    if (!slug || slug.trim().length === 0) {
      throw new BadRequestException('Slug is required');
    }

    // Usar read replica para query de leitura
    const prismaRead = this.prisma.getReadClient();

    // Duas queries: evita o mesmo ingresso ser carregado duas vezes (raiz + por categoria),
    // o que gerava JOIN explosivo, resposta enorme e timeout ~10s no Nginx/proxy (502).
    const eventBase = await prismaRead.event.findUnique({
      where: { slug },
      include: {
        organization: {
          include: {
            members: {
              where: { role: 'OWNER' },
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    phone: true,
                  },
                },
              },
            },
          },
        },
        topics: {
          where: { isEnabled: true },
          orderBy: { order: 'asc' },
        },
        questions: {
          orderBy: { order: 'asc' },
        },
        ticketCategories: {
          orderBy: { order: 'asc' },
        },
        products: {
          include: {
            variations: {
              orderBy: { name: 'asc' },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!eventBase) {
      throw new NotFoundException('Evento não encontrado');
    }

    const tickets = await prismaRead.ticket.findMany({
      where: { eventId: eventBase.id, isActive: true },
      include: {
        batches: {
          orderBy: { price: 'asc' },
        },
        products: {
          orderBy: { sortOrder: 'asc' },
          include: {
            product: {
              include: {
                variations: true,
              },
            },
          },
        },
        category: true,
        kit: {
          include: {
            items: {
              include: {
                product: true,
              },
            },
          },
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const ticketSortCmp = (
      a: (typeof tickets)[0],
      b: (typeof tickets)[0],
    ): number =>
      a.sortOrder - b.sortOrder ||
      a.createdAt.getTime() - b.createdAt.getTime();

    const ticketCategories = eventBase.ticketCategories.map((cat) => ({
      ...cat,
      tickets: tickets
        .filter((t) => t.categoryId === cat.id)
        .sort(ticketSortCmp),
    }));

    const ticketsOrdered = [
      ...eventBase.ticketCategories.flatMap((cat) =>
        tickets
          .filter((t) => t.categoryId === cat.id)
          .sort(ticketSortCmp),
      ),
      ...tickets.filter((t) => !t.categoryId).sort(ticketSortCmp),
    ];

    const event = {
      ...eventBase,
      ticketCategories,
      tickets: ticketsOrdered,
    };

    const now = new Date();
    const eventDate = event.eventDate instanceof Date ? event.eventDate : new Date(event.eventDate);
    const eventToReturn = eventDate < now ? { ...event, status: EventStatus.COMPLETED } : event;

    const hasRegistrationSlotsAvailable =
      await this.computeHasRegistrationSlotsAvailable(
        prismaRead,
        eventToReturn.status,
        eventDate,
        eventToReturn.tickets,
      );


    const eventPublic = this.stripPublicEventForSlug(
      eventToReturn as unknown as Record<string, unknown>,
    );

    return {
      message: 'Event fetched successfully',
      data: {
        event: { ...eventPublic, hasRegistrationSlotsAvailable },
      },
    };
  }

  /**
   * Contagens agregadas de RegistrationTicket confirmados (uma query groupBy por conjunto de ingressos).
   */
  private async buildConfirmedRegistrationCounts(
    prismaRead: ReturnType<PrismaService['getReadClient']>,
    ticketIds: string[],
  ): Promise<{
    totalByTicket: Map<string, number>;
    soldWithBatchByTicket: Map<string, number>;
    soldByBatch: Map<string, number>;
  }> {
    const totalByTicket = new Map<string, number>();
    const soldWithBatchByTicket = new Map<string, number>();
    const soldByBatch = new Map<string, number>();

    if (ticketIds.length === 0) {
      return { totalByTicket, soldWithBatchByTicket, soldByBatch };
    }

    const groupRows = await prismaRead.registrationTicket.groupBy({
      by: ['ticketId', 'batchId'],
      where: {
        ticketId: { in: ticketIds },
        registration: { status: RegistrationStatus.CONFIRMED },
      },
      _count: { id: true },
    });

    for (const row of groupRows) {
      const c = row._count.id;
      const tid = row.ticketId;
      const bid = row.batchId;
      totalByTicket.set(tid, (totalByTicket.get(tid) ?? 0) + c);
      if (bid != null) {
        soldWithBatchByTicket.set(
          tid,
          (soldWithBatchByTicket.get(tid) ?? 0) + c,
        );
        soldByBatch.set(bid, (soldByBatch.get(bid) ?? 0) + c);
      }
    }

    return { totalByTicket, soldWithBatchByTicket, soldByBatch };
  }

  /**
   * Ingressos ativos + lotes + mapas de venda para uma página de eventos (2 queries no total).
   */
  private async loadRegistrationSlotCountMapsForTickets(
    prismaRead: ReturnType<PrismaService['getReadClient']>,
    eventIds: string[],
  ): Promise<{
    ticketsByEvent: Map<
      string,
      Array<{
        id: string;
        batches: Array<{
          id: string;
          quantity: number;
          startDate: Date | null;
          endDate: Date | null;
        }>;
      }>
    >;
    totalByTicket: Map<string, number>;
    soldWithBatchByTicket: Map<string, number>;
    soldByBatch: Map<string, number>;
  }> {
    const tickets = await prismaRead.ticket.findMany({
      where: { eventId: { in: eventIds }, isActive: true },
      include: { batches: true },
    });

    const ticketsByEvent = new Map<
      string,
      Array<{
        id: string;
        batches: Array<{
          id: string;
          quantity: number;
          startDate: Date | null;
          endDate: Date | null;
        }>;
      }>
    >();
    for (const t of tickets) {
      const arr = ticketsByEvent.get(t.eventId) ?? [];
      arr.push(t);
      ticketsByEvent.set(t.eventId, arr);
    }

    const ticketIds = tickets.map((t) => t.id);
    const counts = await this.buildConfirmedRegistrationCounts(
      prismaRead,
      ticketIds,
    );

    return {
      ticketsByEvent,
      totalByTicket: counts.totalByTicket,
      soldWithBatchByTicket: counts.soldWithBatchByTicket,
      soldByBatch: counts.soldByBatch,
    };
  }

  /**
   * Mesma regra do endpoint por slug, sem I/O (usa mapas pré-carregados).
   */
  private computeSlotsFromCounts(
    eventStatus: EventStatus,
    eventDate: Date,
    tickets: Array<{
      id: string;
      batches: Array<{
        id: string;
        quantity: number;
        startDate: Date | null;
        endDate: Date | null;
      }>;
    }>,
    totalByTicket: Map<string, number>,
    soldWithBatchByTicket: Map<string, number>,
    soldByBatch: Map<string, number>,
  ): boolean {
    if (
      eventStatus !== EventStatus.PUBLISHED &&
      eventStatus !== EventStatus.SUSPENDED
    ) {
      return false;
    }
    if (eventDate < new Date()) {
      return false;
    }
    if (!tickets?.length) {
      return false;
    }
    const now = new Date();
    for (const ticket of tickets) {
      if (!ticket.batches?.length) continue;
      const activeBatches = ticket.batches.filter(
        (b) =>
          (!b.startDate || new Date(b.startDate) <= now) &&
          (!b.endDate || new Date(b.endDate) >= now),
      );
      if (activeBatches.length === 0) continue;

      const capSum = activeBatches.reduce((sum, b) => sum + b.quantity, 0);

      const totalConfirmed = totalByTicket.get(ticket.id) ?? 0;

      if (totalConfirmed >= capSum) {
        continue;
      }

      const soldWithBatchId = soldWithBatchByTicket.get(ticket.id) ?? 0;

      if (soldWithBatchId === 0) {
        if (totalConfirmed < capSum) {
          return true;
        }
        continue;
      }

      for (const batch of activeBatches) {
        const soldBatch = soldByBatch.get(batch.id) ?? 0;
        if (batch.quantity > soldBatch) {
          return true;
        }
      }

      if (totalConfirmed < capSum) {
        return true;
      }
    }
    return false;
  }

  /**
   * Indica se ainda há capacidade (vaga) em algum ingresso ativo com lote no período vigente.
   * Inclui eventos SUSPENDED: reflete estoque real; a UI pode bloquear inscrição pelo status.
   * Usa uma única agregação groupBy em vez de N counts.
   */
  private async computeHasRegistrationSlotsAvailable(
    prismaRead: ReturnType<PrismaService['getReadClient']>,
    eventStatus: EventStatus,
    eventDate: Date,
    tickets: Array<{
      id: string;
      batches: Array<{
        id: string;
        quantity: number;
        startDate: Date | null;
        endDate: Date | null;
      }>;
    }>,
  ): Promise<boolean> {
    if (
      eventStatus !== EventStatus.PUBLISHED &&
      eventStatus !== EventStatus.SUSPENDED
    ) {
      return false;
    }
    if (eventDate < new Date()) {
      return false;
    }
    if (!tickets?.length) {
      return false;
    }
    const ticketIds = tickets.map((t) => t.id);
    const counts = await this.buildConfirmedRegistrationCounts(
      prismaRead,
      ticketIds,
    );
    return this.computeSlotsFromCounts(
      eventStatus,
      eventDate,
      tickets,
      counts.totalByTicket,
      counts.soldWithBatchByTicket,
      counts.soldByBatch,
    );
  }

  async update(
    userId: string,
    id: string,
    updateEventDto: UpdateEventDto,
    clientIp?: string | null,
  ) {
    this.validateUUID(id, 'event ID');
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const event = await prismaWrite.event.findUnique({
      where: { id },
    });

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    await this.organizerMemberAccess.assertCanAccessEvent(
      userId,
      id,
      'edit_event',
    );

    const {
      clientPage,
      cardImageUrl,
      kitSelectionDisplay: kitSelDto,
      ...patchFields
    } = updateEventDto;
    const updateData: Record<string, unknown> = { ...patchFields };
    // Status transitions are only allowed through dedicated action endpoints
    delete updateData['status'];
    for (const k of Object.keys(updateData)) {
      if (updateData[k] === undefined) {
        delete updateData[k];
      }
    }
    if (updateData.state !== undefined) {
      updateData.state = EventsService.normalizeState(updateData.state as string);
    }
    if (
      cardImageUrl !== undefined &&
      updateEventDto.logoUrl === undefined
    ) {
      updateData.logoUrl = cardImageUrl;
    }

    // Gerar slug se o nome ou slug foi alterado
    if (updateEventDto.name || updateEventDto.slug) {
      const nameForSlug = updateEventDto.name || event.name;
      const customSlug = updateEventDto.slug;
      updateData.slug = await this.generateEventSlug(
        nameForSlug,
        id, // eventId para extrair a segunda parte do UUID
        customSlug,
        id, // excludeEventId
      );
    }

    if (updateEventDto.eventDate) {
      updateData.eventDate = new Date(updateEventDto.eventDate);
    }
    if (updateEventDto.registrationStartDate) {
      updateData.registrationStartDate = new Date(
        updateEventDto.registrationStartDate,
      );
    }
    if (updateEventDto.registrationEndDate) {
      updateData.registrationEndDate = new Date(
        updateEventDto.registrationEndDate,
      );
    }

    if (kitSelDto !== undefined) {
      if (kitSelDto === null) {
        updateData.kitSelectionDisplay = null;
      } else {
        await this.assertKitSelectionDisplayConsistent(
          prismaRead,
          id,
          kitSelDto,
        );
        updateData.kitSelectionDisplay = kitSelDto;
      }
    }

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    const auditChanges = diffEventUpdateAgainstData(event, updateData);

    const updatedEvent = await prismaWrite.event.update({
      where: { id },
      data: updateData as Prisma.EventUpdateInput,
      include: {
        organization: {
          include: {
            members: {
              where: { role: 'OWNER' },
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                  },
                },
              },
              take: 1,
            },
          },
        },
      },
    });

    // Invalida cache (id + slug atual e antigo se houve mudança de slug).
    // fire-and-forget: cache miss é seguro (degrada pra query normal).
    const keysToInvalidate = [this.eventCacheKeyById(id), this.eventCacheKeyBySlug(updatedEvent.slug)];
    if (event.slug && event.slug !== updatedEvent.slug) {
      keysToInvalidate.push(this.eventCacheKeyBySlug(event.slug));
    }
    this.cache.del(keysToInvalidate).catch(() => undefined);

    await this.organizationsService.recordOrganizationAuditLog({
      organizationId: event.organizationId,
      actorUserId: userId,
      ip: clientIp ?? null,
      action: `Editou o evento "${updatedEvent.name}"`,
      metadata: {
        kind: 'EVENT_UPDATE',
        eventId: id,
        page: clientPage ?? 'event-edit',
        fieldsEdited: auditChanges.map((c) => c.field),
        changes: auditChanges,
      } as Prisma.InputJsonValue,
    });

    return {
      message: 'Event updated successfully',
      data: { event: updatedEvent },
    };
  }

  async remove(userId: string, id: string) {
    this.validateUUID(id, 'event ID');

    const prismaWrite = this.prisma.getWriteClient();

    const event = await prismaWrite.event.findUnique({
      where: { id },
    });

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    // Verificar se o usuário é OWNER da organização do evento
    const member = await prismaWrite.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: event.organizationId,
          userId,
        },
      },
    });

    if (!member || member.role !== 'OWNER') {
      throw new BadRequestException('Only the organization owner can delete events');
    }

    await prismaWrite.event.delete({
      where: { id },
    });

    this.cache.del([this.eventCacheKeyById(id), this.eventCacheKeyBySlug(event.slug)])
      .catch(() => undefined);

    return {
      message: 'Event deleted successfully',
    };
  }

  private eventToAdsTrackingPayload(row: {
    metaPixelId: string | null;
    googleAnalyticsId: string | null;
    googleAdsId: string | null;
  }) {
    return {
      metaPixelId: row.metaPixelId ?? '',
      googleAnalyticsId: row.googleAnalyticsId ?? '',
      googleAdsId: row.googleAdsId ?? '',
    };
  }

  /** Não expor IDs de ads/analytics em GET públicos do evento (slug / por id). */
  private stripPublicEventAdsTracking<E extends Record<string, unknown>>(event: E): E {
    const {
      metaPixelId: _mp,
      googleAnalyticsId: _ga,
      googleAdsId: _gad,
      ...rest
    } = event;
    return rest as E;
  }

  /**
   * Sanitiza o payload do evento para resposta pública por slug.
   * Além de remover IDs de tracking de anúncios, omite configurações financeiras
   * internas (taxas e retenção) que não devem ser expostas a consumidores públicos.
   */
  private stripPublicEventForSlug<E extends Record<string, unknown>>(event: E): E {
    const {
      metaPixelId: _mp,
      googleAnalyticsId: _ga,
      googleAdsId: _gad,
      organizerFeePercent: _ofp,
      participantFeePercent: _pfp,
      retentionRate: _rr,
      ...rest
    } = event;
    return rest as E;
  }

  async getAdsTracking(userId: string, eventId: string) {
    this.validateUUID(eventId, 'event ID');
    await this.organizerMemberAccess.assertCanAccessEvent(
      userId,
      eventId,
      'pixel',
    );

    const prismaRead = this.prisma.getReadClient();
    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        metaPixelId: true,
        googleAnalyticsId: true,
        googleAdsId: true,
      },
    });

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    return {
      data: {
        tracking: this.eventToAdsTrackingPayload(event),
      },
    };
  }

  async updateAdsTracking(
    userId: string,
    eventId: string,
    dto: UpdateEventAdsTrackingDto,
  ) {
    this.validateUUID(eventId, 'event ID');
    await this.organizerMemberAccess.assertCanAccessEvent(
      userId,
      eventId,
      'pixel',
    );

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const existing = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('Evento não encontrado');
    }

    const data: Prisma.EventUpdateInput = {};
    const toDb = (s: string | undefined) =>
      s === undefined ? undefined : s === '' ? null : s;

    if (dto.metaPixelId !== undefined) {
      data.metaPixelId = toDb(dto.metaPixelId);
    }
    if (dto.googleAnalyticsId !== undefined) {
      data.googleAnalyticsId = toDb(dto.googleAnalyticsId);
    }
    if (dto.googleAdsId !== undefined) {
      data.googleAdsId = toDb(dto.googleAdsId);
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    const updated = await prismaWrite.event.update({
      where: { id: eventId },
      data,
      select: {
        metaPixelId: true,
        googleAnalyticsId: true,
        googleAdsId: true,
      },
    });

    this.invalidateEventCacheById(eventId);

    return {
      message: 'Event tracking updated successfully',
      data: {
        tracking: this.eventToAdsTrackingPayload(updated),
      },
    };
  }

  // Event Topics
  async createTopic(
    userId: string,
    eventId: string,
    createTopicDto: CreateEventTopicDto,
  ) {
    await this.verifyOrganizerAccess(userId, eventId, 'edit_event');

    const prismaWrite = this.prisma.getWriteClient();

    const topic = await prismaWrite.eventTopic.create({
      data: {
        ...createTopicDto,
        eventId,
      },
    });

    return {
      message: 'Topic created successfully',
      data: { topic },
    };
  }

  async updateTopic(
    userId: string,
    eventId: string,
    topicId: string,
    updateTopicDto: UpdateEventTopicDto,
  ) {
    this.validateUUID(topicId, 'topic ID');
    await this.verifyOrganizerAccess(userId, eventId, 'edit_event');

    const prismaWrite = this.prisma.getWriteClient();

    const topic = await prismaWrite.eventTopic.findUnique({
      where: { id: topicId },
    });

    if (!topic || topic.eventId !== eventId) {
      throw new NotFoundException('Topic not found');
    }

    const updatedTopic = await prismaWrite.eventTopic.update({
      where: { id: topicId },
      data: updateTopicDto,
    });

    return {
      message: 'Topic updated successfully',
      data: { topic: updatedTopic },
    };
  }

  async reorderTopics(
    userId: string,
    eventId: string,
    dto: ReorderEventTopicsDto,
  ) {
    this.validateUUID(eventId, 'event ID');
    await this.verifyOrganizerAccess(userId, eventId, 'edit_event');

    const prismaWrite = this.prisma.getWriteClient();

    const existing = await prismaWrite.eventTopic.findMany({
      where: { eventId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((t) => t.id));
    const incoming = dto.topicIds;

    if (incoming.length !== existingIds.size) {
      throw new BadRequestException(
        'topicIds must list every event topic exactly once (same length as current topics)',
      );
    }
    if (new Set(incoming).size !== incoming.length) {
      throw new BadRequestException('topicIds must not contain duplicates');
    }
    for (const id of incoming) {
      if (!existingIds.has(id)) {
        throw new BadRequestException(
          `Topic ${id} does not belong to this event`,
        );
      }
    }

    await prismaWrite.$transaction(
      incoming.map((id, order) =>
        prismaWrite.eventTopic.update({
          where: { id },
          data: { order },
        }),
      ),
    );

    const topics = await prismaWrite.eventTopic.findMany({
      where: { eventId },
      orderBy: { order: 'asc' },
    });

    return {
      message: 'Topics reordered successfully',
      data: { topics },
    };
  }

  async deleteTopic(userId: string, eventId: string, topicId: string) {
    this.validateUUID(topicId, 'topic ID');
    await this.verifyOrganizerAccess(userId, eventId, 'edit_event');

    const prismaWrite = this.prisma.getWriteClient();

    const topic = await prismaWrite.eventTopic.findUnique({
      where: { id: topicId },
    });

    if (!topic || topic.eventId !== eventId) {
      throw new NotFoundException('Topic not found');
    }

    if (topic.isDefault) {
      throw new BadRequestException(
        'Cannot delete default topics. Disable them instead.',
      );
    }

    await prismaWrite.eventTopic.delete({
      where: { id: topicId },
    });

    return {
      message: 'Topic deleted successfully',
    };
  }

  // Event Locations
  async createLocation(
    userId: string,
    eventId: string,
    createLocationDto: CreateEventLocationDto,
  ) {
    await this.verifyOrganizerAccess(userId, eventId, 'edit_event');

    const prismaWrite = this.prisma.getWriteClient();

    const location = await prismaWrite.eventLocation.create({
      data: {
        ...createLocationDto,
        eventId,
      },
    });

    return {
      message: 'Location created successfully',
      data: { location },
    };
  }

  async updateLocation(
    userId: string,
    eventId: string,
    locationId: string,
    updateLocationDto: CreateEventLocationDto,
  ) {
    this.validateUUID(locationId, 'location ID');
    await this.verifyOrganizerAccess(userId, eventId, 'edit_event');

    const prismaWrite = this.prisma.getWriteClient();

    const location = await prismaWrite.eventLocation.findUnique({
      where: { id: locationId },
    });

    if (!location || location.eventId !== eventId) {
      throw new NotFoundException('Location not found');
    }

    const updatedLocation = await prismaWrite.eventLocation.update({
      where: { id: locationId },
      data: updateLocationDto,
    });

    return {
      message: 'Location updated successfully',
      data: { location: updatedLocation },
    };
  }

  async deleteLocation(userId: string, eventId: string, locationId: string) {
    this.validateUUID(locationId, 'location ID');
    await this.verifyOrganizerAccess(userId, eventId, 'edit_event');

    const prismaWrite = this.prisma.getWriteClient();

    const location = await prismaWrite.eventLocation.findUnique({
      where: { id: locationId },
    });

    if (!location || location.eventId !== eventId) {
      throw new NotFoundException('Location not found');
    }

    await prismaWrite.eventLocation.delete({
      where: { id: locationId },
    });

    return {
      message: 'Location deleted successfully',
    };
  }

  private async verifyOrganizerAccess(
    userId: string,
    eventId: string,
    requiredPermission: OrganizerPermissionKey,
  ) {
    this.validateUUID(eventId, 'event ID');
    await this.organizerMemberAccess.assertCanAccessEvent(
      userId,
      eventId,
      requiredPermission,
    );
  }

  private buildFinancialSettingsPayload(event: any) {
    return {
      eventId: event.id,
      organizerFeePercent: event.organizerFeePercent ?? 0,
      participantFeePercent: event.participantFeePercent ?? 0,
      maxInstallments: event.maxInstallments ?? 1,
      acceptedPaymentMethods: ['PIX', 'DEBIT_CARD', 'CREDIT_CARD'],
      lockedAt: event.financialSettingsLockedAt ?? null,
    };
  }

  private financialSettingsSelect() {
    return {
      id: true,
      organizerFeePercent: true,
      participantFeePercent: true,
      maxInstallments: true,
      financialSettingsLockedAt: true,
    } as const;
  }

  async getFinancialSettings(userId: string, eventId: string) {
    await this.verifyOrganizerAccess(userId, eventId, 'edit_event');

    const event = await this.prisma.getReadClient().event.findUnique({
      where: { id: eventId },
      select: this.financialSettingsSelect(),
    });

    if (!event) throw new NotFoundException('Evento não encontrado');

    return { data: this.buildFinancialSettingsPayload(event) };
  }

  async updateFinancialSettings(
    userId: string,
    eventId: string,
    dto: { organizerFeePercent: number; participantFeePercent: number; maxInstallments: number },
    opts: { bypassLock?: boolean } = {},
  ) {
    await this.verifyOrganizerAccess(userId, eventId, 'edit_event');

    const prismaWrite = this.prisma.getWriteClient();

    const data = {
      organizerFeePercent: dto.organizerFeePercent,
      participantFeePercent: dto.participantFeePercent,
      maxInstallments: dto.maxInstallments,
    };

    if (opts.bypassLock) {
      const event = await prismaWrite.event.findUnique({ where: { id: eventId }, select: { id: true } });
      if (!event) throw new NotFoundException('Evento não encontrado');
      await prismaWrite.event.update({ where: { id: eventId }, data });
    } else {
      // Atualização atômica: updateMany guardado por financialSettingsLockedAt IS NULL
      // garante que se publish() rodar em paralelo e travar primeiro, este UPDATE retorna
      // 0 linhas e abortamos. Substitui o padrão read-then-write que tinha race condition.
      const result = await prismaWrite.event.updateMany({
        where: { id: eventId, financialSettingsLockedAt: null },
        data,
      });

      if (result.count === 0) {
        const exists = await prismaWrite.event.findUnique({
          where: { id: eventId },
          select: { id: true, financialSettingsLockedAt: true },
        });
        if (!exists) throw new NotFoundException('Evento não encontrado');
        throw new ConflictException({
          error: 'FINANCIAL_SETTINGS_LOCKED',
          message: 'As configurações financeiras não podem ser alteradas após a publicação do evento.',
        });
      }
    }

    const updated = await prismaWrite.event.findUnique({
      where: { id: eventId },
      select: this.financialSettingsSelect(),
    });

    return { data: this.buildFinancialSettingsPayload(updated) };
  }

  async publish(userId: string, eventId: string) {
    await this.verifyOrganizerAccess(userId, eventId, 'edit_event');

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
      include: {
        tickets: { where: { isActive: true }, select: { id: true } },
      },
    });

    if (!event) throw new NotFoundException('Evento não encontrado');

    if (event.status !== EventStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT events can be submitted for review');
    }

    if (event.tickets.length === 0) {
      throw new BadRequestException('Event must have at least one active ticket before submitting for review');
    }

    if (!event.eventDate || new Date(event.eventDate) < new Date()) {
      throw new BadRequestException('Event date must be in the future');
    }

    if (!event.location || !event.city || !event.state || !event.country) {
      throw new BadRequestException('Event must have complete location information before submitting for review');
    }

    const submittedAt = new Date();
    const updatedEvent = await prismaWrite.event.update({
      where: { id: eventId },
      data: {
        status: EventStatus.REVISION,
        financialSettingsLockedAt: new Date(),
      },
    });

    this.invalidateEventCacheById(eventId);

    // Buscar e-mail e nome do organizador para notificação
    const organizer = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true },
    });

    if (organizer?.email) {
      const weekdays = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
      const eventDt = new Date(event.eventDate);
      const eventDateFormatted = `${eventDt.toLocaleDateString('pt-BR')} · ${weekdays[eventDt.getDay()]}`;
      const submittedHH = String(submittedAt.getHours()).padStart(2, '0');
      const submittedMM = String(submittedAt.getMinutes()).padStart(2, '0');
      const submittedAtFormatted = `${submittedAt.toLocaleDateString('pt-BR')} · ${submittedHH}h${submittedMM}`;
      const eventLocation = [event.location, event.city].filter(Boolean).join(', ');

      this.emailService
        .sendEventUnderReview({
          recipientEmail: organizer.email,
          eventName: event.name,
          eventBannerUrl: event.bannerUrl ?? '',
          eventDate: eventDateFormatted,
          eventLocation,
          submittedAt: submittedAtFormatted,
        })
        .catch((err) =>
          this.logger.warn(`Falha ao enviar email de evento em análise (eventId=${eventId}): ${err?.message ?? err}`),
        );
    }

    return {
      message: 'Event submitted for review successfully',
      data: { event: updatedEvent },
    };
  }

  /**
   * Suspende o evento (some da vitrine pública e bloqueia novas inscrições).
   * Apenas eventos PUBLISHED podem ser suspensos.
   */
  async suspend(userId: string, eventId: string) {
    await this.verifyOrganizerAccess(userId, eventId, 'edit_event');

    const prismaWrite = this.prisma.getWriteClient();
    const event = await prismaWrite.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    if (event.status !== EventStatus.PUBLISHED) {
      throw new BadRequestException(
        'Somente eventos publicados podem ser suspensos',
      );
    }

    const updatedEvent = await prismaWrite.event.update({
      where: { id: eventId },
      data: { status: EventStatus.SUSPENDED },
    });

    this.invalidateEventCacheById(eventId);

    return {
      message: 'Evento suspenso com sucesso',
      data: { event: updatedEvent },
    };
  }

  /**
   * Volta o evento para publicado após suspensão (reaparece na vitrine).
   */
  async resumePublished(userId: string, eventId: string) {
    await this.verifyOrganizerAccess(userId, eventId, 'edit_event');

    const prismaWrite = this.prisma.getWriteClient();
    const event = await prismaWrite.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    if (event.status !== EventStatus.SUSPENDED) {
      throw new BadRequestException(
        'Somente eventos suspensos podem ser reativados desta forma',
      );
    }

    const updatedEvent = await prismaWrite.event.update({
      where: { id: eventId },
      data: { status: EventStatus.PUBLISHED },
    });

    this.invalidateEventCacheById(eventId);

    return {
      message: 'Evento reativado com sucesso',
      data: { event: updatedEvent },
    };
  }

  async getStats(userId: string, eventId: string) {
    await this.verifyOrganizerAccess(userId, eventId, 'dashboard');

    const prismaRead = this.prisma.getReadClient();

    const [registrations, modalities] = await Promise.all([
      prismaRead.registration.findMany({
        where: { eventId },
        include: {
          order: {
            include: {
              payment: true,
            },
          },
          modalities: true,
        },
      }),
      prismaRead.modality.findMany({
        where: { eventId, isActive: true },
      }),
    ]);

    const totalRegistrations = registrations.length;
    const confirmedRegistrations = registrations.filter((r) => r.status === 'CONFIRMED').length;
    const totalRevenue = registrations
      .filter((r) => r.order?.payment && r.order.payment.status === 'PAID')
      .reduce((sum, r) => sum + this.normalizeToCents(r.order?.finalAmount), 0);

    const ticketsSold = registrations.reduce((sum, r) => {
      return sum + (r.modalities?.length || 0);
    }, 0);

    const ticketsAvailable = modalities.reduce((sum, m) => {
      return sum + (m.maxParticipants || 0) - m.currentParticipants;
    }, 0);

    return {
      message: 'Event statistics retrieved successfully',
      data: {
        totalRegistrations,
        confirmedRegistrations,
        totalRevenue,
        ticketsSold,
        ticketsAvailable,
      },
    };
  }

  async getRevenue(userId: string, eventId: string) {
    await this.verifyOrganizerAccess(userId, eventId, 'financial');

    const prismaRead = this.prisma.getReadClient();

    const [eventConfig, registrations] = await Promise.all([
      prismaRead.event.findUnique({
        where: { id: eventId },
        select: { organizerFeePercent: true },
      }),
      prismaRead.registration.findMany({
        where: {
          eventId,
          order: {
            payment: {
              status: 'PAID',
            },
          },
        },
        include: {
          order: {
            include: {
              payment: true,
            },
          },
          modalities: {
            include: {
              modality: true,
            },
          },
        },
      }),
    ]);

    const organizerFeeRate: number = (eventConfig?.organizerFeePercent ?? 0) / 100;

    // Deduplicate orders and apply organizer fee deduction
    // serviceFee é da plataforma (100%) — sai antes de aplicar organizerFeePercent.
    const seenOrders = new Set<string>();
    let total = 0;
    for (const r of registrations) {
      if (r.order?.id && !seenOrders.has(r.order.id)) {
        seenOrders.add(r.order.id);
        const orgBase = Math.max(
          0,
          (r.order.finalAmount ?? 0) - (r.order.serviceFee ?? 0),
        );
        total += Math.round(orgBase * (1 - organizerFeeRate));
      }
    }

    // Agrupar por modalidade
    const breakdownMap = new Map<string, { ticketId: string; ticketName: string; revenue: number; quantity: number }>();

    registrations.forEach((registration) => {
      registration.modalities.forEach((rm) => {
        const modalityId = rm.modalityId;
        const modality = rm.modality;

        if (!breakdownMap.has(modalityId)) {
          breakdownMap.set(modalityId, {
            ticketId: modalityId,
            ticketName: modality.name,
            revenue: 0,
            quantity: 0,
          });
        }

        const entry = breakdownMap.get(modalityId)!;
        // Estimativa por modalidade: preço cadastrado × (1 − organizerFeePercent/100).
        // Aqui não há serviceFee para deduzir (preço da modalidade é só do ingresso).
        const modalityPrice = Math.round((modality.price ?? 0) * (1 - organizerFeeRate));
        entry.revenue += modalityPrice;
        entry.quantity += 1;
      });
    });

    const breakdown = Array.from(breakdownMap.values());

    return {
      message: 'Event revenue retrieved successfully',
      data: {
        total,
        breakdown,
      },
    };
  }

  /**
   * Obtém dados do dashboard do evento
   */
  async getDashboard(userId: string, eventId: string, queryDto: DashboardQueryDto) {
    await this.verifyOrganizerAccess(userId, eventId, 'dashboard');

    const prismaRead = this.prisma.getReadClient();
    const { period = DashboardPeriod.GERAL, ticketIds, page = 1, limit = 10 } = queryDto;

    // Calcular range de datas baseado no período
    const dateRange = this.calculateDateRange(period);
    const now = new Date();

    // Construir filtro de data para order
    const orderDateFilter: any = {};
    if (dateRange.start) {
      orderDateFilter.gte = dateRange.start;
    }
    if (dateRange.end) {
      orderDateFilter.lte = dateRange.end;
    }

    // Query base para registrations
    // Exclui registrations PENDING (placeholders de reserva ainda não pagas)
    const registrationWhere: any = {
      eventId,
      status: { not: RegistrationStatus.PENDING },
    };

    // Aplicar filtro de data no order se houver
    if (Object.keys(orderDateFilter).length > 0) {
      registrationWhere.order = {
        createdAt: orderDateFilter,
      };
    }

    // Filtrar por ticketIds se fornecido
    if (ticketIds && ticketIds.length > 0) {
      registrationWhere.tickets = {
        some: {
          ticketId: { in: ticketIds },
        },
      };
    }

    // Buscar evento (para taxa do organizador) e registrations em paralelo
    const [eventConfig, registrations] = await Promise.all([
      prismaRead.event.findUnique({
        where: { id: eventId },
        select: { organizerFeePercent: true },
      }),
      prismaRead.registration.findMany({
        where: registrationWhere,
        include: {
          order: {
            include: {
              payment: true,
            },
          },
          modalities: {
            include: {
              modality: true,
            },
          },
          tickets: {
            include: {
              ticket: {
                include: {
                  category: {
                    select: {
                      id: true,
                      name: true,
                    },
                  },
                },
              },
            },
          },
          user: {
            select: {
              id: true,
              city: true,
              state: true,
            },
          },
        },
      }),
    ]);

    const organizerFeeRate: number = (eventConfig?.organizerFeePercent ?? 0) / 100;

    // Calcular métricas principais
    const paidRegistrations = registrations.filter(
      (r) => r.order?.payment && r.order.payment.status === PaymentStatus.PAID && r.status === RegistrationStatus.CONFIRMED,
    );
    const cancelledRegistrations = registrations.filter((r) => r.status === RegistrationStatus.CANCELLED);
    const refundedRegistrations = registrations.filter((r) => r.order?.payment?.status === PaymentStatus.REFUNDED);

    // Deduplicate by order; apply organizer fee deduction to get net revenue (what organizer receives).
    // serviceFee é da plataforma (100%), sai do gross antes de aplicar a taxa do organizador.
    const uniquePaidOrderAmounts = new Map<string, number>();
    for (const r of paidRegistrations) {
      if (r.order?.id && !uniquePaidOrderAmounts.has(r.order.id)) {
        const gross = this.normalizeToCents(r.order.finalAmount);
        const fee = this.normalizeToCents(r.order.serviceFee ?? 0);
        const orgBase = Math.max(0, gross - fee);
        const net = Math.round(orgBase * (1 - organizerFeeRate));
        uniquePaidOrderAmounts.set(r.order.id, net);
      }
    }
    const netRevenue = Array.from(uniquePaidOrderAmounts.values()).reduce((sum, v) => sum + v, 0);

    const totalRegistrations = paidRegistrations.length; // confirmed + paid only
    const cancellations = cancelledRegistrations.length;
    const refunds = refundedRegistrations.length;

    // Calcular ticket médio (valores já estão em centavos)
    const averageTicket = uniquePaidOrderAmounts.size > 0 ? netRevenue / uniquePaidOrderAmounts.size : 0;

    // Comparar com o período anterior equivalente
    const comparisonBounds = this.getDashboardComparisonBounds(dateRange, now, period);
    let previousRegistrations: any[] = [];
    if (comparisonBounds) {
      const previousWhere: any = {
        eventId,
        status: { not: RegistrationStatus.PENDING },
        order: {
          createdAt: {
            gte: comparisonBounds.prevStart,
            lt: comparisonBounds.prevEndExclusive,
          },
        },
      };
      if (ticketIds && ticketIds.length > 0) {
        previousWhere.tickets = {
          some: { ticketId: { in: ticketIds } },
        };
      }
      previousRegistrations = await prismaRead.registration.findMany({
        where: previousWhere,
        include: { order: { include: { payment: true } } },
      });
    }

    const previousPaid = previousRegistrations.filter(
      (r) =>
        r.order?.payment &&
        r.order.payment.status === PaymentStatus.PAID &&
        r.status === RegistrationStatus.CONFIRMED,
    );
    const previousUniquePaidOrders = new Map<string, number>();
    for (const r of previousPaid) {
      if (r.order?.id && !previousUniquePaidOrders.has(r.order.id)) {
        const gross = this.normalizeToCents(r.order.finalAmount);
        const fee = this.normalizeToCents(r.order.serviceFee ?? 0);
        const orgBase = Math.max(0, gross - fee);
        previousUniquePaidOrders.set(r.order.id, Math.round(orgBase * (1 - organizerFeeRate)));
      }
    }
    const previousNetRevenue = Array.from(previousUniquePaidOrders.values()).reduce((sum, v) => sum + v, 0);
    const previousTotalRegistrations = previousPaid.length; // confirmed + paid only
    const previousAverageTicket =
      previousUniquePaidOrders.size > 0 ? previousNetRevenue / previousUniquePaidOrders.size : 0;

    const netRevenueChange = comparisonBounds
      ? this.percentChangeVsPrevious(netRevenue, previousNetRevenue)
      : 0;
    const totalRegistrationsChange = comparisonBounds
      ? this.percentChangeVsPrevious(totalRegistrations, previousTotalRegistrations)
      : 0;
    const averageTicketChange = comparisonBounds
      ? this.percentChangeVsPrevious(averageTicket, previousAverageTicket)
      : 0;
    const totalFinalized = totalRegistrations + cancellations;
    const cancellationRate = totalFinalized > 0 ? (cancellations / totalFinalized) * 100 : 0;
    const cancellationsStatus = cancellationRate > 10 ? 'Crítico' : cancellationRate > 5 ? 'Atenção' : 'Normal';
    const refundRate = totalFinalized > 0 ? (refunds / totalFinalized) * 100 : 0;
    const refundsStatus = refundRate > 5 ? 'Crítico' : refundRate > 2 ? 'Atenção' : 'Normal';
    const chartData = this.buildChartData(registrations, dateRange, period);
    const ticketRanking = this.buildTicketRanking(registrations, page, limit);
    const topCities = this.buildTopCities(registrations);
    const lotsNearDepletion = await this.buildLotsNearDepletion(prismaRead, eventId);
    const salesHeatmap = this.buildSalesHeatmap(registrations);
    const paidRegistrationIds = paidRegistrations.map((r) => r.id);
    const topProductVariations = await this.buildTopProductVariations(prismaRead, eventId, paidRegistrationIds);
    const mostAnsweredQuestions = await this.buildMostAnsweredQuestions(prismaRead, eventId);

    const ticketMapForPagination = new Map<string, boolean>();
    paidRegistrations.forEach((reg) => {
      if (reg.tickets && reg.tickets.length > 0) {
        reg.tickets.forEach((rt: any) => {
          ticketMapForPagination.set(rt.ticket.id, true);
        });
      } else if (reg.modalities && reg.modalities.length > 0) {
        reg.modalities.forEach((rm: any) => {
          ticketMapForPagination.set(rm.modality.id, true);
        });
      }
    });
    const totalTicketsInRanking = ticketMapForPagination.size;

    return {
      message: 'Dashboard data fetched successfully',
      data: {
        period: {
          selected: period,
          startDate: dateRange.start?.toISOString() || null,
          endDate: dateRange.end?.toISOString() || null,
        },
        metrics: {
          netRevenue,
          netRevenueChange,
          averageTicket,
          averageTicketChange,
          totalRegistrations,
          totalRegistrationsChange,
          cancellations,
          cancellationsStatus,
          refunds,
          refundsStatus,
        },
        registrationsTrend: {
          amount: netRevenue, // Valores já estão em centavos no banco
          change: netRevenueChange,
          confirmed: paidRegistrations.length,
          canceled: cancellations,
          refunded: refunds,
          chartData,
        },
        ticketRanking: {
          data: ticketRanking,
          pagination: {
            page,
            limit,
            total: totalTicketsInRanking,
            totalPages: Math.ceil(totalTicketsInRanking / limit),
          },
        },
        topCities,
        lotsNearDepletion,
        salesHeatmap,
        topProductVariations,
        mostAnsweredQuestions,
      },
    };
  }

  /**
   * Variações mais vendidas de cada produto do evento (inscrições confirmadas e pagas).
   * Inclui todas as variações cadastradas do produto (com 0 vendas se não houver) e uma linha "Sem variação" quando existir venda sem variação escolhida.
   */
  private async buildTopProductVariations(
    prismaRead: ReturnType<PrismaService['getReadClient']>,
    eventId: string,
    paidRegistrationIds: string[],
  ) {
    if (paidRegistrationIds.length === 0) {
      return [];
    }
    const rows = await prismaRead.registrationProduct.findMany({
      where: { registrationId: { in: paidRegistrationIds } },
      select: {
        productId: true,
        variationId: true,
        quantity: true,
        totalPrice: true,
        product: { select: { id: true, name: true, image: true } },
        variation: { select: { id: true, name: true, stock: true } },
      },
    });

    const salesByProduct = new Map<string, {
      productId: string;
      productName: string;
      productImage: string | null;
      totalSoldAmount: number;
      byVariation: Map<string | null, { quantitySold: number; stock: number | null }>;
    }>();

    for (const r of rows) {
      const key = r.productId;
      if (!salesByProduct.has(key)) {
        salesByProduct.set(key, {
          productId: r.product.id,
          productName: r.product.name,
          productImage: r.product.image ?? null,
          totalSoldAmount: 0,
          byVariation: new Map(),
        });
      }
      const entry = salesByProduct.get(key)!;
      entry.totalSoldAmount += r.totalPrice ?? 0;
      const variationId = r.variationId ?? null;
      const stock = r.variation?.stock ?? null;
      const stockVal = stock !== null && stock !== undefined ? stock : null;
      const existing = entry.byVariation.get(variationId);
      if (existing) {
        existing.quantitySold += r.quantity;
      } else {
        entry.byVariation.set(variationId, {
          quantitySold: r.quantity,
          stock: stockVal,
        });
      }
    }

    // Desduplicar productIds (o Map garante unicidade, mas defensivo contra edge cases)
    const productIds = [...new Set(Array.from(salesByProduct.keys()).filter(Boolean))];

    if (productIds.length === 0) return [];

    const productsWithVariations = await prismaRead.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        name: true,
        image: true,
        variations: { select: { id: true, name: true, stock: true }, orderBy: { name: 'asc' } },
      },
    });

    // Desduplicar por id antes de mapear (defesa contra retornos inesperados do ORM)
    const seenProductIds = new Set<string>();
    const uniqueProducts = productsWithVariations.filter((p) => {
      if (seenProductIds.has(p.id)) return false;
      seenProductIds.add(p.id);
      return true;
    });

    const result = uniqueProducts.map((product) => {
      const sales = salesByProduct.get(product.id);
      if (!sales) return null;
      const totalSold = Array.from(sales.byVariation.values()).reduce((sum, v) => sum + v.quantitySold, 0);

      const variationRows: {
        variationId: string | null;
        variationName: string;
        quantitySold: number;
        percentage: number;
        remainingStock: number | null;
        totalStock: number | null;
      }[] = [];

      for (const v of product.variations) {
        const sold = sales.byVariation.get(v.id);
        const quantitySold = sold?.quantitySold ?? 0;
        const percentage = totalSold > 0 ? Math.round((quantitySold / totalSold) * 10000) / 100 : 0;
        const isUnlimited = v.stock === null || v.stock === 0;
        const remainingStock = isUnlimited ? null : v.stock;
        const totalStock = isUnlimited ? null : v.stock + quantitySold;
        variationRows.push({
          variationId: v.id,
          variationName: v.name,
          quantitySold,
          percentage,
          remainingStock,
          totalStock,
        });
      }

      const noVariationSales = sales.byVariation.get(null);
      if (noVariationSales && noVariationSales.quantitySold > 0) {
        const quantitySold = noVariationSales.quantitySold;
        const percentage = totalSold > 0 ? Math.round((quantitySold / totalSold) * 10000) / 100 : 0;
        variationRows.push({
          variationId: null,
          variationName: 'Sem variação',
          quantitySold,
          percentage,
          remainingStock: null,
          totalStock: null,
        });
      }

      variationRows.sort((a, b) => b.quantitySold - a.quantitySold);

      return {
        productId: product.id,
        productName: product.name,
        productImage: product.image ?? null,
        totalQuantitySold: totalSold,
        totalSoldAmount: sales.totalSoldAmount,
        variations: variationRows,
      };
    });

    return result
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.totalQuantitySold - a.totalQuantitySold);
  }

  /**
   * Normaliza uma resposta de questionário para agrupamento consistente.
   * Retorna um array de valores (checkbox pode ter múltiplas seleções).
   */
  private normalizeQuestionAnswer(raw: unknown, type: string): string[] {
    const str = (raw ?? '').toString().trim();
    if (str === '') return ['(vazio)'];

    // Tentar parsear JSON array (respostas de checkbox ou select armazenadas como array)
    if (str.startsWith('[')) {
      try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed)) {
          const items = parsed.map((v: unknown) => String(v).trim()).filter(Boolean);
          return items.length > 0 ? items : ['(vazio)'];
        }
      } catch {
        // não é JSON válido, tratar como string normal
      }
    }

    // Normalizar booleanos para true_false
    if (type === 'true_false') {
      if (str === 'true' || str === '1') return ['Verdadeiro'];
      if (str === 'false' || str === '0') return ['Falso'];
    }

    return [str];
  }

  /**
   * Perguntas mais respondidas do evento, com ranking de respostas, % por opção e tipo.
   */
  private async buildMostAnsweredQuestions(
    prismaRead: ReturnType<PrismaService['getReadClient']>,
    eventId: string,
  ) {
    const answers = await prismaRead.questionAnswer.findMany({
      where: { registration: { eventId } },
      select: {
        questionId: true,
        answer: true,
        registrationId: true,
        question: {
          select: { id: true, question: true, order: true, type: true, options: true, isRequired: true },
        },
      },
    });
    if (answers.length === 0) return [];

    const byQuestion = new Map<string, {
      questionId: string;
      question: string;
      order: number;
      type: string;
      options: unknown;
      isRequired: boolean;
      participantCount: number;
      answersByValue: Map<string, number>;
    }>();

    for (const a of answers) {
      const q = a.question;
      if (!q) continue;
      const key = q.id;
      if (!byQuestion.has(key)) {
        byQuestion.set(key, {
          questionId: q.id,
          question: q.question,
          order: q.order,
          type: q.type ?? 'text',
          options: q.options ?? null,
          isRequired: q.isRequired ?? false,
          participantCount: 0,
          answersByValue: new Map(),
        });
      }
      const entry = byQuestion.get(key)!;
      entry.participantCount += 1;
      const normalized = this.normalizeQuestionAnswer(a.answer, entry.type);
      for (const val of normalized) {
        entry.answersByValue.set(val, (entry.answersByValue.get(val) ?? 0) + 1);
      }
    }

    const result = Array.from(byQuestion.values()).map((entry) => {
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
    });

    return result.sort((a, b) => b.participantCount - a.participantCount);
  }

  /**
   * Respostas individuais de uma pergunta de texto livre, com dados do participante.
   * Chamado apenas ao abrir o detalhe da pergunta — não incluso no dashboard geral.
   */
  async getQuestionTextAnswers(
    organizerId: string,
    eventId: string,
    questionId: string,
  ) {
    const prismaRead = this.prisma.getReadClient();

    // Verificar acesso ao evento via sistema de permissões da organização
    await this.verifyOrganizerAccess(organizerId, eventId, 'dashboard');

    const answers = await prismaRead.questionAnswer.findMany({
      where: { questionId, registration: { eventId } },
      select: {
        id: true,
        answer: true,
        createdAt: true,
        registration: {
          select: {
            participantName: true,
            participantEmail: true,
            user: {
              select: { firstName: true, lastName: true, email: true, avatarUrl: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      answers: answers.map((a) => {
        const reg = a.registration;
        const userName = reg?.user
          ? `${reg.user.firstName} ${reg.user.lastName}`.trim()
          : (reg?.participantName ?? null);
        const userEmail = reg?.user?.email ?? reg?.participantEmail ?? null;
        const userAvatarUrl = reg?.user?.avatarUrl ?? null;
        return {
          id: a.id,
          userName,
          userEmail,
          userAvatarUrl,
          answer: a.answer,
          answeredAt: a.createdAt.toISOString(),
        };
      }),
    };
  }

  /**
   * Variação % vs período de referência: (atual − anterior) / anterior × 100.
   * Quando o anterior é 0 e o atual > 0, retorna 100 (subida a partir de zero).
   */
  private percentChangeVsPrevious(current: number, previous: number): number {
    if (previous === 0 && current === 0) return 0;
    if (previous === 0) return current > 0 ? 100 : 0;
    const raw = ((current - previous) / previous) * 100;
    return Math.round(raw * 100) / 100;
  }

  /**
   * Intervalo do período anterior para cálculo de variação (%).
   * - GERAL: sem comparação — retorna null.
   * - LAST_24H/7D/15D/2M: janela de mesma duração imediatamente anterior ao período atual.
   * - LAST_1M: mês calendário anterior completo.
   */
  private getDashboardComparisonBounds(
    dateRange: { start: Date | null; end: Date | null },
    now: Date,
    period: DashboardPeriod,
  ): { prevStart: Date; prevEndExclusive: Date } | null {
    if (period === DashboardPeriod.GERAL) return null;

    if (period === DashboardPeriod.LAST_1M) {
      // Mês calendário anterior: 1º dia do mês passado → 1º dia do mês atual
      const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevEndExclusive = new Date(now.getFullYear(), now.getMonth(), 1);
      return { prevStart, prevEndExclusive };
    }

    // Demais períodos: mesma duração imediatamente antes do período atual
    if (dateRange.start && dateRange.end) {
      const durationMs = dateRange.end.getTime() - dateRange.start.getTime();
      const prevStart = new Date(dateRange.start.getTime() - durationMs);
      const prevEndExclusive = new Date(dateRange.start.getTime());
      return { prevStart, prevEndExclusive };
    }

    return null;
  }

  /**
   * Calcula o range de datas baseado no período
   */
  private calculateDateRange(period: DashboardPeriod): { start: Date | null; end: Date | null } {
    const now = new Date();
    const start = new Date();
    const end = new Date();

    switch (period) {
      case DashboardPeriod.LAST_24H:
        start.setHours(now.getHours() - 24);
        return { start, end: now };
      case DashboardPeriod.LAST_7D:
        start.setDate(now.getDate() - 7);
        return { start, end: now };
      case DashboardPeriod.LAST_15D:
        start.setDate(now.getDate() - 15);
        return { start, end: now };
      case DashboardPeriod.LAST_1M:
        start.setMonth(now.getMonth() - 1);
        return { start, end: now };
      case DashboardPeriod.LAST_2M:
        start.setMonth(now.getMonth() - 2);
        return { start, end: now };
      case DashboardPeriod.GERAL:
      default:
        return { start: null, end: null };
    }
  }

  /** Chaves UTC `YYYY-MM-DD` de cada dia no intervalo [from, to] (inclusive). */
  private eachUtcDayKeys(from: Date, to: Date): string[] {
    const keys: string[] = [];
    let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    const endT = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
    while (t <= endT) {
      keys.push(new Date(t).toISOString().split('T')[0]);
      t += 24 * 60 * 60 * 1000;
      if (keys.length > 500) break;
    }
    return keys;
  }

  private emptyTrendBucket(): {
    revenue: number;
    confirmed: number;
    canceled: number;
    refunded: number;
    canceledRevenue: number;
    refundedRevenue: number;
  } {
    return {
      revenue: 0,
      confirmed: 0,
      canceled: 0,
      refunded: 0,
      canceledRevenue: 0,
      refundedRevenue: 0,
    };
  }

  /**
   * Acumula uma inscrição num bucket diário/mensal (centavos + contagens).
   * Estorno antes de cancelado antes de confirmado, para não duplicar.
   */
  private accumulateRegistrationIntoTrendBucket(
    bucket: {
      revenue: number;
      confirmed: number;
      canceled: number;
      refunded: number;
      canceledRevenue: number;
      refundedRevenue: number;
    },
    reg: any,
  ) {
    const cents = this.normalizeToCents(reg.order?.finalAmount);
    const payStatus = reg.order?.payment?.status;
    if (payStatus === PaymentStatus.REFUNDED) {
      bucket.refunded += 1;
      bucket.refundedRevenue += cents;
      return;
    }
    if (reg.status === RegistrationStatus.CANCELLED) {
      bucket.canceled += 1;
      bucket.canceledRevenue += cents;
      return;
    }
    if (payStatus === PaymentStatus.PAID && reg.status === RegistrationStatus.CONFIRMED) {
      bucket.revenue += cents;
      bucket.confirmed += 1;
    }
  }

  /**
   * Constrói dados do gráfico de tendência (`labels`, `revenue`, `dailyData` alinhados).
   */
  private buildChartData(
    registrations: any[],
    dateRange: { start: Date | null; end: Date | null },
    period?: DashboardPeriod,
  ) {
    if (period === DashboardPeriod.GERAL || !dateRange.start) {
      return this.buildMonthlyChartData(registrations);
    }
    return this.buildDailyChartData(registrations, dateRange);
  }

  /**
   * Agrupa por dia (UTC); preenche todos os dias do período para manter labels/revenue/dailyData com o mesmo tamanho.
   */
  private buildDailyChartData(
    registrations: any[],
    dateRange: { start: Date; end: Date },
  ) {
    const sortedDates = this.eachUtcDayKeys(dateRange.start, dateRange.end);
    const byDay = new Map<
      string,
      {
        revenue: number;
        confirmed: number;
        canceled: number;
        refunded: number;
        canceledRevenue: number;
        refundedRevenue: number;
      }
    >();
    for (const d of sortedDates) {
      byDay.set(d, this.emptyTrendBucket());
    }

    registrations.forEach((reg) => {
      const date = new Date(reg.order?.createdAt || reg.createdAt)
        .toISOString()
        .split('T')[0];
      if (!byDay.has(date)) return;
      this.accumulateRegistrationIntoTrendBucket(byDay.get(date)!, reg);
    });

    const labels = sortedDates.map((d) => {
      const [y, m, day] = d.split('-').map(Number);
      const date = new Date(Date.UTC(y, m - 1, day));
      return date.toLocaleDateString('pt-BR', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
    });
    const revenue = sortedDates.map((d) => byDay.get(d)!.revenue);
    const dailyData = sortedDates.map((date) => {
      const data = byDay.get(date)!;
      return {
        date,
        revenue: data.revenue,
        confirmed: data.confirmed,
        canceled: data.canceled,
        refunded: data.refunded,
        canceledRevenue: data.canceledRevenue,
        refundedRevenue: data.refundedRevenue,
      };
    });

    return { labels, revenue, dailyData };
  }

  /**
   * Gráfico período "geral": últimos 6 meses calendário; mesmo contrato que o diário (`dailyData`).
   */
  private buildMonthlyChartData(registrations: any[]) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 6);
    startDate.setDate(1);
    startDate.setHours(0, 0, 0, 0);

    const monthlyData = new Map<
      string,
      {
        revenue: number;
        confirmed: number;
        canceled: number;
        refunded: number;
        canceledRevenue: number;
        refundedRevenue: number;
      }
    >();

    for (let i = 5; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      date.setDate(1);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      monthlyData.set(monthKey, this.emptyTrendBucket());
    }

    registrations.forEach((reg) => {
      const regDate = new Date(reg.order?.createdAt || reg.createdAt);
      if (regDate < startDate || regDate > endDate) return;
      const monthKey = `${regDate.getFullYear()}-${String(regDate.getMonth() + 1).padStart(2, '0')}`;
      if (!monthlyData.has(monthKey)) return;
      this.accumulateRegistrationIntoTrendBucket(monthlyData.get(monthKey)!, reg);
    });

    const sortedMonths = Array.from(monthlyData.keys()).sort();
    const monthNames = [
      'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
      'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
    ];

    const labels = sortedMonths.map((monthKey) => {
      const [year, month] = monthKey.split('-');
      const monthIndex = parseInt(month, 10) - 1;
      return `${monthNames[monthIndex]}/${year.slice(-2)}`;
    });

    const revenue = sortedMonths.map((monthKey) => monthlyData.get(monthKey)!.revenue);
    const dailyData = sortedMonths.map((monthKey) => {
      const data = monthlyData.get(monthKey)!;
      return {
        date: monthKey,
        revenue: data.revenue,
        confirmed: data.confirmed,
        canceled: data.canceled,
        refunded: data.refunded,
        canceledRevenue: data.canceledRevenue,
        refundedRevenue: data.refundedRevenue,
      };
    });

    // `monthlyData` espelha `dailyData` (legado); o contrato do dashboard é `dailyData`.
    return { labels, revenue, dailyData, monthlyData: dailyData };
  }

  /**
   * Constrói ranking de ingressos
   */
  private buildTicketRanking(registrations: any[], page: number, limit: number) {
    const ticketMap = new Map<string, { ticketId: string; name: string; category: string; quantity: number; total: number }>();

    // Group confirmed+paid registrations by order to compute the correct per-ticket value.
    // finalAmount is order-level: dividing it by only one registration's tickets double-counts
    // when an order contains multiple registrations.
    const orderGroups = new Map<string, { finalAmount: number; regs: any[] }>();
    for (const reg of registrations) {
      if (reg.order?.payment?.status !== PaymentStatus.PAID || reg.status !== RegistrationStatus.CONFIRMED) continue;
      const orderId = reg.order.id;
      if (!orderGroups.has(orderId)) {
        orderGroups.set(orderId, { finalAmount: this.normalizeToCents(reg.order.finalAmount), regs: [] });
      }
      orderGroups.get(orderId)!.regs.push(reg);
    }

    for (const { finalAmount, regs } of orderGroups.values()) {
      // Count total items across all registrations in this order to split revenue evenly
      const totalItems = regs.reduce((sum, reg) => {
        if (reg.tickets?.length > 0) return sum + reg.tickets.length;
        if (reg.modalities?.length > 0) return sum + reg.modalities.length;
        return sum + 1;
      }, 0);
      const valuePerItem = totalItems > 0 ? finalAmount / totalItems : 0;

      for (const reg of regs) {
        if (reg.tickets && reg.tickets.length > 0) {
          reg.tickets.forEach((rt: any) => {
            const ticket = rt.ticket;
            const ticketId = ticket.id;
            if (!ticketMap.has(ticketId)) {
              ticketMap.set(ticketId, {
                ticketId,
                name: ticket.name,
                category: ticket.category?.name || 'Sem categoria',
                quantity: 0,
                total: 0,
              });
            }
            const entry = ticketMap.get(ticketId)!;
            entry.quantity += 1;
            entry.total += valuePerItem;
          });
        } else if (reg.modalities && reg.modalities.length > 0) {
          reg.modalities.forEach((rm: any) => {
            const modality = rm.modality;
            const modalityId = modality.id;
            if (!ticketMap.has(modalityId)) {
              ticketMap.set(modalityId, {
                ticketId: modalityId,
                name: modality.name,
                category: 'Sem categoria',
                quantity: 0,
                total: 0,
              });
            }
            const entry = ticketMap.get(modalityId)!;
            entry.quantity += 1;
            entry.total += valuePerItem;
          });
        }
      }
    }

    return Array.from(ticketMap.values())
      .map(ticket => ({ ...ticket, total: Math.round(ticket.total) }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice((page - 1) * limit, page * limit);
  }

  /**
   * Constrói top cidades
   */
  private buildTopCities(registrations: any[]) {
    const cityMap = new Map<string, { city: string; state?: string; buyers: number }>();

    // Filtrar apenas registrations pagas e confirmadas
    const paidRegistrations = registrations.filter(
      (r) => r.order?.payment?.status === PaymentStatus.PAID && r.status === RegistrationStatus.CONFIRMED,
    );

    paidRegistrations.forEach((reg) => {
      // Verificar se user existe e tem cidade (city pode ser string vazia)
      const city = reg.user?.city?.trim();
      const state = reg.user?.state?.trim() || '';

      if (city && city.length > 0) {
        const key = `${city}-${state}`;
        if (!cityMap.has(key)) {
          cityMap.set(key, {
            city: city,
            state: state || undefined,
            buyers: 0,
          });
        }
        cityMap.get(key)!.buyers += 1;
      }
    });

    // Ordenar por número de compradores (decrescente) e retornar apenas as 2 top cidades
    const result = Array.from(cityMap.values())
      .sort((a, b) => b.buyers - a.buyers)
      .slice(0, 2) // Limitar a apenas 2 cidades
      .map((item) => ({
        city: item.city,
        state: item.state,
        buyers: item.buyers,
      }));

    return result;
  }

  /**
   * Lotes do evento para o dashboard: apenas lotes **ativos** (janela start/end em relação a agora),
   * com capacidade (>0), em ingressos ativos.
   * Vendas por `RegistrationTicket.batchId`; vendas sem lote são alocadas FIFO nos lotes ativos do ingresso.
   * Ordem: menor `remaining` primeiro (mais próximo do esgotamento), depois maior % vendido.
   */
  private async buildLotsNearDepletion(
    prismaRead: ReturnType<PrismaService['getReadClient']>,
    eventId: string,
  ) {
    const paidRegistrationWhere = {
      status: RegistrationStatus.CONFIRMED,
      eventId,
      order: { payment: { status: PaymentStatus.PAID } },
    };

    const now = new Date();
    const allBatches = await prismaRead.ticketBatch.findMany({
      where: {
        ticket: { eventId, isActive: true },
        quantity: { gt: 0 },
      },
      include: {
        ticket: { select: { id: true, name: true } },
      },
      orderBy: [{ ticketId: 'asc' }, { sortOrder: 'asc' }],
    });

    // Mapa: ticketId → lote ativo (primeiro com availableQuantity > 0, por sortOrder)
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
        const number = tBatches.indexOf(active) + 1;
        activeBatchByTicket.set(ticketId, { id: active.id, number });
      }
    }

    const batches = allBatches.filter((b) => {
      if (b.startDate && new Date(b.startDate) > now) return false;
      if (b.endDate && new Date(b.endDate) < now) return false;
      return true;
    });

    if (batches.length === 0) {
      return [];
    }

    const batchIds = batches.map((b) => b.id);

    const [soldByBatch, soldByTicket] = await Promise.all([
      prismaRead.registrationTicket.groupBy({
        by: ['batchId'],
        where: {
          batchId: { in: batchIds },
          registration: paidRegistrationWhere,
        },
        _count: { _all: true },
      }),
      prismaRead.registrationTicket.groupBy({
        by: ['ticketId'],
        where: {
          ticket: { eventId, isActive: true },
          registration: paidRegistrationWhere,
        },
        _count: { _all: true },
      }),
    ]);

    const soldCountByBatchId = new Map<string, number>();
    for (const row of soldByBatch) {
      if (row.batchId) {
        soldCountByBatchId.set(row.batchId, row._count._all);
      }
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
    for (const b of batches) {
      effectiveSold.set(b.id, soldCountByBatchId.get(b.id) ?? 0);
    }

    for (const [, ticketBatches] of byTicket) {
      const ticketId = ticketBatches[0].ticketId;
      const total = totalSoldByTicketId.get(ticketId) ?? 0;
      const assigned = ticketBatches.reduce(
        (s, bt) => s + (effectiveSold.get(bt.id) ?? 0),
        0,
      );
      let orphan = total - assigned;
      if (orphan <= 0) continue;

      for (const bt of ticketBatches) {
        if (orphan <= 0) break;
        const cap = bt.quantity;
        const current = effectiveSold.get(bt.id) ?? 0;
        const room = Math.max(0, cap - current);
        const add = Math.min(orphan, room);
        effectiveSold.set(bt.id, current + add);
        orphan -= add;
      }
    }

    const resolveStatus = (remaining: number, percentageSold: number): 'Normal' | 'Atenção' | 'Crítico' => {
      const isLowStock = remaining > 0 && remaining <= 25;
      if (percentageSold >= 90 || remaining === 0 || (isLowStock && percentageSold >= 50)) return 'Crítico';
      if (percentageSold >= 75 || (isLowStock && percentageSold >= 25)) return 'Atenção';
      return 'Normal';
    };

    // Agrupar por ticket
    const tickets = new Map<string, {
      ticketId: string;
      ticketName: string;
      total: number;
      sold: number;
      batches: Array<{ id: string; name: string; total: number; sold: number; remaining: number; percentageSold: number; status: string }>;
    }>();

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
        status: resolveStatus(batchRemaining, batchPct),
      });

      tickets.set(batch.ticketId, entry);
    }

    const result = Array.from(tickets.values()).map((t) => {
      const remaining = Math.max(0, t.total - t.sold);
      const percentageSold = t.total > 0 ? Math.round((t.sold / t.total) * 10000) / 100 : 0;
      const active = activeBatchByTicket.get(t.ticketId) ?? null;
      return {
        ticketId: t.ticketId,
        ticketName: t.ticketName,
        status: resolveStatus(remaining, percentageSold),
        sold: t.sold,
        total: t.total,
        remaining,
        percentageSold,
        activeBatch: active
          ? { id: active.id, number: active.number, label: `Lote ${active.number}` }
          : null,
        batches: t.batches,
      };
    });

    result.sort((a, b) => {
      if (a.remaining !== b.remaining) return a.remaining - b.remaining;
      return b.percentageSold - a.percentageSold;
    });

    return result;
  }

  /**
   * Constrói heatmap de vendas
   */
  private buildSalesHeatmap(registrations: any[]) {
    const heatmap = new Map<string, number>();

    registrations.forEach((reg) => {
      if (reg.order?.payment?.status === PaymentStatus.PAID && reg.status === RegistrationStatus.CONFIRMED) {
        const date = new Date(reg.order?.createdAt || reg.createdAt);
        const day = date.getDay(); // 0 = Domingo, 6 = Sábado
        const hour = date.getHours();

        const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
        const key = `${dayNames[day]}-${hour}`;

        heatmap.set(key, (heatmap.get(key) || 0) + 1);
      }
    });

    return Array.from(heatmap.entries()).map(([key, sales]) => {
      const [day, hour] = key.split('-');
      return {
        day,
        hour: parseInt(hour, 10),
        sales,
      };
    });
  }

  /**
   *
   * Obtém dados financeiros do evento
   *
   * Delega o cálculo do breakdown para RepasseService.computeBreakdownForEvent
   * para garantir consistência com a UI de repasse (mesma lógica de retenção,
   * estornos priorizados e recuperação de saldo negativo).
   */
  async getFinancial(userId: string, eventId: string, queryDto: FinancialQueryDto) {
    await this.verifyOrganizerAccess(userId, eventId, 'financial');

    const { page = 1, limit = 20 } = queryDto;

    const [{ breakdown, audit, refundedOrders, completedWithdrawalsTotal }, tickets] = await Promise.all([
      this.repasseService.computeBreakdownForEvent(eventId),
      this.ticketsService.findAll(eventId, { page, limit, includeInactive: true }),
    ]);

    const totalRefunded = refundedOrders.reduce(
      (s: number, o: any) => s + (o.finalAmount ?? 0),
      0,
    );

    return {
      message: 'Financial data fetched successfully',
      data: {
        summary: {
          // Mapeia nomes do RepasseService → contrato existente do EventsService.getFinancial
          availableBalance: Math.max(0, breakdown.saldoParaSaque),
          pendingRelease: breakdown.aguardandoLiberacao,
          awaitingAudit: breakdown.valorRetido,
          installmentsToReceive: breakdown.parceladosAReceber,
          grossRevenue: breakdown.grossRevenue,
          totalWithdrawn: completedWithdrawalsTotal,
          totalRefunded,
          refundedCount: refundedOrders.length,
          totalChargebacks: 0,
          isAudited: !!audit,
        },
        tickets,
      },
    };
  }

  // Prazos de retenção por método de pagamento (em dias)
  private static readonly RETENTION_DAYS: Record<string, number> = {
    [PaymentMethod.PIX]: 1,
    [PaymentMethod.CREDIT_CARD]: 31,
    [PaymentMethod.BOLETO]: 3,
    [PaymentMethod.CRYPTO]: 30,
  };

  /**
   * Calcula range de datas para financial
   */
  private calculateFinancialDateRange(period: FinancialPeriod): { start: Date | null; end: Date | null } {
    const now = new Date();
    const start = new Date();
    const end = new Date();

    switch (period) {
      case FinancialPeriod.HOJE:
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        return { start, end };
      case FinancialPeriod.LAST_7D:
        start.setDate(now.getDate() - 7);
        return { start, end: now };
      case FinancialPeriod.LAST_15D:
        start.setDate(now.getDate() - 15);
        return { start, end: now };
      case FinancialPeriod.LAST_1M:
        start.setMonth(now.getMonth() - 1);
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        return { start, end: now };
      case FinancialPeriod.LAST_2M:
        start.setMonth(now.getMonth() - 2);
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        return { start, end: now };
      default:
        return { start: null, end: null };
    }
  }

  /**
   * Constrói gráfico de faturamento
   */
  private buildRevenueChart(registrations: any[], dateRange: { start: Date | null; end: Date | null }) {
    const dailyData = new Map<string, number>();

    registrations.forEach((reg) => {
      const date = new Date(reg.order?.createdAt || reg.createdAt).toISOString().split('T')[0];
      dailyData.set(date, (dailyData.get(date) || 0) + (reg.order?.totalAmount || 0));
    });

    const sortedDates = Array.from(dailyData.keys()).sort();
    const labels = sortedDates.map((d) => {
      const date = new Date(d);
      return date.toLocaleDateString('pt-BR', { month: 'short', day: 'numeric' });
    });
    const revenue = sortedDates.map((d) => dailyData.get(d)!);

    return {
      labels,
      revenue,
      dailyData: sortedDates.map((date) => ({
        date,
        revenue: dailyData.get(date)!,
      })),
    };
  }

  /**
   * Constrói tabela de ingressos/lotes
   */
  private async buildTicketsTable(prismaRead: any, eventId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;

    // Count sold RegistrationTickets per batch (only CONFIRMED/COMPLETED registrations)
    const batchSoldCounts = await prismaRead.registrationTicket.groupBy({
      by: ['batchId'],
      where: {
        batchId: { not: null },
        registration: {
          eventId,
          status: { in: [RegistrationStatus.CONFIRMED, RegistrationStatus.COMPLETED] },
        },
      },
      _count: { id: true },
    });

    const batchSoldMap = new Map<string, number>();
    for (const row of batchSoldCounts) {
      batchSoldMap.set(row.batchId, row._count.id);
    }

    // Buscar categorias e tickets com batches
    const categories = await prismaRead.ticketCategory.findMany({
      where: { eventId },
      include: {
        tickets: {
          include: {
            batches: { orderBy: { createdAt: 'asc' } },
          },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
      orderBy: { order: 'asc' },
    });

    const items: any[] = [];

    for (const category of categories) {
      let categorySold = 0;
      let categoryRevenue = 0;

      const lots = category.tickets.flatMap((ticket: any) => {
        let ticketSold = 0;
        let ticketRevenue = 0;

        const batchRows = ticket.batches.map((batch: any) => {
          const sold = batchSoldMap.get(batch.id) ?? 0;
          const revenue = sold * batch.price;
          ticketSold += sold;
          ticketRevenue += revenue;
          return {
            id: batch.id,
            name: `${ticket.name} - Lote ${batch.id.slice(0, 8)}`,
            sold,
            revenue,
            createdAt: batch.createdAt.toISOString(),
          };
        });

        categorySold += ticketSold;
        categoryRevenue += ticketRevenue;

        return batchRows;
      });

      items.push({
        id: category.id,
        type: 'category' as const,
        name: category.name,
        sold: categorySold,
        revenue: categoryRevenue,
        createdAt: category.createdAt.toISOString(),
        lots,
      });
    }

    // Buscar tickets sem categoria
    const ticketsWithoutCategory = await prismaRead.ticket.findMany({
      where: { eventId, categoryId: null },
      include: { batches: { orderBy: { createdAt: 'asc' } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    for (const ticket of ticketsWithoutCategory) {
      let ticketSold = 0;
      let ticketRevenue = 0;

      for (const batch of ticket.batches) {
        const sold = batchSoldMap.get(batch.id) ?? 0;
        ticketSold += sold;
        ticketRevenue += sold * batch.price;
      }

      items.push({
        id: ticket.id,
        type: 'lot' as const,
        name: ticket.name,
        sold: ticketSold,
        revenue: ticketRevenue,
        createdAt: ticket.createdAt.toISOString(),
      });
    }

    const total = items.length;
    const paginatedItems = items.slice(skip, skip + limit);

    return {
      items: paginatedItems,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /** Escapa `%`, `_` e `\` para uso em ILIKE ... ESCAPE '\' */
  private escapeIlikePattern(fragment: string): string {
    return fragment.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }

  /**
   * Paginação no banco para filtro CHARGEBACK/REFUNDED por metadata (evita findMany completo + slice).
   * Preserva a mesma ordenação e critérios do fluxo anterior em memória.
   */
  private async queryRegistrationIdsPageForRefundedMetadataFilter(
    prismaRead: PrismaClient,
    params: {
      eventId: string;
      targetRefundType: 'CHARGEBACK' | 'REFUND';
      ticketIds?: string[];
      startDate?: string;
      endDate?: string;
      search?: string;
      sortBy: string;
      sortOrder: 'asc' | 'desc';
      skip: number;
      limit: number;
    },
  ): Promise<{ ids: string[]; total: number }> {
    const parts: Prisma.Sql[] = [
      Prisma.sql`r."eventId" = ${params.eventId}::uuid`,
      Prisma.sql`p.status = 'REFUNDED'`,
    ];

    if (params.targetRefundType === 'CHARGEBACK') {
      parts.push(Prisma.sql`(p.metadata->>'refundType') = 'CHARGEBACK'`);
    } else {
      parts.push(
        Prisma.sql`(NOT ((p.metadata->>'refundType') = 'CHARGEBACK') AND ((p.metadata->>'refundType') = 'REFUND' OR (p.metadata->>'refundType') IS NULL OR (p.metadata->>'refundType') = ''))`,
      );
    }

    if (params.ticketIds && params.ticketIds.length > 0) {
      const ticketConds = params.ticketIds.map(
        (id) => Prisma.sql`${id}::uuid`,
      );
      parts.push(
        Prisma.sql`EXISTS (SELECT 1 FROM "RegistrationTicket" rt WHERE rt."registrationId" = r.id AND rt."ticketId" IN (${Prisma.join(ticketConds)}))`,
      );
    }

    if (params.startDate) {
      parts.push(Prisma.sql`o."createdAt" >= ${new Date(params.startDate)}`);
    }
    if (params.endDate) {
      parts.push(Prisma.sql`o."createdAt" <= ${new Date(params.endDate)}`);
    }

    const searchTrim = params.search?.trim();
    if (searchTrim) {
      const pat = `%${this.escapeIlikePattern(searchTrim)}%`;
      parts.push(
        Prisma.sql`(r.id::text ILIKE ${pat} ESCAPE '\\' OR EXISTS (SELECT 1 FROM "User" u WHERE u.id = r."userId" AND (u."firstName" ILIKE ${pat} ESCAPE '\\' OR u."lastName" ILIKE ${pat} ESCAPE '\\' OR u.email ILIKE ${pat} ESCAPE '\\' OR COALESCE(u."documentNumber", '') ILIKE ${pat} ESCAPE '\\')))`,
      );
    }

    const whereSql = Prisma.join(parts, ' AND ');

    let orderSql: Prisma.Sql;
    const desc = params.sortOrder !== 'asc';
    if (params.sortBy === 'amount') {
      orderSql = desc
        ? Prisma.sql`o."finalAmount" DESC, r.id DESC`
        : Prisma.sql`o."finalAmount" ASC, r.id ASC`;
    } else if (params.sortBy === 'status') {
      orderSql = desc
        ? Prisma.sql`r.status DESC, r.id DESC`
        : Prisma.sql`r.status ASC, r.id ASC`;
    } else {
      orderSql = desc
        ? Prisma.sql`o."createdAt" DESC NULLS LAST, r.id DESC`
        : Prisma.sql`o."createdAt" ASC NULLS LAST, r.id ASC`;
    }

    const fromJoin = Prisma.sql`
      FROM "Registration" r
      INNER JOIN "Order" o ON o.id = r."orderId"
      INNER JOIN "Payment" p ON p."orderId" = o.id
      WHERE ${whereSql}
    `;

    const [countRows, idRows] = await Promise.all([
      prismaRead.$queryRaw<{ c: bigint }[]>(
        Prisma.sql`SELECT COUNT(*)::bigint AS c ${fromJoin}`,
      ),
      prismaRead.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT r.id ${fromJoin} ORDER BY ${orderSql} LIMIT ${params.limit} OFFSET ${params.skip}`,
      ),
    ]);

    const total = Number(countRows[0]?.c ?? 0);
    const ids = idRows.map((row) => row.id);
    return { ids, total };
  }

  /**
   * Métricas agregadas de inscrições do evento (sem carregar todas as linhas).
   * collected replica a soma por inscrição (finalAmount repetido por registro no mesmo pedido).
   */
  private async aggregateEventRegistrationMetrics(
    prismaRead: PrismaClient,
    eventId: string,
    orderCreatedBetween?: { gte: Date; lte?: Date; lt?: Date },
  ): Promise<{
    total: number;
    paid: number;
    cancelled: number;
    collected: number;
  }> {
    const upperBoundSql =
      orderCreatedBetween?.lt !== undefined
        ? Prisma.sql`AND o."createdAt" < ${orderCreatedBetween.lt}`
        : orderCreatedBetween?.lte !== undefined
          ? Prisma.sql`AND o."createdAt" <= ${orderCreatedBetween.lte}`
          : Prisma.empty;

    // collected must be summed per unique order, not per registration.
    // Using a CTE with DISTINCT (orderId, finalAmount) prevents double-counting
    // when multiple confirmed registrations belong to the same order.
    const rows = orderCreatedBetween
      ? await prismaRead.$queryRaw<
        {
          total: bigint;
          paid: bigint;
          cancelled: bigint;
          collected: bigint;
        }[]
      >(Prisma.sql`
          WITH paid_orders AS (
            SELECT DISTINCT r."orderId", o."finalAmount"
            FROM "Registration" r
            INNER JOIN "Order" o ON o.id = r."orderId"
            INNER JOIN "Payment" p ON p."orderId" = o.id
            WHERE r."eventId" = ${eventId}::uuid
              AND r.status::text IN ('CONFIRMED', 'COMPLETED')
              AND p.status::text = 'PAID'
              AND o."createdAt" >= ${orderCreatedBetween.gte}
              ${upperBoundSql}
          )
          SELECT
            COUNT(*) FILTER (
              WHERE r.status::text IN ('CONFIRMED', 'COMPLETED')
            )::bigint AS total,
            COUNT(*) FILTER (
              WHERE r.status::text IN ('CONFIRMED', 'COMPLETED')
                AND p.status::text = 'PAID'
            )::bigint AS paid,
            COUNT(*) FILTER (WHERE r.status::text = 'CANCELLED')::bigint AS cancelled,
            COALESCE((SELECT SUM("finalAmount") FROM paid_orders), 0)::bigint AS collected
          FROM "Registration" r
          INNER JOIN "Order" o ON o.id = r."orderId"
          LEFT JOIN "Payment" p ON p."orderId" = o.id
          WHERE r."eventId" = ${eventId}::uuid
            AND r.status::text != 'PENDING'
            AND o."createdAt" >= ${orderCreatedBetween.gte}
            ${upperBoundSql}
        `)
      : await prismaRead.$queryRaw<
        {
          total: bigint;
          paid: bigint;
          cancelled: bigint;
          collected: bigint;
        }[]
      >(Prisma.sql`
          WITH paid_orders AS (
            SELECT DISTINCT r."orderId", o."finalAmount"
            FROM "Registration" r
            INNER JOIN "Order" o ON o.id = r."orderId"
            INNER JOIN "Payment" p ON p."orderId" = o.id
            WHERE r."eventId" = ${eventId}::uuid
              AND r.status::text IN ('CONFIRMED', 'COMPLETED')
              AND p.status::text = 'PAID'
          )
          SELECT
            COUNT(*) FILTER (
              WHERE r.status::text IN ('CONFIRMED', 'COMPLETED')
            )::bigint AS total,
            COUNT(*) FILTER (
              WHERE r.status::text IN ('CONFIRMED', 'COMPLETED')
                AND p.status::text = 'PAID'
            )::bigint AS paid,
            COUNT(*) FILTER (WHERE r.status::text = 'CANCELLED')::bigint AS cancelled,
            COALESCE((SELECT SUM("finalAmount") FROM paid_orders), 0)::bigint AS collected
          FROM "Registration" r
          INNER JOIN "Order" o ON o.id = r."orderId"
          LEFT JOIN "Payment" p ON p."orderId" = o.id
          WHERE r."eventId" = ${eventId}::uuid
            AND r.status::text != 'PENDING'
        `);

    const row = rows[0];
    return {
      total: Number(row?.total ?? 0),
      paid: Number(row?.paid ?? 0),
      cancelled: Number(row?.cancelled ?? 0),
      collected: Number(row?.collected ?? 0),
    };
  }

  /**
   * Variação percentual: últimos 7 dias vs. 7 dias anteriores (filtro por data de criação do pedido).
   * Retorna 0% quando a semana anterior não tem base (denominador zero).
   */
  private async computeRegistrationWowPercentChanges(
    prismaRead: PrismaClient,
    eventId: string,
    reference: Date = new Date(),
  ): Promise<{
    totalChange: number;
    paidChange: number;
    cancelledChange: number;
    totalCollectedChange: number;
  }> {
    const now = reference;
    const currentWeekStart = new Date(now);
    currentWeekStart.setDate(now.getDate() - 7);
    const previousWeekStart = new Date(now);
    previousWeekStart.setDate(now.getDate() - 14);

    const [thisWeek, prevWeek] = await Promise.all([
      this.aggregateEventRegistrationMetrics(prismaRead, eventId, {
        gte: currentWeekStart,
        lte: now,
      }),
      this.aggregateEventRegistrationMetrics(prismaRead, eventId, {
        gte: previousWeekStart,
        lt: currentWeekStart,
      }),
    ]);

    const pct = (cur: number, prev: number): number =>
      prev > 0 ? ((cur - prev) / prev) * 100 : 0;

    return {
      totalChange: pct(thisWeek.total, prevWeek.total),
      paidChange: pct(thisWeek.paid, prevWeek.paid),
      cancelledChange: pct(thisWeek.cancelled, prevWeek.cancelled),
      totalCollectedChange: pct(
        this.normalizeToCents(thisWeek.collected),
        this.normalizeToCents(prevWeek.collected),
      ),
    };
  }

  /**
   * Obtém inscrições com filtros avançados
   */
  async getRegistrations(userId: string, eventId: string, queryDto: RegistrationsQueryDto) {
    await this.verifyOrganizerAccess(userId, eventId, 'dashboard');

    const prismaRead = this.prisma.getReadClient();
    const {
      page = 1,
      limit = 20,
      status,
      search,
      ticketIds,
      startDate,
      endDate,
      sortBy = 'purchaseDate',
      sortOrder = 'desc',
    } = queryDto;

    const skip = (page - 1) * limit;

    // Construir where clause
    const where: any = {
      eventId,
      status: { not: RegistrationStatus.PENDING },
    };

    // Filtro por status - suporta status de registro e status de pagamento (CHARGEBACK, REFUNDED)
    // Para CHARGEBACK e REFUNDED, precisamos filtrar por payment.status REFUNDED e depois pelo metadata
    let filterByPaymentMetadata = false;
    let targetRefundType: 'CHARGEBACK' | 'REFUND' | null = null;

    if (status) {
      if (status === 'CHARGEBACK') {
        // Filtrar por pagamentos REFUNDED com refundType CHARGEBACK no metadata
        where.order = {
          ...where.order,
          payment: {
            status: PaymentStatus.REFUNDED,
          },
        };
        filterByPaymentMetadata = true;
        targetRefundType = 'CHARGEBACK';
      } else if (status === 'REFUNDED') {
        // Filtrar por pagamentos REFUNDED com refundType REFUND no metadata (ou sem refundType)
        where.order = {
          ...where.order,
          payment: {
            status: PaymentStatus.REFUNDED,
          },
        };
        filterByPaymentMetadata = true;
        targetRefundType = 'REFUND';
      } else {
        // Status normal de registro (PENDING, CONFIRMED, CANCELLED, COMPLETED)
        const validStatuses = ['CONFIRMED', 'CANCELLED', 'COMPLETED'];
        if (validStatuses.includes(status)) {
          if (status === 'COMPLETED') {
            // "COMPLETED" from the frontend means "paid" — registrations with a successful
            // payment. Both CONFIRMED (paid, event upcoming) and COMPLETED (paid, attended)
            // are considered paid; filter by payment.status = PAID instead of registration status.
            where.status = { in: [RegistrationStatus.CONFIRMED, RegistrationStatus.COMPLETED] } as any;
            where.order = {
              ...where.order,
              payment: {
                status: PaymentStatus.PAID,
              },
            };
          } else {
            where.status = status as RegistrationStatus;

            // Exclude REFUNDED registrations from CANCELLED view.
            // When payment is null the nested filter evaluates false, so NOT(false) = true
            // correctly includes registrations with no payment record.
            if (status === 'CANCELLED') {
              if (!where.AND) where.AND = [];
              where.AND.push({
                NOT: {
                  order: {
                    payment: {
                      status: PaymentStatus.REFUNDED,
                    },
                  },
                },
              });
            }
          }
        }
      }
    }

    if (startDate || endDate) {
      // Se já existe where.order (de filtro de status), mesclar
      if (!where.order) {
        where.order = {};
      }
      if (!where.order.createdAt) {
        where.order.createdAt = {};
      }
      if (startDate) where.order.createdAt.gte = new Date(startDate);
      if (endDate) where.order.createdAt.lte = new Date(endDate);
    }

    // IMPORTANTE: Se where.order está definido mas vazio (sem filtros), remover para não excluir registrations
    // Isso garante que todos os registrations sejam retornados quando não há filtros de order
    // Verificar se where.order está vazio (sem createdAt, sem payment, etc.)
    if (where.order) {
      const hasCreatedAt = where.order.createdAt && Object.keys(where.order.createdAt).length > 0;
      const hasPayment = where.order.payment && Object.keys(where.order.payment).length > 0;

      // Se não tem nenhum filtro real, remover where.order
      if (!hasCreatedAt && !hasPayment) {
        delete where.order;
      }
    }

    // Filtro por ticketIds
    if (ticketIds && ticketIds.length > 0) {
      where.tickets = {
        some: {
          ticketId: { in: ticketIds },
        },
      };
    }

    // Search by text (name, CPF, email, registration ID, order ID)
    // Prefix search with '#' to filter by ID only (e.g. "#abc123")
    // IDs are UUIDs — Prisma doesn't support `contains` on them; use raw SQL cast
    if (search) {
      const isIdSearch = search.startsWith('#');
      const searchTerm = isIdSearch ? search.slice(1) : search;
      // CPF/CNPJ formatados (ex: 503.798.000-00) → buscar também sem pontuação
      const searchTermDigits = searchTerm.replace(/[.\-\/]/g, '');

      const uuidMatches = await prismaRead.$queryRaw<{ id: string }[]>`
        SELECT r.id FROM "Registration" r
        JOIN "Order" o ON o.id = r."orderId"
        WHERE r."eventId" = ${eventId}::uuid
          AND (r.id::text ILIKE ${'%' + searchTerm + '%'} OR o.id::text ILIKE ${'%' + searchTerm + '%'})
      `;
      const uuidMatchIds = uuidMatches.map((row) => row.id);

      if (isIdSearch) {
        where.OR = uuidMatchIds.length > 0 ? [{ id: { in: uuidMatchIds } }] : [{ id: 'no-match' }];
      } else {
        where.OR = [
          ...(uuidMatchIds.length > 0 ? [{ id: { in: uuidMatchIds } }] : []),
          {
            user: {
              OR: [
                { firstName: { contains: searchTerm, mode: 'insensitive' } },
                { lastName: { contains: searchTerm, mode: 'insensitive' } },
                { email: { contains: searchTerm, mode: 'insensitive' } },
                { documentNumber: { contains: searchTerm, mode: 'insensitive' } },
                ...(searchTermDigits !== searchTerm
                  ? [{ documentNumber: { contains: searchTermDigits, mode: 'insensitive' as const } }]
                  : []),
              ],
            },
          },
          { participantName: { contains: searchTerm, mode: 'insensitive' } },
          { participantEmail: { contains: searchTerm, mode: 'insensitive' } },
          { participantCpf: { contains: searchTerm, mode: 'insensitive' } },
          ...(searchTermDigits !== searchTerm
            ? [{ participantCpf: { contains: searchTermDigits, mode: 'insensitive' as const } }]
            : []),
        ];
      }
    }

    // Ordenação
    // Sempre adicionar ordenação secundária por id da registration para garantir ordem consistente
    const orderBy: any[] = [];
    if (sortBy === 'purchaseDate') {
      orderBy.push({
        order: {
          createdAt: sortOrder,
        },
      });
    } else if (sortBy === 'amount') {
      orderBy.push({
        order: {
          finalAmount: sortOrder,
        },
      });
    } else if (sortBy === 'status') {
      orderBy.push({
        status: sortOrder,
      });
    }
    // Sempre adicionar ordenação secundária por id para garantir ordem consistente entre registrations do mesmo pedido
    orderBy.push({ id: sortOrder });

    // Se precisar filtrar por metadata do payment (CHARGEBACK ou REFUNDED), buscar todos e filtrar depois
    let registrations: any[];
    let total: number;

    const includeClause = {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          documentNumber: true,
          avatarUrl: true,
        },
      },
      modalities: {
        include: {
          modality: true,
        },
      },
      tickets: {
        include: {
          ticket: {
            include: {
              category: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
          batch: {
            select: {
              id: true,
              price: true,
            },
          },
        },
      },
      products: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
            },
          },
          variation: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
      kitItems: {
        include: {
          kitItem: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
      questionAnswers: {
        include: {
          question: {
            select: {
              id: true,
              question: true,
              type: true,
            },
          },
        },
      },
      order: {
        include: {
          payment: {
            select: {
              id: true,
              status: true,
              method: true,
              amount: true,
              paymentDate: true,
              createdAt: true,
              metadata: true,
            },
          },
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              avatarUrl: true,
            },
          },
        },
      },
    };

    if (filterByPaymentMetadata && targetRefundType) {
      const { ids, total: metaTotal } =
        await this.queryRegistrationIdsPageForRefundedMetadataFilter(
          prismaRead,
          {
            eventId,
            targetRefundType,
            ticketIds: ticketIds && ticketIds.length > 0 ? ticketIds : undefined,
            startDate,
            endDate,
            search,
            sortBy,
            sortOrder,
            skip,
            limit,
          },
        );
      total = metaTotal;
      if (ids.length === 0) {
        registrations = [];
      } else {
        const unsorted = await prismaRead.registration.findMany({
          where: { id: { in: ids } },
          include: includeClause,
        });
        const orderMap = new Map(ids.map((id, i) => [id, i]));
        registrations = [...unsorted].sort(
          (a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0),
        );
      }
    } else {
      // Buscar registrations e total normalmente
      // Garantir que where está limpo e correto
      const finalWhere: any = {
        eventId,
        status: where.status ?? { not: RegistrationStatus.PENDING },
      };

      // Aplicar filtros apenas se existirem
      // (status já aplicado acima)
      if (where.tickets) {
        finalWhere.tickets = where.tickets;
      }
      if (where.OR) {
        finalWhere.OR = where.OR;
      }
      if (where.AND && where.AND.length > 0) {
        finalWhere.AND = where.AND;
      }
      // where.order só deve ser incluído se tiver filtros reais (já foi verificado acima)
      if (where.order && (where.order.createdAt || where.order.payment)) {
        finalWhere.order = where.order;
      }

      [registrations, total] = await Promise.all([
        prismaRead.registration.findMany({
          where: finalWhere,
          skip,
          take: limit,
          orderBy,
          include: includeClause,
        }),
        prismaRead.registration.count({ where: finalWhere }),
      ]);
    }

    const [stats, wowChanges] = await Promise.all([
      this.aggregateEventRegistrationMetrics(prismaRead, eventId),
      this.computeRegistrationWowPercentChanges(prismaRead, eventId),
    ]);

    const paid = stats.paid;
    const cancelled = stats.cancelled;
    const totalCollected = this.normalizeToCents(stats.collected);

    const { totalChange, paidChange, cancelledChange, totalCollectedChange } = wowChanges;

    // Formatar registrations
    // Cada registration representa um participante do pedido
    // O pedido (order) agrupa múltiplas inscrições e tem o pagamento
    const formattedRegistrations = registrations.map((reg: any) => {
      const u = reg.user;
      const participantData = u ? u : {
        id: null,
        firstName: (reg.participantName ?? '').split(' ')[0] ?? '',
        lastName: (reg.participantName ?? '').split(' ').slice(1).join(' ') ?? '',
        email: reg.participantEmail ?? null,
        phone: reg.participantPhone ?? null,
        documentNumber: reg.participantCpf ?? null,
        avatarUrl: null,
      };
      return ({
        id: reg.id,
        userId: reg.userId,
        eventId: reg.eventId,
        orderId: reg.orderId,
        status: reg.status,
        qrCode: reg.qrCode,
        createdAt: reg.createdAt.toISOString(),
        updatedAt: reg.updatedAt.toISOString(),
        user: participantData,
        // Dados do pedido (compartilhado entre participantes)
        order: reg.order ? {
          id: reg.order.id,
          totalAmount: this.normalizeToCents(reg.order.totalAmount), // Normalizar para centavos
          serviceFee: this.normalizeToCents(reg.order.serviceFee), // Normalizar para centavos
          discount: this.normalizeToCents(reg.order.discount), // Normalizar para centavos
          finalAmount: this.normalizeToCents(reg.order.finalAmount), // Normalizar para centavos
          purchaseDate: reg.order.createdAt.toISOString(), // Data do pedido
          // Informações do comprador (quem fez o pedido/pagamento)
          buyer: reg.order.user ? {
            id: reg.order.user.id,
            firstName: reg.order.user.firstName,
            lastName: reg.order.user.lastName,
            email: reg.order.user.email,
            avatarUrl: reg.order.user.avatarUrl,
          } : null,
          billingAddress: this.resolveOrderBillingAddress(reg.order, reg.order.payment),
          // Informações do pagamento
          payment: reg.order.payment ? (() => {
            const payment = reg.order.payment;

            // Parsear metadata - Prisma Json pode vir como objeto ou string
            let metadata: any = null;
            if (payment.metadata) {
              if (typeof payment.metadata === 'string') {
                try {
                  metadata = JSON.parse(payment.metadata);
                } catch (e) {
                  // Se falhar ao parsear, tentar usar como objeto
                  metadata = payment.metadata;
                }
              } else {
                // Já é um objeto
                metadata = payment.metadata;
              }
            }

            // Determinar o status detalhado baseado no status e metadata
            let paymentStatus = payment.status;
            let refundType: 'CHARGEBACK' | 'REFUND' | null = null;

            // Se o status é REFUNDED, verificar o tipo no metadata
            if (payment.status === PaymentStatus.REFUNDED) {
              if (metadata && typeof metadata === 'object' && metadata.refundType) {
                // Verificar se refundType é CHARGEBACK ou REFUND
                const rt = String(metadata.refundType).toUpperCase();
                refundType = rt === 'CHARGEBACK' ? 'CHARGEBACK' : 'REFUND';
              } else {
                // Se não tiver refundType no metadata, assumir REFUND (estorno padrão)
                refundType = 'REFUND';
              }
            }

            return {
              id: payment.id,
              status: paymentStatus,
              refundType, // Sempre incluir refundType quando status for REFUNDED
              method: payment.method,
              amount: this.normalizeToCents(payment.amount), // Normalizar para centavos
              paymentDate: payment.paymentDate?.toISOString() || null,
              createdAt: payment.createdAt.toISOString(),
              // Incluir metadata completo para facilitar renderização no frontend
              metadata: metadata || null,
            };
          })() : null,
        } : null,
        // Modalidades/Ingressos do participante
        modalities: reg.modalities.map((rm: any) => ({
          id: rm.id,
          modality: {
            id: rm.modality.id,
            name: rm.modality.name,
            price: rm.modality.price, // Já está em centavos
            ticketId: reg.tickets?.[0]?.ticket?.id,
          },
        })),
        // Ticket do participante (cada registration tem apenas um ticket)
        ticket: reg.tickets && reg.tickets.length > 0 ? (() => {
          const registrationTicket = reg.tickets[0];
          const ticket = registrationTicket.ticket;
          const snap = registrationTicket.ticketSnapshot as Record<string, any> | null;

          // Snapshot tem prioridade — preserva dados do momento da compra mesmo após edição/deleção
          const ticketPrice = snap?.batch?.price ?? registrationTicket.batch?.price ?? 0;

          // Soma dos produtos adicionados para este participante (já em centavos)
          const productsTotal = (reg.products ?? []).reduce(
            (sum: number, rp: any) => sum + (rp.totalPrice ?? 0),
            0,
          );

          return {
            id: ticket.id,
            name: snap?.name ?? ticket.name,
            description: snap?.description ?? ticket.description ?? null,
            modality: snap?.modality ?? ticket.modality ?? null,
            distance: snap?.distance ?? ticket.distance ?? null,
            distanceUnit: snap?.distanceUnit ?? ticket.distanceUnit ?? null,
            gender: snap?.gender ?? ticket.gender ?? null,
            ageLimitMin: snap?.ageLimitMin ?? ticket.ageLimitMin ?? null,
            ageLimitMax: snap?.ageLimitMax ?? ticket.ageLimitMax ?? null,
            batchId: registrationTicket.batchId ?? null,
            batchName: snap?.batch?.name ?? null,
            category: snap?.category ?? (ticket.category ? { id: ticket.category.id, name: ticket.category.name } : null),
            products: snap?.products ?? [],
            price: ticketPrice,
            productsTotal,
            total: ticketPrice + productsTotal,
          };
        })() : null,
        // Produtos adicionados para este participante
        products: (reg.products ?? []).map((rp: any) => ({
          id: rp.id,
          product: { id: rp.product.id, name: rp.product.name },
          variation: rp.variation ? { id: rp.variation.id, name: rp.variation.name } : null,
          quantity: rp.quantity,
          unitPrice: rp.unitPrice,
          totalPrice: rp.totalPrice,
        })),
        // Itens de kit do participante
        kitItems: reg.kitItems.map((ki: any) => ({
          id: ki.id,
          kitItem: {
            id: ki.kitItem.id,
            name: ki.kitItem.name,
          },
          selectedSize: ki.selectedSize,
          quantity: ki.quantity,
        })),
        // Respostas do questionário do participante
        questionAnswers: reg.questionAnswers.map((qa: any) => ({
          id: qa.id,
          question: {
            id: qa.question.id,
            question: qa.question.question,
            type: qa.question.type,
          },
          answer: qa.answer,
        })),
      });
    });

    return {
      message: 'Registrations fetched successfully',
      data: {
        registrations: formattedRegistrations,
        stats: {
          total: stats.total,
          paid,
          cancelled,
          totalCollected,
          totalChange,
          paidChange,
          cancelledChange,
          totalCollectedChange,
        },
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
   * Detalhe de um pedido do evento (organizador): valores, comprador, pagamento e endereço de cobrança.
   */
  async getOrderForOrganizer(userId: string, eventId: string, orderId: string) {
    await this.verifyOrganizerAccess(userId, eventId, 'dashboard');
    this.validateUUID(eventId, 'eventId');
    this.validateUUID(orderId, 'orderId');

    const prismaRead = this.prisma.getReadClient();
    const order = await prismaRead.order.findFirst({
      where: { id: orderId, eventId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            documentNumber: true,
            avatarUrl: true,
          },
        },
        payment: {
          select: {
            id: true,
            status: true,
            method: true,
            amount: true,
            paymentDate: true,
            transactionId: true,
            metadata: true,
            createdAt: true,
          },
        },
        registrations: {
          select: { id: true, status: true, userId: true, createdAt: true },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Pedido não encontrado para este evento');
    }

    let paymentMetadata: any = order.payment?.metadata;
    if (typeof paymentMetadata === 'string') {
      try {
        paymentMetadata = JSON.parse(paymentMetadata);
      } catch {
        paymentMetadata = null;
      }
    }

    return {
      message: 'Order fetched successfully',
      data: {
        order: {
          id: order.id,
          eventId: order.eventId,
          totalAmount: this.normalizeToCents(order.totalAmount),
          serviceFee: this.normalizeToCents(order.serviceFee),
          discount: this.normalizeToCents(order.discount),
          finalAmount: this.normalizeToCents(order.finalAmount),
          purchaseDate: order.createdAt.toISOString(),
          updatedAt: order.updatedAt.toISOString(),
          couponId: order.couponId,
          voucherId: order.voucherId,
          buyer: order.user
            ? {
              id: order.user.id,
              firstName: order.user.firstName,
              lastName: order.user.lastName,
              fullName: `${order.user.firstName} ${order.user.lastName}`,
              email: order.user.email,
              phone: order.user.phone,
              documentNumber: order.user.documentNumber,
              avatarUrl: order.user.avatarUrl,
            }
            : null,
          billingAddress: this.resolveOrderBillingAddress(order, order.payment),
          payment: order.payment
            ? {
              id: order.payment.id,
              status: order.payment.status,
              method: order.payment.method,
              amount: this.normalizeToCents(order.payment.amount),
              paymentDate: order.payment.paymentDate?.toISOString() ?? null,
              transactionId: order.payment.transactionId,
              createdAt: order.payment.createdAt.toISOString(),
              metadata: paymentMetadata ?? null,
            }
            : null,
          registrations: order.registrations.map((r) => ({
            id: r.id,
            status: r.status,
            userId: r.userId,
            createdAt: r.createdAt.toISOString(),
          })),
        },
      },
    };
  }

  /**
   * Obtém estatísticas de inscrições (endpoint separado)
   */
  async getRegistrationStats(userId: string, eventId: string) {
    await this.verifyOrganizerAccess(userId, eventId, 'dashboard');

    const prismaRead = this.prisma.getReadClient();

    const now = new Date();

    const [stats, wowChanges] = await Promise.all([
      this.aggregateEventRegistrationMetrics(prismaRead, eventId),
      this.computeRegistrationWowPercentChanges(prismaRead, eventId, now),
    ]);

    const paid = stats.paid;
    const cancelled = stats.cancelled;
    const totalCollected = this.normalizeToCents(stats.collected);

    const { totalChange, paidChange, cancelledChange, totalCollectedChange } = wowChanges;

    return {
      message: 'Registration stats fetched successfully',
      data: {
        total: stats.total,
        paid,
        cancelled,
        totalCollected,
        totalChange,
        paidChange,
        cancelledChange,
        totalCollectedChange,
      },
    };
  }

  /**
   * Calcula parcelas a receber baseado nos pagamentos parcelados
   */
  private async calculateInstallmentsToReceive(registrations: any[]): Promise<number> {
    let totalPending = 0;

    for (const reg of registrations) {
      const metadata = reg.order?.payment?.metadata as any;
      if (metadata?.creditCard?.installments && metadata.creditCard.installments > 1) {
        const installments = metadata.creditCard.installments;
        const finalAmountCents = this.normalizeToCents(reg.order?.finalAmount);
        const installmentValue = metadata.creditCard.installmentValue ? this.normalizeToCents(metadata.creditCard.installmentValue) : finalAmountCents / installments;
        const paymentDate = reg.order?.payment?.paymentDate ? new Date(reg.order.payment.paymentDate) : new Date(reg.order?.createdAt || reg.createdAt);
        const now = new Date();

        // Calcular quantas parcelas já foram recebidas (baseado em meses desde o pagamento)
        const monthsSincePayment = Math.floor(
          (now.getTime() - paymentDate.getTime()) / (1000 * 60 * 60 * 24 * 30),
        );
        const receivedInstallments = Math.min(monthsSincePayment + 1, installments);
        const pendingInstallments = installments - receivedInstallments;

        if (pendingInstallments > 0) {
          totalPending += installmentValue * pendingInstallments;
        }
      }
    }

    return totalPending;
  }

  /**
   * Obtém histórico de repasses (baseado em pagamentos antigos que já passaram do prazo de retenção)
   */
  async getFinancialTransfers(userId: string, eventId: string) {
    await this.verifyOrganizerAccess(userId, eventId, 'financial');

    const prismaRead = this.prisma.getReadClient();

    const withdrawals = await prismaRead.eventWithdrawal.findMany({
      where: { eventId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        amount: true,
        feeRate: true,
        feeAmount: true,
        netAmount: true,
        status: true,
        notes: true,
        createdAt: true,
        completedAt: true,
      },
    });

    const completedWithdrawals = withdrawals.filter((w) => w.status === WithdrawalStatus.COMPLETED);
    const totalNetAmount = completedWithdrawals.reduce((s, w) => s + (w.netAmount ?? w.amount), 0);
    const totalCount = completedWithdrawals.length;

    return {
      message: 'Transfer history fetched successfully',
      data: {
        transfers: withdrawals,
        metrics: {
          totalAmount: totalNetAmount,
          totalCount,
        },
      },
    };
  }

  /**
   * Obtém parcelas a receber (baseado em pagamentos parcelados com cartão de crédito)
   */
  async getFinancialTransferById(userId: string, eventId: string, withdrawalId: string) {
    await this.verifyOrganizerAccess(userId, eventId, 'financial');

    const prismaRead = this.prisma.getReadClient();

    const withdrawal = await prismaRead.eventWithdrawal.findUnique({
      where: { id: withdrawalId },
      select: {
        id: true,
        eventId: true,
        amount: true,
        feeRate: true,
        feeAmount: true,
        netAmount: true,
        status: true,
        notes: true,
        receiptUrl: true,
        createdAt: true,
        completedAt: true,
        event: {
          select: {
            organization: {
              select: {
                id: true,
                name: true,
                tradeName: true,
                document: true,
                email: true,
                phone: true,
                ownerName: true,
                bankName: true,
                bankCode: true,
                agency: true,
                account: true,
                accountType: true,
                accountHolderName: true,
                accountHolderDocument: true,
              },
            },
          },
        },
      },
    });

    if (!withdrawal || withdrawal.eventId !== eventId) {
      throw new NotFoundException('Transfer not found');
    }

    const { event, ...transferData } = withdrawal;

    return {
      message: 'Transfer fetched successfully',
      data: {
        transfer: transferData,
        organization: event.organization,
      },
    };
  }

  async getFinancialInstallments(userId: string, eventId: string) {
    await this.verifyOrganizerAccess(userId, eventId, 'financial');

    const prismaRead = this.prisma.getReadClient();
    const now = new Date();

    const [orders, audit, eventConfig] = await Promise.all([
      prismaRead.order.findMany({
        where: {
          eventId,
          payment: { status: PaymentStatus.PAID, method: PaymentMethod.CREDIT_CARD },
        },
        include: {
          payment: true,
          user: {
            select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true },
          },
        },
      }),
      prismaRead.eventAudit.findUnique({ where: { eventId } }),
      prismaRead.event.findUnique({ where: { id: eventId }, select: { organizerFeePercent: true } }),
    ]);

    const organizerFeeRate: number = (eventConfig?.organizerFeePercent ?? 0) / 100;
    const isAudited = !!audit;
    const installments: any[] = [];
    let totalPending = 0;

    for (const order of orders) {
      const payment = order.payment;
      if (!payment?.paymentDate) continue;

      const metadata = payment.metadata as any;
      const count: number = metadata?.creditCard?.installments;
      if (!count || count <= 1) continue;

      const paymentDate = new Date(payment.paymentDate);
      // serviceFee é da plataforma — sai antes de aplicar a taxa do organizador.
      const orgBase = Math.max(
        0,
        (order.finalAmount ?? 0) - (order.serviceFee ?? 0),
      );
      const netAmount = Math.round(orgBase * (1 - organizerFeeRate));
      const installmentValue = Math.round(netAmount / count);
      const lastInstallmentValue = netAmount - installmentValue * (count - 1);

      for (let i = 0; i < count; i++) {
        const dueDate = new Date(paymentDate);
        dueDate.setDate(dueDate.getDate() + 31 * (i + 1));

        if (dueDate <= now) continue; // parcela já vencida — fora da lista de "a receber"

        const isLast = i === count - 1;
        const amount = isLast ? lastInstallmentValue : installmentValue;

        installments.push({
          id: `${payment.id}-installment-${i + 1}`,
          orderId: order.id,
          paymentId: payment.id,
          installmentNumber: i + 1,
          totalInstallments: count,
          amount,
          dueDate: dueDate.toISOString(),
          isLastInstallment: isLast,
          retainedUntilAudit: isLast && !isAudited,
          buyer: order.user,
        });

        totalPending += amount;
      }
    }

    installments.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

    return {
      message: 'Installments fetched successfully',
      data: {
        installments,
        metrics: {
          totalPending,
          totalCount: installments.length,
        },
      },
    };
  }

  /**
   * Obtém valores aguardando liberação (baseado em prazo de retenção de 30 dias)
   */
  async getFinancialPending(userId: string, eventId: string, page: number = 1, limit: number = 20) {
    await this.verifyOrganizerAccess(userId, eventId, 'financial');

    const prismaRead = this.prisma.getReadClient();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Limitar o limit a 100
    const safeLimit = Math.min(limit, 100);
    const skip = (page - 1) * safeLimit;

    const eventConfig = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizerFeePercent: true },
    });
    const organizerFeeRate: number = (eventConfig?.organizerFeePercent ?? 0) / 100;

    // Buscar todos os pagamentos pagos do evento (agrupados por order para evitar duplicatas)
    const paidOrders = await prismaRead.order.findMany({
      where: {
        eventId,
        payment: {
          status: PaymentStatus.PAID,
        },
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            documentNumber: true,
          },
        },
        payment: true,
        registrations: {
          select: {
            id: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const allPending: any[] = [];
    let totalPending = 0;
    let releaseToday = 0;

    for (const order of paidOrders) {
      if (!order.payment?.paymentDate) continue;

      const paymentDate = new Date(order.payment.paymentDate);
      const releaseDate = new Date(paymentDate);
      const retentionDays = EventsService.RETENTION_DAYS[order.payment.method as string] ?? 31;
      releaseDate.setDate(releaseDate.getDate() + retentionDays);

      // Se ainda não passou do prazo de retenção, está aguardando liberação
      if (releaseDate > now) {
        const daysUntilRelease = Math.ceil((releaseDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        const isReleaseToday = releaseDate.toDateString() === today.toDateString();
        const orgBase = Math.max(
          0,
          (order.finalAmount || 0) - (order.serviceFee ?? 0),
        );
        const netAmount = Math.round(orgBase * (1 - organizerFeeRate));

        allPending.push({
          orderId: order.id,
          paymentId: order.payment.id,
          transactionId: order.payment.transactionId,
          amount: netAmount,
          paymentMethod: order.payment.method,
          purchaseDate: order.createdAt.toISOString(),
          paymentDate: order.payment.paymentDate.toISOString(),
          releaseDate: releaseDate.toISOString(),
          daysUntilRelease,
          buyer: order.user ? {
            id: order.user.id,
            firstName: order.user.firstName,
            lastName: order.user.lastName,
            fullName: `${order.user.firstName} ${order.user.lastName}`,
            email: order.user.email,
            phone: order.user.phone,
            documentNumber: order.user.documentNumber,
            avatarUrl: order.user.avatarUrl,
          } : null,
          billingAddress: this.resolveOrderBillingAddress(order, order.payment),
          registrationsCount: order.registrations.length,
        });

        totalPending += netAmount;
        if (isReleaseToday) {
          releaseToday += netAmount;
        }
      }
    }

    // Ordenar por data de compra (mais recentes primeiro)
    allPending.sort((a, b) => new Date(b.purchaseDate).getTime() - new Date(a.purchaseDate).getTime());

    // Aplicar paginação
    const totalOrders = allPending.length;
    const totalPages = Math.ceil(totalOrders / safeLimit);
    const paginatedPending = allPending.slice(skip, skip + safeLimit);

    return {
      message: 'Pending releases fetched successfully',
      data: {
        pending: paginatedPending,
        totalPending,
        releaseToday,
        pagination: {
          page,
          limit: safeLimit,
          totalOrders,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      },
    };
  }

  /**
   * Obtém lista de pagamentos estornados (refunded)
   */
  async getFinancialRefunded(userId: string, eventId: string, page: number = 1, limit: number = 20) {
    await this.verifyOrganizerAccess(userId, eventId, 'financial');

    const prismaRead = this.prisma.getReadClient();
    const skip = (page - 1) * limit;

    // Buscar todos os pagamentos estornados do evento
    const refundedRegistrations = await prismaRead.registration.findMany({
      where: {
        eventId,
        order: {
          payment: {
            status: PaymentStatus.REFUNDED,
          },
        },
      },
      include: {
        order: {
          include: {
            payment: {
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    avatarUrl: true,
                  },
                },
              },
            },
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                avatarUrl: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: limit,
    });

    // Filtrar apenas os que têm refundType: 'REFUND' no metadata
    const refunded = refundedRegistrations
      .filter((reg) => {
        const metadata = reg.order?.payment?.metadata as any;
        return metadata?.refundType === 'REFUND' || (!metadata?.refundType && reg.order?.payment?.status === PaymentStatus.REFUNDED);
      })
      .map((reg) => {
        const metadata = reg.order?.payment?.metadata as any;
        return {
          id: reg.order?.payment?.id,
          orderId: reg.orderId,
          registrationId: reg.id,
          amount: this.normalizeToCents(reg.order?.finalAmount),
          refundDate: reg.order?.payment?.updatedAt || reg.order?.payment?.paymentDate || reg.order?.createdAt,
          purchaseDate: reg.order?.createdAt,
          paymentMethod: reg.order?.payment?.method,
          buyer: reg.order?.user ? {
            id: reg.order.user.id,
            firstName: reg.order.user.firstName,
            lastName: reg.order.user.lastName,
            email: reg.order.user.email,
            avatarUrl: reg.order.user.avatarUrl,
          } : null,
          participant: reg.user ? {
            id: reg.user.id,
            firstName: reg.user.firstName,
            lastName: reg.user.lastName,
            email: reg.user.email,
            avatarUrl: reg.user.avatarUrl,
          } : null,
          reason: metadata?.reason || 'Estorno solicitado pelo cliente',
        };
      });

    // Contar total para paginação
    const totalRefunded = await prismaRead.registration.count({
      where: {
        eventId,
        order: {
          payment: {
            status: PaymentStatus.REFUNDED,
          },
        },
      },
    });

    const totalAmount = refunded.reduce((sum, r) => sum + r.amount, 0);

    return {
      message: 'Refunded payments fetched successfully',
      data: {
        refunded,
        pagination: {
          page,
          limit,
          total: totalRefunded,
          totalPages: Math.ceil(totalRefunded / limit),
        },
        totalAmount,
      },
    };
  }

  /**
   * Obtém lista de chargebacks
   */
  async getFinancialChargebacks(userId: string, eventId: string, page: number = 1, limit: number = 20) {
    await this.verifyOrganizerAccess(userId, eventId, 'financial');

    const prismaRead = this.prisma.getReadClient();
    const skip = (page - 1) * limit;

    // Buscar todos os pagamentos com chargeback do evento
    const chargebackRegistrations = await prismaRead.registration.findMany({
      where: {
        eventId,
        order: {
          payment: {
            status: PaymentStatus.REFUNDED,
          },
        },
      },
      include: {
        order: {
          include: {
            payment: {
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    avatarUrl: true,
                  },
                },
              },
            },
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                avatarUrl: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: limit,
    });

    // Filtrar apenas os que têm refundType: 'CHARGEBACK' no metadata
    const chargebacks = chargebackRegistrations
      .filter((reg) => {
        const metadata = reg.order?.payment?.metadata as any;
        return metadata?.refundType === 'CHARGEBACK';
      })
      .map((reg) => {
        const metadata = reg.order?.payment?.metadata as any;
        return {
          id: reg.order?.payment?.id,
          orderId: reg.orderId,
          registrationId: reg.id,
          amount: this.normalizeToCents(reg.order?.finalAmount),
          chargebackDate: reg.order?.payment?.updatedAt || reg.order?.payment?.paymentDate || reg.order?.createdAt,
          purchaseDate: reg.order?.createdAt,
          paymentMethod: reg.order?.payment?.method,
          buyer: reg.order?.user ? {
            id: reg.order.user.id,
            firstName: reg.order.user.firstName,
            lastName: reg.order.user.lastName,
            email: reg.order.user.email,
            avatarUrl: reg.order.user.avatarUrl,
          } : null,
          participant: reg.user ? {
            id: reg.user.id,
            firstName: reg.user.firstName,
            lastName: reg.user.lastName,
            email: reg.user.email,
            avatarUrl: reg.user.avatarUrl,
          } : null,
          reason: metadata?.reason || 'Chargeback solicitado pelo banco',
        };
      });

    // Contar total para paginação
    // Buscar todos os refunded e filtrar por metadata no código (Prisma não suporta filtro JSON complexo)
    const allRefundedRegistrations = await prismaRead.registration.findMany({
      where: {
        eventId,
        order: {
          payment: {
            status: PaymentStatus.REFUNDED,
          },
        },
      },
      include: {
        order: {
          include: {
            payment: true,
          },
        },
      },
    });

    const totalChargebacks = allRefundedRegistrations.filter((reg) => {
      const metadata = reg.order?.payment?.metadata as any;
      return metadata?.refundType === 'CHARGEBACK';
    }).length;

    const totalAmount = chargebacks.reduce((sum, c) => sum + c.amount, 0);

    return {
      message: 'Chargebacks fetched successfully',
      data: {
        chargebacks,
        pagination: {
          page,
          limit,
          total: totalChargebacks,
          totalPages: Math.ceil(totalChargebacks / limit),
        },
        totalAmount,
      },
    };
  }

  /**
   * Fetch all registrations for a given event (no pagination) for export purposes.
   * Caller must already have organizer access verified.
   */
  async getRegistrationsForExport(
    userId: string,
    eventId: string,
    filters?: {
      search?: string;
      status?: string;
      ticketIds?: string[];
      startDate?: string;
      endDate?: string;
    },
  ): Promise<{ registrations: any[]; eventName: string }> {
    await this.verifyOrganizerAccess(userId, eventId, 'dashboard');

    const prismaRead = this.prisma.getReadClient();

    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { name: true },
    });
    const eventName = event?.name ?? 'Evento';

    const includeClause = {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          documentNumber: true,
          dateOfBirth: true,
          gender: true,
          avatarUrl: true,
        },
      },
      tickets: {
        include: {
          ticket: {
            include: {
              category: { select: { id: true, name: true } },
            },
          },
          batch: { select: { id: true, price: true } },
        },
      },
      products: {
        include: {
          product: { select: { id: true, name: true } },
          variation: { select: { id: true, name: true } },
        },
      },
      questionAnswers: {
        include: {
          question: { select: { id: true, question: true, type: true } },
        },
      },
      order: {
        include: {
          payment: {
            select: {
              id: true,
              status: true,
              method: true,
              amount: true,
              paymentDate: true,
              createdAt: true,
            },
          },
          user: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      },
    };

    const where: any = {
      eventId,
      status: filters?.status && filters.status !== 'all'
        ? (filters.status as any)
        : { not: 'PENDING' as any },
    };

    if (filters?.ticketIds?.length) {
      where.tickets = { some: { ticketId: { in: filters.ticketIds } } };
    }

    if (filters?.startDate || filters?.endDate) {
      where.order = { createdAt: {} };
      if (filters.startDate) where.order.createdAt.gte = new Date(filters.startDate);
      if (filters.endDate) where.order.createdAt.lte = new Date(filters.endDate);
    }

    if (filters?.search) {
      const searchTerm = filters.search;
      const uuidMatches = await prismaRead.$queryRaw<{ id: string }[]>`
        SELECT r.id FROM "Registration" r
        JOIN "Order" o ON o.id = r."orderId"
        WHERE r."eventId" = ${eventId}::uuid
          AND (r.id::text ILIKE ${'%' + searchTerm + '%'} OR o.id::text ILIKE ${'%' + searchTerm + '%'})
      `;
      const uuidMatchIds = uuidMatches.map((row: any) => row.id);
      where.OR = [
        ...(uuidMatchIds.length > 0 ? [{ id: { in: uuidMatchIds } }] : []),
        {
          user: {
            OR: [
              { firstName: { contains: searchTerm, mode: 'insensitive' } },
              { lastName: { contains: searchTerm, mode: 'insensitive' } },
              { email: { contains: searchTerm, mode: 'insensitive' } },
              { documentNumber: { contains: searchTerm, mode: 'insensitive' } },
            ],
          },
        },
        { participantName: { contains: searchTerm, mode: 'insensitive' } },
        { participantEmail: { contains: searchTerm, mode: 'insensitive' } },
        { participantCpf: { contains: searchTerm, mode: 'insensitive' } },
      ];
    }

    const registrations = await prismaRead.registration.findMany({
      where,
      include: includeClause,
      orderBy: [{ order: { createdAt: 'desc' } }, { id: 'asc' }],
    });

    const mapped = registrations.map((reg: any) => {
      const u = reg.user;
      const participant = u ?? {
        id: null,
        firstName: (reg.participantName ?? '').split(' ')[0] ?? '',
        lastName: (reg.participantName ?? '').split(' ').slice(1).join(' ') ?? '',
        email: reg.participantEmail ?? null,
        phone: reg.participantPhone ?? null,
        documentNumber: reg.participantCpf ?? null,
        dateOfBirth: null,
        gender: null,
        avatarUrl: null,
      };

      const order = reg.order ?? {};
      const billingAddress = this.resolveOrderBillingAddress(order, order.payment);

      return {
        id: reg.id,
        status: reg.status,
        user: participant,
        emergencyContact: {
          name: reg.emergencyContactName ?? null,
          phone: reg.emergencyContactPhone ?? null,
        },
        ticket: reg.tickets?.[0]
          ? (() => {
            const rt = reg.tickets[0];
            const snap = rt.ticketSnapshot as Record<string, any> | null;
            const t = rt.ticket;
            return {
              name: snap?.name ?? t?.name ?? '',
              modality: snap?.modality ?? t?.modality ?? '',
              distance: snap?.distance ?? t?.distance ?? null,
              distanceUnit: snap?.distanceUnit ?? t?.distanceUnit ?? null,
              category: snap?.category ?? (t?.category ? t.category : null),
            };
          })()
          : null,
        products: (reg.products ?? []).map((rp: any) => {
          const snap = rp.productSnapshot as Record<string, any> | null;
          return {
            product: { name: snap?.name ?? rp.product?.name ?? '' },
            variationName: snap?.selectedVariation?.name ?? rp.variation?.name ?? null,
          };
        }),
        questionAnswers: (reg.questionAnswers ?? []).map((qa: any) => {
          const qSnap = qa.questionSnapshot as Record<string, any> | null;
          return {
            question: { question: qSnap?.question ?? qa.question?.question ?? '' },
            answer: qa.answer ?? '',
          };
        }),
        order: {
          finalAmount: order.finalAmount ? this.normalizeToCents(order.finalAmount) : null,
          purchaseDate: order.createdAt ?? null,
          billingAddress,
          payment: order.payment
            ? {
              status: order.payment.status,
              method: order.payment.method,
              paymentDate: order.payment.paymentDate,
              createdAt: order.payment.createdAt,
            }
            : null,
        },
      };
    });

    return { registrations: mapped, eventName };
  }
}
