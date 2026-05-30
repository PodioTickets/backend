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
import { FinancialQueryDto, FinancialPeriod, PaymentMethodStats } from './dto/financial.dto';
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
import { TicketCategoriesService } from '../ticket-categories/ticket-categories.service';
import { EmailService } from '../../common/services/email.service';
import { RepasseService } from '../repasse/repasse.service';
import { CacheRedisService } from '../../common/services/cache-redis.service';
import { isChargeback, resolveOrderOrganizerFeePercent } from '../../common/utils/refund.util';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizerMemberAccess: OrganizerMemberAccessService,
    private readonly organizationsService: OrganizationsService,
    private readonly ticketsService: TicketsService,
    private readonly ticketCategoriesService: TicketCategoriesService,
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

    // Catálogo público: oculta eventos cuja realização passou de 1 mês — mesma
    // regra de `findAll`. Aplicado via AND para sobrepor qualquer startDate
    // anterior ao cutoff (includePast=true ou janela customizada não devem
    // burlar a regra).
    const eventDateCutoff = new Date();
    eventDateCutoff.setMonth(eventDateCutoff.getMonth() - 1);

    return {
      AND: [
        { eventDate: { gte: eventDateCutoff } },
        where,
      ],
    };
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
              tradeName: true, // Nome fantasia — mesmo formato de /organizations/me
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

    // Retornar todos os eventos (futuros e passados recentes). Eventos cuja realização
    // passou de 1 mês são ocultados do catálogo público (sem valor para o usuário e
    // sem inscrições). A condição é injetada no `whereFinal` (AND de topo) mais abaixo
    // para coexistir de forma segura com filtros opcionais de janela
    // (thisWeek/thisMonth/startDate-endDate) que reescrevem `where.eventDate`/`where.AND`.

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

    // Cutoff: oculta eventos cuja realização passou de 1 mês (regra do catálogo público).
    const eventDateCutoff = new Date();
    eventDateCutoff.setMonth(eventDateCutoff.getMonth() - 1);

    const whereFinal: Prisma.EventWhereInput = {
      AND: [
        { status: { not: EventStatus.SUSPENDED } },
        { eventDate: { gte: eventDateCutoff } },
        where,
      ],
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
              tradeName: true, // Nome fantasia — mesmo formato de /organizations/me
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

  // ── Seleção pública enxuta (compartilhada por /events/:id e /events/slug/:slug) ──
  // SOMENTE os campos consumidos pelo front público/checkout. Campos internos — taxas
  // (organizerFeePercent/retentionRate), tracking de ads, e dados sensíveis da organização
  // (bancários/documentos/endereço/owner) — NÃO entram no contrato público. Organizador/admin
  // recebem o payload completo por um caminho separado (build*PrivilegedEvent*).
  private static readonly PUBLIC_EVENT_SCALAR_SELECT = {
    id: true,
    name: true,
    slug: true,
    bannerUrl: true,
    location: true,
    city: true,
    state: true,
    neighborhood: true,
    zipCode: true,
    googleMapsLink: true,
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
    participantFeePercent: true,
    maxInstallments: true,
    kitSelectionDisplay: true,
    // IDs de tracking: públicos por natureza (disparam no browser do visitante).
    // Reagrupados em `tracking` por `withTracking` — não vão crus no topo do evento.
    metaPixelId: true,
    googleAnalyticsId: true,
    googleAdsId: true,
  } as const;

  /** Seleção pública: escalares usados + organização enxuta + tópicos enxutos. */
  private publicEventSelect(): Prisma.EventSelect {
    return {
      ...EventsService.PUBLIC_EVENT_SCALAR_SELECT,
      // Organização: só o que a página pública/checkout lê (getEventOrganizer).
      // Fecha o vazamento de dados bancários/documentos/endereço da org.
      organization: {
        select: {
          id: true,
          name: true,
          tradeName: true,
          logoUrl: true,
          email: true,
          phone: true,
          description: true,
        },
      },
      topics: {
        where: { isEnabled: true },
        orderBy: { order: 'asc' },
        select: {
          id: true,
          title: true,
          content: true,
          isEnabled: true,
          order: true,
          isDefault: true,
        },
      },
    };
  }

  /**
   * Agrupa os IDs de tracking (Meta Pixel / GA / Google Ads) num objeto `tracking` e
   * REMOVE as chaves cruas do topo do evento. Usado no caminho público (que seleciona
   * os 3 campos). Mesma shape do endpoint dedicado `getAdsTracking`. Pixels são públicos
   * por natureza (disparam client-side); chaves vazias somem pelo strip global do response.
   */
  private withTracking(event: any) {
    const { metaPixelId, googleAnalyticsId, googleAdsId, ...rest } = event;
    return {
      ...rest,
      tracking: this.eventToAdsTrackingPayload({
        metaPixelId: metaPixelId ?? null,
        googleAnalyticsId: googleAnalyticsId ?? null,
        googleAdsId: googleAdsId ?? null,
      }),
    };
  }

  async findOne(id: string, userId?: string) {
    this.validateUUID(id, 'event ID');
    const prismaRead = this.prisma.getReadClient();

    // Organizador/admin autenticado → payload COMPLETO (comportamento histórico, com
    // organização inteira + owner + perguntas + registrationsCount). Demais (anônimo ou
    // usuário comum) → contrato público enxuto. A decisão é por CALLER, não por rota.
    if (userId) {
      const base = await prismaRead.event.findUnique({
        where: { id },
        select: { id: true, organizationId: true },
      });
      if (!base) throw new NotFoundException('Evento não encontrado');
      if (await this.isOrganizerCallerForEvent(userId, base.organizationId, id)) {
        return this.buildPrivilegedEventById(id);
      }
    }

    // Caminho público — cacheável (mesmo payload p/ todos os não-privilegiados).
    // Cache curto (30s), invalidado no update/delete. Fail-open se Redis off.
    const cacheKey = this.eventCacheKeyById(id);
    const cached = await this.cache.getJson<{ message: string; data: { event: Record<string, unknown> } }>(cacheKey);
    if (cached) return cached;

    const event = await prismaRead.event.findUnique({
      where: { id },
      select: {
        ...this.publicEventSelect(),
        // Dashboards consomem só a CONTAGEM de perguntas; o array completo fica no
        // payload do organizador. `event._count.questions` substitui `event.questions.length`.
        _count: { select: { questions: true } },
      },
    });
    if (!event) throw new NotFoundException('Evento não encontrado');

    const response = {
      message: 'Event fetched successfully',
      data: { event: this.withTracking(event) },
    };
    await this.cache.setJson(cacheKey, response, EventsService.EVENT_CACHE_TTL_SECONDS);
    return response;
  }

  /**
   * Payload COMPLETO de evento por id — somente organizador/admin. Mantém o contrato
   * histórico (organização inteira + owner + tópicos + perguntas + `registrationsCount`),
   * continuando a remover taxas internas/tracking via `stripPublicEventForSlug`.
   */
  private async buildPrivilegedEventById(id: string) {
    const prismaRead = this.prisma.getReadClient();
    const event = await prismaRead.event.findUnique({
      where: { id },
      include: {
        organization: {
          include: {
            members: {
              where: { role: 'OWNER' },
              include: { user: { select: { id: true, firstName: true, lastName: true } } },
              take: 1,
            },
          },
        },
        topics: { where: { isEnabled: true }, orderBy: { order: 'asc' } },
        questions: { orderBy: { order: 'asc' } },
        _count: { select: { questions: true } },
      },
    });
    if (!event) throw new NotFoundException('Evento não encontrado');

    const registrationsCount = await prismaRead.registration.count({
      where: { eventId: id, status: RegistrationStatus.CONFIRMED },
    });

    // `tracking` calculado do evento cru (o strip abaixo remove as chaves cruas).
    const tracking = this.eventToAdsTrackingPayload(event as any);
    const eventPublic = this.stripPublicEventForSlug(
      event as unknown as Record<string, unknown>,
    );
    return {
      message: 'Event fetched successfully',
      data: { event: { ...eventPublic, tracking, registrationsCount } },
    };
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

  async findBySlug(slug: string, userId?: string) {
    if (!slug || slug.trim().length === 0) {
      throw new BadRequestException('Slug is required');
    }
    const prismaRead = this.prisma.getReadClient();

    // Organizador/admin → payload COMPLETO (catálogo aninhado + organização inteira).
    // Demais → contrato público enxuto (sem catálogo, organização enxuta, sem owner/perguntas).
    if (userId) {
      const base = await prismaRead.event.findUnique({
        where: { slug },
        select: { id: true, organizationId: true },
      });
      if (!base) throw new NotFoundException('Evento não encontrado');
      if (await this.isOrganizerCallerForEvent(userId, base.organizationId, base.id)) {
        return this.buildPrivilegedEventBySlug(slug);
      }
    }

    return this.buildPublicEventBySlug(slug);
  }

  /**
   * Payload público enxuto por slug: escalares usados + organização enxuta + tópicos +
   * `hasRegistrationSlotsAvailable`. NÃO inclui o catálogo (tickets/categorias/produtos) —
   * o checkout busca isso em endpoints dedicados (getTickets/getProducts). Os ingressos
   * são lidos apenas internamente (enxutos) para o cálculo de vagas; não vão na resposta.
   * Elimina os JOINs profundos do caminho público (maior fatia do tráfego).
   */
  private async buildPublicEventBySlug(slug: string) {
    const prismaRead = this.prisma.getReadClient();

    const event: any = await prismaRead.event.findUnique({
      where: { slug },
      select: this.publicEventSelect(),
    });
    if (!event) throw new NotFoundException('Evento não encontrado');

    const now = new Date();
    const eventDate = new Date(event.eventDate);
    const status = eventDate < now ? EventStatus.COMPLETED : event.status;

    // Ingressos enxutos SÓ para o cálculo de vagas (não retornados ao cliente).
    const ticketsForSlots = await prismaRead.ticket.findMany({
      where: { eventId: event.id, isActive: true },
      select: {
        id: true,
        batches: { select: { id: true, quantity: true, startDate: true, endDate: true } },
      },
    });

    const hasRegistrationSlotsAvailable =
      await this.computeHasRegistrationSlotsAvailable(
        prismaRead,
        status,
        eventDate,
        ticketsForSlots,
      );

    return {
      message: 'Event fetched successfully',
      data: { event: { ...this.withTracking(event), status, hasRegistrationSlotsAvailable } },
    };
  }

  /**
   * Payload COMPLETO por slug — somente organizador/admin. Catálogo aninhado + organização
   * inteira (comportamento histórico). Duas queries pra evitar o mesmo ingresso ser carregado
   * duas vezes (raiz + por categoria), o que gerava JOIN explosivo e timeout no proxy.
   */
  private async buildPrivilegedEventBySlug(slug: string) {
    const prismaRead = this.prisma.getReadClient();

    const eventBase = await prismaRead.event.findUnique({
      where: { slug },
      include: {
        organization: {
          include: {
            members: {
              where: { role: 'OWNER' },
              include: {
                user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
              },
            },
          },
        },
        topics: { where: { isEnabled: true }, orderBy: { order: 'asc' } },
        questions: { orderBy: { order: 'asc' } },
        ticketCategories: { orderBy: { order: 'asc' } },
        products: {
          include: { variations: { orderBy: { name: 'asc' } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!eventBase) throw new NotFoundException('Evento não encontrado');

    const tickets = await prismaRead.ticket.findMany({
      where: { eventId: eventBase.id, isActive: true },
      include: {
        batches: { orderBy: { price: 'asc' } },
        products: {
          orderBy: { sortOrder: 'asc' },
          include: { product: { include: { variations: true } } },
        },
        category: true,
        kit: { include: { items: { include: { product: true } } } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const ticketSortCmp = (a: (typeof tickets)[0], b: (typeof tickets)[0]): number =>
      a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime();

    const ticketCategories = eventBase.ticketCategories.map((cat) => ({
      ...cat,
      tickets: tickets.filter((t) => t.categoryId === cat.id).sort(ticketSortCmp),
    }));

    const ticketsOrdered = [
      ...eventBase.ticketCategories.flatMap((cat) =>
        tickets.filter((t) => t.categoryId === cat.id).sort(ticketSortCmp),
      ),
      ...tickets.filter((t) => !t.categoryId).sort(ticketSortCmp),
    ];

    const event = { ...eventBase, ticketCategories, tickets: ticketsOrdered };

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

    const tracking = this.eventToAdsTrackingPayload(eventToReturn as any);
    const eventPublic = this.stripPublicEventForSlug(
      eventToReturn as unknown as Record<string, unknown>,
    );

    return {
      message: 'Event fetched successfully',
      data: { event: { ...eventPublic, tracking, hasRegistrationSlotsAvailable } },
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
   * Sanitiza o payload do evento para resposta pública por slug/id.
   * Remove:
   *  - IDs de tracking de anúncios (Meta/GA/Ads) — não pertencem ao contrato público.
   *  - `organizerFeePercent` e `retentionRate` — taxas internas (Podio↔organizador)
   *    que o participante não deve conhecer.
   *
   * `participantFeePercent` é PRESERVADO: o participante paga essa taxa e ela já
   * compõe o total exibido no checkout — o front precisa do valor para mostrar
   * o breakdown antes de chamar o pagamento.
   */
  private stripPublicEventForSlug<E extends Record<string, unknown>>(event: E): E {
    const {
      metaPixelId: _mp,
      googleAnalyticsId: _ga,
      googleAdsId: _gad,
      organizerFeePercent: _ofp,
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
        // Alíquota EFETIVA: snapshot do pagamento com fallback ao vivo do evento.
        total += Math.round(
          orgBase * (1 - resolveOrderOrganizerFeePercent(r.order, eventConfig?.organizerFeePercent ?? 0) / 100),
        );
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

  // Dashboard removido — agora vive em DashboardService (overview/rankings/secondary).

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
   *
   * Obtém dados financeiros do evento
   *
   * Delega o cálculo do breakdown para RepasseService.computeBreakdownForEvent
   * para garantir consistência com a UI de repasse (mesma lógica de retenção,
   * estornos priorizados e recuperação de saldo negativo).
   */
  async getFinancial(userId: string, eventId: string, queryDto: FinancialQueryDto) {
    await this.verifyOrganizerAccess(userId, eventId, 'financial');

    const { page = 1, limit = 20, period } = queryDto;

    const [
      { breakdown, audit, paidOrders, refundedOrders, completedWithdrawalsTotal, organizerFeePercent },
      tickets,
    ] = await Promise.all([
      this.repasseService.computeBreakdownForEvent(eventId),
      this.ticketsService.findAll(eventId, { page, limit, includeInactive: true }),
    ]);

    // Separa refunds "comuns" (estorno via admin) de chargebacks (reversão pelo emissor/painel Cielo).
    // Convenção do projeto (alinhada com queryRegistrationIdsPageForRefundedMetadataFilter):
    //   - CHARGEBACK: metadata.refundType === 'CHARGEBACK'
    //   - REFUND:     metadata.refundType ∈ {'REFUND', null, '', undefined}
    // Classificação ÚNICA (common/utils/refund.util): chargeback = refundType==='CHARGEBACK'.
    let totalRefunded = 0;
    let refundedCount = 0;
    let totalChargebacks = 0;
    let chargebackCount = 0;
    for (const o of refundedOrders) {
      const amount = o.finalAmount ?? 0;
      if (isChargeback(o.payment?.metadata)) {
        totalChargebacks += amount;
        chargebackCount += 1;
      } else {
        totalRefunded += amount;
        refundedCount += 1;
      }
    }

    const dateRange = period
      ? this.calculateFinancialDateRange(period)
      : { start: null, end: null };

    const paymentMethodStats = this.computePaymentMethodStats(
      paidOrders,
      refundedOrders,
      organizerFeePercent,
      dateRange,
    );

    return {
      message: 'Financial data fetched successfully',
      data: {
        summary: {
          // Mapeia nomes do RepasseService → contrato existente do EventsService.getFinancial.
          // availableBalance pode ser NEGATIVO em caso de estorno sem saldo suficiente —
          // alinhado com a nova regra do calcBreakdown (saldo permanece negativo até nova
          // receita compensar, sem recovery do aguardando/retido).
          availableBalance: breakdown.saldoParaSaque,
          pendingRelease: breakdown.aguardandoLiberacao,
          awaitingAudit: breakdown.valorRetido,
          installmentsToReceive: breakdown.parceladosAReceber,
          grossRevenue: breakdown.grossRevenue,
          totalWithdrawn: completedWithdrawalsTotal,
          totalRefunded,
          refundedCount,
          totalChargebacks,
          chargebackCount,
          isAudited: !!audit,
          paymentMethodStats,
        },
        tickets,
      },
    };
  }

  /**
   * Agrega vendas e receita líquida por método de pagamento (PIX/CRÉDITO/DÉBITO).
   *
   * - `sales`: contagem de pagamentos PAID com `paymentDate` dentro do período.
   * - `netRevenue` (em centavos): soma do `orgNet` (mesma fórmula do `calcBreakdown`)
   *    dos PAID no período, menos o `orgNet` dos REFUNDED cujo refund ocorreu no período
   *    (`payment.updatedAt`, alinhado com `getFinancialRefunded`). Pode ficar negativo —
   *    o front exibe com sinal.
   *
   * BOLETO/CRYPTO são ignorados (não exibidos no card; estender chaves no front quando precisar).
   *
   * Performance: O(n) em memória sobre as listas já carregadas pelo RepasseService —
   * zero query adicional. Em eventos com milhares de pedidos pagos, ainda é desprezível
   * comparado ao custo da query original.
   */
  private computePaymentMethodStats(
    paidOrders: any[],
    refundedOrders: any[],
    organizerFeePercent: number,
    dateRange: { start: Date | null; end: Date | null },
  ): PaymentMethodStats {
    const methodToKey: Partial<Record<PaymentMethod, keyof PaymentMethodStats>> = {
      [PaymentMethod.PIX]: 'pix',
      [PaymentMethod.CREDIT_CARD]: 'creditCard',
      [PaymentMethod.DEBIT_CARD]: 'debitCard',
    };

    const stats: PaymentMethodStats = {
      pix: { sales: 0, netRevenue: 0 },
      creditCard: { sales: 0, netRevenue: 0 },
      debitCard: { sales: 0, netRevenue: 0 },
    };

    const startMs = dateRange.start ? dateRange.start.getTime() : null;
    const endMs = dateRange.end ? dateRange.end.getTime() : null;
    const inRange = (d: Date | string | null | undefined) => {
      if (!d) return false;
      const t = new Date(d).getTime();
      if (Number.isNaN(t)) return false;
      if (startMs !== null && t < startMs) return false;
      if (endMs !== null && t > endMs) return false;
      return true;
    };

    const orgNetOf = (order: any) => {
      const gross = order.finalAmount ?? 0;
      const participantFee = order.serviceFee ?? 0;
      const organizerBase = Math.max(0, gross - participantFee);
      // Alíquota EFETIVA: snapshot do pagamento com fallback ao vivo (param = % do evento).
      const effPercent = resolveOrderOrganizerFeePercent(order, organizerFeePercent);
      return Math.round(organizerBase * (1 - effPercent / 100));
    };

    for (const order of paidOrders) {
      const method = order.payment?.method as PaymentMethod | undefined;
      const key = method ? methodToKey[method] : undefined;
      if (!key) continue;
      if (!inRange(order.payment?.paymentDate)) continue;
      stats[key].sales += 1;
      stats[key].netRevenue += orgNetOf(order);
    }

    for (const order of refundedOrders) {
      const method = order.payment?.method as PaymentMethod | undefined;
      const key = method ? methodToKey[method] : undefined;
      if (!key) continue;
      // Data do refund = transição PAID→REFUNDED; mesma convenção do getFinancialRefunded.
      if (!inRange(order.payment?.updatedAt)) continue;
      stats[key].netRevenue -= orgNetOf(order);
    }

    return stats;
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
    refunded: number;
    collected: number;
  }> {
    const upperBoundSql =
      orderCreatedBetween?.lt !== undefined
        ? Prisma.sql`AND o."createdAt" < ${orderCreatedBetween.lt}`
        : orderCreatedBetween?.lte !== undefined
          ? Prisma.sql`AND o."createdAt" <= ${orderCreatedBetween.lte}`
          : Prisma.empty;

    // collected: somado por order única (DISTINCT no CTE evita double-count quando
    // a order tem múltiplas inscrições) e LÍQUIDO para o organizador:
    //   `(finalAmount - serviceFee) * (1 - organizerFeePercent/100)`
    // serviceFee = taxa do participante (100% plataforma). organizerFeePercent vem do Event.
    //
    // refunded: contagem por inscrição agrupando estornos manuais (refundType=REFUND/vazio)
    // e chargebacks (refundType=CHARGEBACK). Frontend pode distinguir cada caso via
    // payment.metadata->>'refundType' nos itens da listagem.
    const rows = orderCreatedBetween
      ? await prismaRead.$queryRaw<
        {
          total: bigint;
          paid: bigint;
          cancelled: bigint;
          refunded: bigint;
          collected: bigint;
        }[]
      >(Prisma.sql`
          WITH paid_orders AS (
            SELECT DISTINCT r."orderId",
              GREATEST(0, o."finalAmount" - COALESCE(o."serviceFee", 0))::numeric
                * (1 - COALESCE(o."organizerFeePercent", e."organizerFeePercent", 0)::numeric / 100) AS "netCents"
            FROM "Registration" r
            INNER JOIN "Order" o ON o.id = r."orderId"
            INNER JOIN "Event" e ON e.id = o."eventId"
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
            COUNT(*) FILTER (WHERE p.status::text = 'REFUNDED')::bigint AS refunded,
            COALESCE((SELECT SUM(ROUND("netCents")) FROM paid_orders), 0)::bigint AS collected
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
          refunded: bigint;
          collected: bigint;
        }[]
      >(Prisma.sql`
          WITH paid_orders AS (
            SELECT DISTINCT r."orderId",
              GREATEST(0, o."finalAmount" - COALESCE(o."serviceFee", 0))::numeric
                * (1 - COALESCE(o."organizerFeePercent", e."organizerFeePercent", 0)::numeric / 100) AS "netCents"
            FROM "Registration" r
            INNER JOIN "Order" o ON o.id = r."orderId"
            INNER JOIN "Event" e ON e.id = o."eventId"
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
            COUNT(*) FILTER (WHERE p.status::text = 'REFUNDED')::bigint AS refunded,
            COALESCE((SELECT SUM(ROUND("netCents")) FROM paid_orders), 0)::bigint AS collected
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
      refunded: Number(row?.refunded ?? 0),
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
    refundedChange: number;
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
      refundedChange: pct(thisWeek.refunded, prevWeek.refunded),
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
    const refunded = stats.refunded;
    const totalCollected = this.normalizeToCents(stats.collected);

    const { totalChange, paidChange, cancelledChange, refundedChange, totalCollectedChange } = wowChanges;

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
          refunded,
          totalCollected,
          totalChange,
          paidChange,
          cancelledChange,
          refundedChange,
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
    const refunded = stats.refunded;
    const totalCollected = this.normalizeToCents(stats.collected);

    const { totalChange, paidChange, cancelledChange, refundedChange, totalCollectedChange } = wowChanges;

    return {
      message: 'Registration stats fetched successfully',
      data: {
        total: stats.total,
        paid,
        cancelled,
        refunded,
        totalCollected,
        totalChange,
        paidChange,
        cancelledChange,
        refundedChange,
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
        pixKeyId: true,
        pixKeySnapshot: true,
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
        pixKeyId: true,
        pixKeySnapshot: true,
        // Mantém a chave atual também (UI pode mostrar "chave foi alterada" se diferir do snapshot).
        pixKey: {
          select: {
            id: true,
            key: true,
            keyType: true,
            bankName: true,
            accountHolderName: true,
            accountHolderDocument: true,
          },
        },
        event: {
          select: {
            organization: {
              select: {
                id: true,
                name: true,
                tradeName: true,
                document: true,
                email: true,
                fiscalEmail: true,
                phone: true,
                ownerName: true,
                ownerDocument: true,
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
      // Alíquota EFETIVA: snapshot do pagamento com fallback ao vivo do evento.
      const netAmount = Math.round(
        orgBase * (1 - resolveOrderOrganizerFeePercent(order, eventConfig?.organizerFeePercent ?? 0) / 100),
      );
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
        // Alíquota EFETIVA: snapshot do pagamento com fallback ao vivo do evento.
        const netAmount = Math.round(
          orgBase * (1 - resolveOrderOrganizerFeePercent(order, eventConfig?.organizerFeePercent ?? 0) / 100),
        );

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
          // O estorno grava `refundReason`; mantém fallback p/ `reason` (legados).
          reason: metadata?.refundReason || metadata?.reason || 'Estorno solicitado pelo cliente',
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

    // Soma por ORDER única — `finalAmount` se repete por inscrição no mesmo pedido;
    // somar por registration triplicava o total em pedidos multi-ingresso.
    const seenOrders = new Set<string>();
    let totalAmount = 0;
    for (const r of refunded) {
      if (r.orderId && !seenOrders.has(r.orderId)) {
        seenOrders.add(r.orderId);
        totalAmount += r.amount;
      }
    }

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
          reason: metadata?.refundReason || metadata?.reason || 'Chargeback solicitado pelo banco',
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

    // Soma por ORDER única (evita inflar o total em pedidos multi-ingresso).
    const seenOrders = new Set<string>();
    let totalAmount = 0;
    for (const c of chargebacks) {
      if (c.orderId && !seenOrders.has(c.orderId)) {
        seenOrders.add(c.orderId);
        totalAmount += c.amount;
      }
    }

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
          documentType: true,
          country: true,
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

  /**
   * Bundle agregado para a página de gerenciamento de ingressos:
   *   GET /api/v1/events/:eventId/tickets-management
   *
   * Substitui 3 round-trips HTTP (event + categories + tickets) por 1.
   * Reaproveita 100% da lógica existente em `TicketsService.findAll`
   * (cálculo de activeBatch, produtos, ageLimit, soldOut, etc.) e
   * `TicketCategoriesService.findAll`.
   *
   * Auth: requer permissão `edit_event` sobre o evento (admin bypassa).
   * As 3 leituras rodam em paralelo via `Promise.all` — o tempo total é o
   * da mais lenta. O TicketsService.findAll já tem cache Redis (TTL 15s).
   */
  async getTicketsManagementBundle(
    userId: string,
    eventId: string,
    opts: { ticketsPage?: number; ticketsLimit?: number; baseUrl?: string } = {},
  ) {
    // 1. Permissão — lança 404 se evento não existir, 403 se sem acesso.
    await this.organizerMemberAccess.assertCanAccessEvent(
      userId,
      eventId,
      'edit_event',
    );

    const prismaRead = this.prisma.getReadClient();
    const ticketsPage = opts.ticketsPage ?? 1;
    const ticketsLimit = opts.ticketsLimit ?? 500;

    // 2. Despachar as 3 leituras em paralelo.
    const [event, categoriesResp, ticketsResp] = await Promise.all([
      prismaRead.event.findUnique({
        where: { id: eventId },
        select: {
          id: true,
          name: true,
          slug: true,
          kitSelectionDisplay: true,
        },
      }),
      this.ticketCategoriesService.findAll(eventId),
      this.ticketsService.findAll(
        eventId,
        {
          page: ticketsPage,
          limit: ticketsLimit,
        },
        opts.baseUrl,
        userId,
      ),
    ]);

    // 3. Defesa extra — `assertCanAccessEvent` já joga 404, mas se houver
    // race de delete entre o assert e a leitura, falhamos limpo.
    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    // 4. Reordenar tickets pra `categoryId NULLS LAST, sortOrder, createdAt`.
    // TicketsService.findAll já ordena por `[sortOrder, createdAt]`; aqui só
    // empurramos os categoryId=null pro final. Array.prototype.sort é estável
    // no V8, então a ordem secundária (sortOrder/createdAt) é preservada.
    const tickets = [...(ticketsResp.data.tickets as Array<{ categoryId: string | null }>)].sort(
      (a, b) => {
        const aNull = a.categoryId === null ? 1 : 0;
        const bNull = b.categoryId === null ? 1 : 0;
        return aNull - bNull;
      },
    );

    return {
      data: {
        event,
        categories: categoriesResp.data.categories,
        tickets,
        pagination: {
          tickets: ticketsResp.data.pagination,
        },
      },
    };
  }
}
