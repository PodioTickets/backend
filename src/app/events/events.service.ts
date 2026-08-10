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
import { resolveActiveBatch, type BatchWithSold } from '../tickets/batch-active.util';
import { computeRegistrationPaidValues } from './export-paid-value.util';
import { formatEventCardAddress } from '../../common/utils/event-email-format.util';
import { TicketCategoriesService } from '../ticket-categories/ticket-categories.service';
import { EmailService } from '../../common/services/email.service';
import { RepasseService, RETENTION_DAYS } from '../repasse/repasse.service';
import { CacheRedisService } from '../../common/services/cache-redis.service';
import { isChargeback, resolveOrderOrganizerFeePercent } from '../../common/utils/refund.util';
import { brtDayStartUtc, brtDayEndUtc, eventWindowInstant } from '../../common/utils/brt-date.util';
import { withPastEventsAsCompleted as markPastEventsCompleted, isEventDatePast, pastEventDateCutoff, publicSearchPastEventCutoff } from '../../common/utils/event-status.util';

/**
 * Taxas padrão aplicadas na CRIAÇÃO de um evento (escala 0–100, ex.: 4 = 4%).
 * - Organizador: percentual absorvido pelo organizador. Pode ser sobrescrito no payload de criação.
 * - Participante: percentual repassado ao participante. Taxa interna — não é editável no create.
 * Eventos já existentes não são afetados (default aplicado só no insert).
 */
export const DEFAULT_ORGANIZER_FEE_PERCENT = 4;
export const DEFAULT_PARTICIPANT_FEE_PERCENT = 2;

/**
 * Taxas financeiras Podio↔organizador aplicadas na CRIAÇÃO do evento (frações 0–1).
 * - Retenção: % do líquido do organizador retido até a auditoria pós-evento (0.10 = 10%).
 * - Estorno: % cobrado do organizador em qualquer estorno/chargeback (0.02 = 2%).
 * Snapshotadas por evento no create; editáveis pelo admin antes do lock. Alterar estes
 * defaults afeta SOMENTE eventos futuros — eventos existentes mantêm o valor gravado.
 */
export const DEFAULT_RETENTION_RATE = 0.1;
export const DEFAULT_REFUND_FEE_RATE = 0.02;

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

    // Mapas de imagens OCULTAS: mesma validação de chaves (ticket/categoria do evento).
    for (const tid of Object.keys(payload.hiddenKitImageUrlsByTicketId ?? {})) {
      this.validateUUID(tid, 'ticketId in hiddenKitImageUrlsByTicketId');
      if (!ticketIds.has(tid)) {
        throw new BadRequestException(
          `kitSelectionDisplay: ticket "${tid}" does not belong to this event`,
        );
      }
    }
    for (const catKey of Object.keys(
      payload.hiddenKitImageUrlsByCategoryId ?? {},
    )) {
      if (catKey === UNCATEGORIZED_CATEGORY_KEY) continue;
      this.validateUUID(catKey, 'categoryId in hiddenKitImageUrlsByCategoryId');
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
   * Para listagens GET: eventos cuja DATA já passou (fim do dia em BRT) são
   * retornados com status COMPLETED. Delega à fonte única `event-status.util`
   * — MESMA regra usada na lista do admin. Antes comparava `eventDate < now` cru
   * (wall-clock como UTC), o que adiantava ~3h e marcava evento do próprio dia
   * como concluído.
   */
  private withPastEventsAsCompleted<T extends { eventDate: Date; status: EventStatus }>(
    events: T[],
  ): T[] {
    return markPastEventsCompleted(events);
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
      orderBy: { createdAt: 'asc' },
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

    // Imagem do evento = BANNER apenas. A antiga "imagem do card" (logoUrl) foi
    // descontinuada — todo o app exibe o banner. Não coletamos/gravamos mais logoUrl.
    const createEventRest = createEventDto;

    // Criar evento primeiro para ter o ID
    const event = await prismaWrite.event.create({
      data: {
        ...createEventRest,
        state: EventsService.normalizeState(createEventRest.state),
        slug: null, // Será gerado depois com o ID
        organizationId: member.organizationId,
        // Taxas padrão: organizador 4% (sobrescrevível) e participante 2% (interno).
        organizerFeePercent:
          createEventDto.organizerFeePercent ?? DEFAULT_ORGANIZER_FEE_PERCENT,
        participantFeePercent: DEFAULT_PARTICIPANT_FEE_PERCENT,
        // Taxas Podio↔organizador snapshotadas por evento (default code-controlled;
        // admin pode editar antes do lock). Alterar o default vale só p/ eventos futuros.
        retentionRate: DEFAULT_RETENTION_RATE,
        refundFeeRate: DEFAULT_REFUND_FEE_RATE,
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

  /**
   * IDs de eventos que possuem ALGUM ingresso ativo com preço dentro de
   * [minCents, maxCents]. O evento entra se QUALQUER lote no intervalo existir;
   * some quando nenhum lote cai no intervalo.
   *
   * Decisões (alinhadas ao comportamento esperado pelo usuário):
   *   - `Ticket.isActive = true`: ingressos desativados pelo organizador não
   *     contam.
   *   - Exclui LOTES FUTUROS (`startDate > now`): um 2º lote ainda não à venda,
   *     normalmente mais caro, não deve "puxar" o evento pra dentro do filtro
   *     (era o sintoma do relato original). Lotes sem `startDate` ou já iniciados
   *     contam — inclusive de eventos com inscrição encerrada, que continuam no
   *     catálogo e devem casar pelo preço ofertado (NÃO filtramos por `endDate`
   *     nem por estoque de propósito).
   *
   * Existência simples (`DISTINCT eventId`), sem agregação. Query única no read
   * replica (índices em Ticket(eventId,isActive) e TicketBatch(ticketId)).
   * `minCents`/`maxCents` null = sem piso/teto.
   */
  private async findEventIdsMatchingPriceRange(
    minCents: number | null,
    maxCents: number | null,
  ): Promise<string[]> {
    const prismaRead = this.prisma.getReadClient();
    const floor = minCents ?? 0;
    const ceil = maxCents ?? 2147483647; // máx. int4 (price é Int em centavos)

    // O filtro deve casar pelo PREÇO DO LOTE ATIVO (o "a partir de" comprável), não
    // por qualquer lote com `startDate <= now`: lotes já superados por um posterior
    // (inativos) continuavam casando e faziam o evento aparecer num intervalo de
    // preço que não é mais vendido. Usamos a MESMA regra do checkout/cards
    // (`resolveActiveBatch`): lote ativo por sortOrder + trigger (BY_TIME /
    // AFTER_PREVIOUS_SOLD_OUT). Escopo limitado ao catálogo público (PUBLISHED
    // dentro da janela da busca) pra manter o conjunto pequeno. MESMA janela do
    // WHERE da busca — senão eventos visíveis (1–4 meses) ficariam sem casar preço.
    const eventDateCutoff = publicSearchPastEventCutoff();

    const tickets = await prismaRead.ticket.findMany({
      where: {
        isActive: true,
        event: { status: EventStatus.PUBLISHED, eventDate: { gte: eventDateCutoff } },
      },
      select: {
        eventId: true,
        batches: {
          select: {
            id: true,
            quantity: true,
            availableQuantity: true,
            price: true,
            startDate: true,
            endDate: true,
            sortOrder: true,
            triggerType: true,
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    // Vagas VENDIDAS por lote (pagamento confirmado; canceladas não contam) —
    // necessário para o trigger AFTER_PREVIOUS_SOLD_OUT do resolveActiveBatch.
    const batchIds = tickets.flatMap((t) => t.batches.map((b) => b.id));
    const soldByBatch =
      batchIds.length > 0
        ? await prismaRead.registrationTicket.groupBy({
            by: ['batchId'],
            where: {
              batchId: { in: batchIds },
              registration: { status: { not: 'CANCELLED' } },
            },
            _count: { id: true },
          })
        : [];
    const soldByBatchMap = new Map(
      soldByBatch.map((s) => [s.batchId, s._count.id]),
    );

    const now = new Date();
    const matched = new Set<string>();
    for (const ticket of tickets) {
      if (ticket.batches.length === 0) {
        continue;
      }
      const batches: BatchWithSold[] = ticket.batches.map((b) => ({
        ...b,
        quantitySold: soldByBatchMap.get(b.id) ?? 0,
      }));
      const { batch: activeBatch } = resolveActiveBatch(batches, now);
      if (activeBatch.price >= floor && activeBatch.price <= ceil) {
        matched.add(ticket.eventId);
      }
    }
    return [...matched];
  }

  /**
   * Resolve `priceMatchIds` para o where da busca. `minPrice`/`maxPrice` JÁ vêm em
   * CENTAVOS (o front converte reais→centavos), mesma unidade de `TicketBatch.price`.
   * Retorna `undefined` quando nenhum dos limites foi enviado (filtro inativo) — só
   * então evita a query agregada.
   */
  private async resolvePriceMatchIds(
    minPrice?: number,
    maxPrice?: number,
  ): Promise<string[] | undefined> {
    if (minPrice == null && maxPrice == null) {
      return undefined;
    }
    return this.findEventIdsMatchingPriceRange(
      minPrice ?? null,
      maxPrice ?? null,
    );
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
    minPrice?: number;
    maxPrice?: number;
    textMatchIds?: string[];
    priceMatchIds?: string[];
  }): Prisma.EventWhereInput {
    const {
      q,
      country,
      state,
      city,
      startDate,
      endDate,
      status,
      modalities,
      textMatchIds,
      priceMatchIds,
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
    }
    // Sem o branch `!includePast → eventDate >= now`: o catálogo público mostra
    // eventos FINALIZADOS por 30 dias (cutoff no AND abaixo), igual à home (findAll).
    // Esse `gte: now` escondia TODOS os passados no /search — divergia da home.

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

    // Catálogo de busca público: oculta eventos cuja realização passou de 4 meses
    // (ver `publicSearchPastEventCutoff`). Aplicado via AND para sobrepor qualquer
    // startDate anterior ao cutoff (includePast=true ou janela customizada não
    // devem burlar a regra).
    const eventDateCutoff = publicSearchPastEventCutoff();

    const andConditions: Prisma.EventWhereInput[] = [
      { eventDate: { gte: eventDateCutoff } },
      where,
    ];

    // Filtro de preço: pré-resolvido em `findEventIdsMatchingPriceRange` (MENOR
    // preço comprável / "a partir de" dentro do intervalo). `priceMatchIds`
    // undefined = filtro inativo; array (mesmo vazio) = aplicar. Condição
    // SEPARADA no AND — combina com `where.id` do filtro de texto (q) por
    // interseção, sem colidir com o `where.tickets` da modalidade.
    if (priceMatchIds !== undefined) {
      andConditions.push({ id: { in: priceMatchIds } });
    }

    return { AND: andConditions };
  }

  async searchLocationFacets(dto: SearchEventLocationsDto) {
    const [textMatchIds, priceMatchIds] = await Promise.all([
      dto.q?.trim().length
        ? this.findEventIdsMatchingText(dto.q)
        : Promise.resolve(undefined),
      this.resolvePriceMatchIds(dto.minPrice, dto.maxPrice),
    ]);

    const where = this.buildPublicEventSearchWhere({
      ...dto,
      textMatchIds,
      priceMatchIds,
    });

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

    // Pré-filtros por ID (texto via unaccent, preço via MIN comprável) rodam em
    // paralelo — independentes; o where combina ambos por interseção de `id`.
    const [textMatchIds, priceMatchIds] = await Promise.all([
      searchFilters.q?.trim().length
        ? this.findEventIdsMatchingText(searchFilters.q)
        : Promise.resolve(undefined),
      this.resolvePriceMatchIds(searchFilters.minPrice, searchFilters.maxPrice),
    ]);

    const where = this.buildPublicEventSearchWhere({
      ...searchFilters,
      textMatchIds,
      priceMatchIds,
    });

    // Usar read replica para performance
    const prismaRead = this.prisma.getReadClient();

    const searchSelect = {
      id: true,
      name: true,
      description: true,
      bannerUrl: true,
      slug: true,
      location: true,
      city: true,
      state: true,
      country: true,
      locationName: true,
      eventDate: true,
      registrationStartDate: true,
      registrationEndDate: true,
      status: true,
      featuredOrder: true,
      createdAt: true,
      organization: {
        select: {
          id: true,
          name: true,
          tradeName: true, // Nome fantasia — mesmo formato de /organizations/me
          // Contato (email/phone) NÃO entra em rota pública — fora do contrato.
          logoUrl: true,
        },
      },
      _count: {
        select: {
          registrations: true,
          modalities: true,
        },
      },
    } satisfies Prisma.EventSelect;

    // ORDEM PADRÃO do catálogo: eventos que ainda vão acontecer, do mais PRÓXIMO
    // ao mais distante; eventos JÁ CONCLUÍDOS (dentro da janela de 30 dias que o
    // catálogo ainda exibe) sempre no FIM. Antes era `eventDate asc` puro — como
    // concluído tem a data mais antiga, ele subia para o TOPO da busca.
    //
    // Não dá pra expressar "concluído por último" num `orderBy` do Prisma (é uma
    // condição sobre `eventDate`, não uma coluna), então os dois blocos são
    // consultados separadamente e a página é montada atravessando a fronteira —
    // ambos os blocos usam o índice de `eventDate` e a paginação continua
    // determinística (desempate por `id`).
    const completedCutoff = pastEventDateCutoff();
    const upcomingWhere: Prisma.EventWhereInput = {
      AND: [where, { eventDate: { gte: completedCutoff } }],
    };
    const completedWhere: Prisma.EventWhereInput = {
      AND: [where, { eventDate: { lt: completedCutoff } }],
    };

    const [upcomingTotal, completedTotal] = await Promise.all([
      prismaRead.event.count({ where: upcomingWhere }),
      prismaRead.event.count({ where: completedWhere }),
    ]);

    const skip = (page - 1) * limit;
    const upcomingTake = Math.max(0, Math.min(limit, upcomingTotal - skip));
    const completedTake = limit - upcomingTake;

    const [upcoming, completed] = await Promise.all([
      upcomingTake > 0
        ? prismaRead.event.findMany({
            where: upcomingWhere,
            skip: Math.min(skip, upcomingTotal),
            take: upcomingTake,
            select: searchSelect,
            // Destaque PRIMEIRO (admin) e depois por data. `nulls: 'last'` mantém
            // os não destacados depois. A ordenação explícita do usuário
            // (nome/data-desc) é aplicada no client sobre a página.
            orderBy: [
              { featuredOrder: { sort: 'asc', nulls: 'last' } },
              { eventDate: 'asc' },
              { id: 'asc' },
            ],
          })
        : Promise.resolve([]),
      completedTake > 0
        ? prismaRead.event.findMany({
            where: completedWhere,
            skip: Math.max(0, skip - upcomingTotal),
            take: completedTake,
            select: searchSelect,
            // Entre concluídos, o mais RECENTE primeiro — também é "proximidade
            // da data", só que para trás. Destaque não promove evento concluído.
            orderBy: [{ eventDate: 'desc' }, { id: 'asc' }],
          })
        : Promise.resolve([]),
    ]);

    const events = [...upcoming, ...completed];
    const total = upcomingTotal + completedTotal;

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
      featured,
    } = filterDto;

    const where: any = {};

    // Carrossel de "Eventos em destaque" da home: só eventos marcados pelo admin
    // (featuredOrder != null), ordenados pela ordem definida na tela de destaque.
    if (featured) {
      where.featuredOrder = { not: null };
    }

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
        orderBy: { createdAt: 'asc' },
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
    // passou de 30 dias são ocultados do catálogo público (sem valor para o usuário e
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

    // Cutoff: oculta eventos cuja realização passou de 30 dias (regra do catálogo público).
    const eventDateCutoff = new Date();
    // Mostra eventos finalizados por 30 dias após a realização, depois oculta.
    // `setDate(-30)` é exatamente 30 dias (evita o rollover do `setMonth` em
    // meses curtos, que dava janela inconsistente).
    eventDateCutoff.setDate(eventDateCutoff.getDate() - 30);

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
          location: true,
          city: true,
          state: true,
          country: true,
          zipCode: true,
          neighborhood: true,
          googleMapsLink: true,
          latitude: true,
          longitude: true,
          locationName: true,
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
          maxParticipants: true,
          status: true,
          featuredOrder: true,
          createdAt: true,
          updatedAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              tradeName: true, // Nome fantasia — mesmo formato de /organizations/me
              // Contato (email/phone) NÃO entra em rota pública — fora do contrato.
              logoUrl: true,
            },
          },
        },
        // Carrossel de destaque: honra a ordem do admin (featuredOrder asc). Catálogo
        // geral: por data. `nulls: 'last'` mantém não-destacados depois no caso featured
        // (inócuo aqui, pois o where já exige featuredOrder != null).
        orderBy: featured
          ? [{ featuredOrder: { sort: 'asc', nulls: 'last' } }]
          : { eventDate: 'asc' },
      }),
      prismaRead.event.count({ where: whereFinal }),
    ]);

    const eventsCompleted = this.withPastEventsAsCompleted(events);
    const shouldIncludeSlots = includeHasSlots !== false;

    let eventsPayload = eventsCompleted;
    if (shouldIncludeSlots && eventsCompleted.length > 0) {
      const eventIds = eventsCompleted.map((e) => e.id);
      const ticketsByEvent = await this.loadTicketsWithBatchesForEvents(
        prismaRead,
        eventIds,
      );
      // Teto de vagas do evento (cards da home/busca): 1 count por página só
      // para eventos que TÊM teto — o "esgotado" precisa bater com a tela do evento.
      const cappedEventIds = eventsCompleted
        .filter((e) => e.maxParticipants != null)
        .map((e) => e.id);
      const regCountByEvent =
        await this.countNonCancelledRegistrationsByEvents(prismaRead, cappedEventIds);
      eventsPayload = eventsCompleted.map((e) => ({
        ...e,
        hasRegistrationSlotsAvailable: this.computeSlotsFromTickets(
          e.status,
          e.eventDate instanceof Date ? e.eventDate : new Date(e.eventDate),
          ticketsByEvent.get(e.id) ?? [],
          e.maxParticipants != null &&
            (regCountByEvent.get(e.id) ?? 0) >= e.maxParticipants,
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

    // Filtro por data
    const eventDateFilter: Prisma.DateTimeFilter = {};
    if (startDate && endDate) {
      eventDateFilter.gte = new Date(startDate);
      eventDateFilter.lte = new Date(endDate);
    } else if (!includePast) {
      // Por padrão, apenas eventos futuros
      eventDateFilter.gte = new Date();
    }

    // Filtro por status — pela regra EXIBIDA, não pela coluna crua. COMPLETED é
    // derivado da data em `withPastEventsAsCompleted` (nenhuma linha guarda
    // COMPLETED), então filtrar `status = COMPLETED` devolvia lista vazia e os
    // demais status devolviam eventos que a tela rotula como "Concluído".
    // Mesma correção da lista do admin — fonte única em `event-status.util`.
    if (status === EventStatus.COMPLETED) {
      eventDateFilter.lt = pastEventDateCutoff();
    } else if (status) {
      where.status = status;
      const cutoff = pastEventDateCutoff();
      const currentGte = eventDateFilter.gte as Date | undefined;
      eventDateFilter.gte = currentGte && currentGte > cutoff ? currentGte : cutoff;
    }

    if (Object.keys(eventDateFilter).length > 0) {
      where.eventDate = eventDateFilter;
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
          slug: true,
          location: true,
          city: true,
          state: true,
          country: true,
          locationName: true,
          eventDate: true,
          registrationEndDate: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          kitSelectionDisplay: true,
          // Contadores úteis sem carregar relações completas
          _count: {
            select: {
              // Conta APENAS inscrições válidas/pagas: CONFIRMED (paga) e COMPLETED
              // (paga, evento encerrado). Exclui PENDING (não paga) e CANCELLED — que
              // também cobre estorno e chargeback (ambos rebaixam a inscrição p/ CANCELLED;
              // ver payments-refund.service / payments-chargeback.service). Filtro DB-side
              // (filtered relation count) — sem query extra. Mesma convenção do resto do service.
              registrations: {
                where: {
                  status: {
                    in: [RegistrationStatus.CONFIRMED, RegistrationStatus.COMPLETED],
                  },
                },
              },
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

    // Receita LÍQUIDA por evento (uma query agregada — evita N aggregates).
    // A coluna na UI é "Receita Líquida": precisa descontar a taxa do
    // participante (`serviceFee`, 100% plataforma) E a alíquota do organizador
    // (`organizerFeePercent`, snapshot do pedido c/ fallback ao vivo do evento).
    // Antes somava `finalAmount` cru (BRUTO) sob o rótulo "líquida" — divergia do
    // dashboard/financeiro. Fórmula idêntica à canônica (aggregateEventRegistration
    // Metrics / dashboard): `(finalAmount − serviceFee) × (1 − feePercent/100)` por
    // pedido. Agregado por PEDIDO (sem JOIN em registrations) → sem double-count.
    // Pagamento PAID já exclui estorno/chargeback (rebaixam o Payment).
    const salesByEventId = new Map<string, number>();
    if (events.length > 0) {
      const eventIds = events.map((e) => e.id);
      const netRows = await prismaRead.$queryRaw<
        { eventId: string; net: bigint }[]
      >(Prisma.sql`
        SELECT o."eventId" AS "eventId",
          COALESCE(SUM(ROUND(
            GREATEST(0, o."finalAmount" - COALESCE(o."serviceFee", 0))::numeric
              * (1 - COALESCE(o."organizerFeePercent", e."organizerFeePercent", 0)::numeric / 100)
          )), 0)::bigint AS net
        FROM "Order" o
        INNER JOIN "Event" e ON e.id = o."eventId"
        INNER JOIN "Payment" p ON p."orderId" = o.id
        WHERE o."eventId" = ANY(${eventIds}::uuid[])
          AND p.status::text = 'PAID'
        GROUP BY o."eventId"
      `);
      for (const row of netRows) {
        salesByEventId.set(row.eventId, Number(row.net));
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
    latitude: true,
    longitude: true,
    locationName: true,
    instagram: true,
    facebook: true,
    youtube: true,
    tiktok: true,
    website: true,
    regulationUrl: true,
    eventDate: true,
    registrationStartDate: true,
    registrationEndDate: true,
    // Vagas do evento (teto). Público lê pra o front refletir o campo no editor;
    // o "esgotado" em si é derivado server-side em hasRegistrationSlotsAvailable.
    maxParticipants: true,
    status: true,
    participantFeePercent: true,
    maxInstallments: true,
    // Whitelist da tela financeira — o checkout só renderiza estes métodos
    // (o /pay valida server-side de qualquer forma).
    acceptedPaymentMethods: true,
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
      // Contato (email/phone) também NÃO entra (2026-06-04): organizador não tem
      // e-mail/telefone expostos em NENHUMA rota de usuário/pública.
      organization: {
        select: {
          id: true,
          name: true,
          tradeName: true,
          logoUrl: true,
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
    // COMPLETED só após o FIM DO DIA civil em BRT (fonte única `isEventDatePast`),
    // não no wall-clock cru — senão o evento "conclui" ~3h antes e fecha as inscrições
    // cedo. Mesma regra das listagens de admin/organizador.
    const status = isEventDatePast(eventDate, now)
      ? EventStatus.COMPLETED
      : event.status;

    // Ingressos enxutos SÓ para o cálculo de vagas (não retornados ao cliente).
    const ticketsForSlots = await prismaRead.ticket.findMany({
      where: { eventId: event.id, isActive: true },
      select: {
        id: true,
        batches: { select: { id: true, availableQuantity: true, startDate: true, endDate: true } },
      },
    });

    const hasRegistrationSlotsAvailable =
      await this.computeHasRegistrationSlotsAvailable(
        prismaRead,
        status,
        eventDate,
        ticketsForSlots,
        event.id,
        event.maxParticipants ?? null,
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
          include: { product: { include: { variations: { orderBy: { sortOrder: 'asc' } } } } },
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
    // COMPLETED só após o FIM DO DIA civil em BRT (`isEventDatePast`), não no wall-clock
    // cru — senão fecha as inscrições ~3h cedo. Mesma regra das listagens.
    const eventToReturn = isEventDatePast(eventDate, now)
      ? { ...event, status: EventStatus.COMPLETED }
      : event;

    const hasRegistrationSlotsAvailable =
      await this.computeHasRegistrationSlotsAvailable(
        prismaRead,
        eventToReturn.status,
        eventDate,
        eventToReturn.tickets,
        eventToReturn.id,
        (eventToReturn as { maxParticipants?: number | null }).maxParticipants ?? null,
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
   * Ingressos ativos + lotes (com `availableQuantity`) por evento, para o cálculo de
   * vagas dos cards de listagem. 1 query. A disponibilidade sai do `availableQuantity`
   * do lote (mesmo gate do checkout) — não precisa mais agregar RegistrationTicket.
   */
  private async loadTicketsWithBatchesForEvents(
    prismaRead: ReturnType<PrismaService['getReadClient']>,
    eventIds: string[],
  ): Promise<
    Map<
      string,
      Array<{
        batches: Array<{
          availableQuantity: number;
          startDate: Date | null;
          endDate: Date | null;
        }>;
      }>
    >
  > {
    const tickets = await prismaRead.ticket.findMany({
      where: { eventId: { in: eventIds }, isActive: true },
      select: {
        eventId: true,
        batches: {
          select: { availableQuantity: true, startDate: true, endDate: true },
        },
      },
    });

    const ticketsByEvent = new Map<
      string,
      Array<{
        batches: Array<{
          availableQuantity: number;
          startDate: Date | null;
          endDate: Date | null;
        }>;
      }>
    >();
    for (const t of tickets) {
      const arr = ticketsByEvent.get(t.eventId) ?? [];
      arr.push({ batches: t.batches });
      ticketsByEvent.set(t.eventId, arr);
    }
    return ticketsByEvent;
  }

  /**
   * Há vaga em algum ingresso? Decide pela MESMA fonte de verdade que o checkout usa
   * (`TicketBatch.availableQuantity`), não por contagem derivada de inscrições. Antes,
   * contava inscrições CONFIRMED vs `batch.quantity` — o que DIVERGIA do gate real de
   * venda: `availableQuantity` é decrementado na reserva (inclui PENDING) e restaurado
   * na expiração/estorno, então o "esgotado" da tela do evento passa a bater exatamente
   * com o do checkout (ex.: lote com availableQuantity=0 mas poucos confirmados NÃO
   * reabre o botão "Inscreva-se"). Bônus de performance: dispensa o groupBy de
   * RegistrationTicket que rodava por página/evento. Sem I/O.
   */
  private computeSlotsFromTickets(
    eventStatus: EventStatus,
    eventDate: Date,
    tickets: Array<{
      batches: Array<{
        availableQuantity: number;
        startDate: Date | null;
        endDate: Date | null;
      }>;
    }>,
    /** Teto de vagas do evento atingido → esgotado, independentemente dos lotes. */
    eventCapReached = false,
  ): boolean {
    if (
      eventStatus !== EventStatus.PUBLISHED &&
      eventStatus !== EventStatus.SUSPENDED
    ) {
      return false;
    }
    // Teto do evento vem PRIMEIRO: mesmo que algum lote tenha saldo, o evento esgota
    // aqui (regra de produto — o teto é o limite absoluto sobre a soma dos lotes).
    if (eventCapReached) {
      return false;
    }
    // Evento já realizado = após o FIM DO DIA civil em BRT (`isEventDatePast`), não no
    // wall-clock cru — senão zeraria as vagas ~3h antes do fim do dia do evento.
    if (isEventDatePast(eventDate)) {
      return false;
    }
    if (!tickets?.length) {
      return false;
    }
    const now = new Date();
    for (const ticket of tickets) {
      if (!ticket.batches?.length) continue;
      // Vaga = existe um lote VIGENTE (dentro da janela start/end) com saldo real (>0).
      // start/end são WALL-CLOCK (UTC) → instante real em BRT via `eventWindowInstant`
      // (+3h); senão a janela do lote fechava 3h CEDO e o evento aparecia "Esgotado"
      // ainda dentro do horário (mesma convenção da janela de inscrição).
      const hasActiveRoom = ticket.batches.some(
        (b) =>
          (!b.startDate || eventWindowInstant(b.startDate) <= now) &&
          (!b.endDate || eventWindowInstant(b.endDate) >= now) &&
          b.availableQuantity > 0,
      );
      if (hasActiveRoom) return true;
    }
    return false;
  }

  /**
   * Indica se ainda há vaga em algum ingresso ativo com lote vigente. Fonte de verdade =
   * `TicketBatch.availableQuantity` (mesmo gate do checkout). Inclui eventos SUSPENDED:
   * reflete estoque real; a UI pode bloquear inscrição pelo status. Só 1 query barata
   * (isEventCapReached) — não agrega mais RegistrationTicket.
   */
  private async computeHasRegistrationSlotsAvailable(
    prismaRead: ReturnType<PrismaService['getReadClient']>,
    eventStatus: EventStatus,
    eventDate: Date,
    tickets: Array<{
      batches: Array<{
        availableQuantity: number;
        startDate: Date | null;
        endDate: Date | null;
      }>;
    }>,
    /** ID + teto do evento — quando o teto é atingido, esgota antes dos lotes. */
    eventId: string,
    maxParticipants: number | null,
  ): Promise<boolean> {
    if (
      eventStatus !== EventStatus.PUBLISHED &&
      eventStatus !== EventStatus.SUSPENDED
    ) {
      return false;
    }
    // Evento realizado = após o FIM DO DIA civil em BRT (`isEventDatePast`), não wall-clock cru.
    if (isEventDatePast(eventDate)) {
      return false;
    }
    // Teto do evento: se atingido, esgotado — nem precisa olhar os lotes.
    const eventCapReached = await this.isEventCapReached(
      prismaRead,
      eventId,
      maxParticipants,
    );
    if (eventCapReached) {
      return false;
    }
    return this.computeSlotsFromTickets(
      eventStatus,
      eventDate,
      tickets,
      eventCapReached,
    );
  }

  /**
   * Teto de vagas do evento atingido? Conta `Registration != CANCELLED` (inclui
   * reservas PENDING ativas) — MESMO predicado do enforcement no reserve, pra o
   * "esgotado" exibido nunca divergir do que a reserva realmente permite. `null`
   * de teto = ilimitado → nunca esgota por aqui. Índice [eventId, status] → barato.
   */
  private async isEventCapReached(
    prismaRead: ReturnType<PrismaService['getReadClient']>,
    eventId: string,
    maxParticipants: number | null | undefined,
  ): Promise<boolean> {
    if (maxParticipants == null) return false;
    const count = await prismaRead.registration.count({
      where: { eventId, status: { not: RegistrationStatus.CANCELLED } },
    });
    return count >= maxParticipants;
  }

  /** Contagem de inscrições não-canceladas por evento (batelada; só p/ eventos com teto). */
  private async countNonCancelledRegistrationsByEvents(
    prismaRead: ReturnType<PrismaService['getReadClient']>,
    eventIds: string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (eventIds.length === 0) return map;
    const rows = await prismaRead.registration.groupBy({
      by: ['eventId'],
      where: { eventId: { in: eventIds }, status: { not: RegistrationStatus.CANCELLED } },
      _count: { id: true },
    });
    for (const r of rows) map.set(r.eventId, r._count.id);
    return map;
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

    // Vagas do evento: o teto NÃO pode ser menor que o total já inscrito
    // (não-cancelado). Salvar abaixo "esgotaria" o evento retroativamente e
    // deixaria vagas negativas — bloqueamos com erro de CAMPO (mapeado inline no
    // input pelo front). `null` (limpar teto) e `undefined` (não mexeu) passam.
    // Conta no write client pra refletir reservas/inscrições recém-criadas.
    if (
      updateEventDto.maxParticipants !== undefined &&
      updateEventDto.maxParticipants !== null
    ) {
      const currentRegistrations = await prismaWrite.registration.count({
        where: { eventId: id, status: { not: RegistrationStatus.CANCELLED } },
      });
      if (updateEventDto.maxParticipants < currentRegistrations) {
        throw new BadRequestException({
          message: `As vagas do evento (${updateEventDto.maxParticipants}) não podem ser menores que o número de inscritos atuais (${currentRegistrations}).`,
          code: 'MAX_PARTICIPANTS_BELOW_CURRENT',
          field: 'maxParticipants',
        });
      }
    }

    const {
      clientPage,
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
    // "Imagem do card" (logoUrl/cardImageUrl) descontinuada — só banner. Nada a gravar.

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
   *  - `organizerFeePercent`, `retentionRate` e `refundFeeRate` — taxas internas
   *    (Podio↔organizador) que o participante não deve conhecer.
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
      refundFeeRate: _rfr,
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
      // Array vazio nunca é estado válido (mín. 1 no DTO) — fallback pra todos
      // cobre registros anteriores à migration/replica defasada.
      acceptedPaymentMethods: event.acceptedPaymentMethods?.length
        ? event.acceptedPaymentMethods
        : ['PIX', 'DEBIT_CARD', 'CREDIT_CARD'],
      lockedAt: event.financialSettingsLockedAt ?? null,
    };
  }

  private financialSettingsSelect() {
    return {
      id: true,
      organizerFeePercent: true,
      participantFeePercent: true,
      maxInstallments: true,
      acceptedPaymentMethods: true,
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
    dto: {
      organizerFeePercent?: number;
      participantFeePercent?: number;
      maxInstallments?: number;
      acceptedPaymentMethods?: string[];
    },
    opts: { bypassLock?: boolean } = {},
  ) {
    await this.verifyOrganizerAccess(userId, eventId, 'edit_event');

    const prismaWrite = this.prisma.getWriteClient();

    // Semântica PATCH: campo omitido = mantém o valor atual (validação de
    // conteúdo fica no UpdateFinancialSettingsDto).
    const data: Record<string, any> = {};
    if (dto.organizerFeePercent !== undefined) data.organizerFeePercent = dto.organizerFeePercent;
    if (dto.participantFeePercent !== undefined) data.participantFeePercent = dto.participantFeePercent;
    if (dto.maxInstallments !== undefined) data.maxInstallments = dto.maxInstallments;
    if (dto.acceptedPaymentMethods?.length) {
      data.acceptedPaymentMethods = dto.acceptedPaymentMethods;
    }

    // O lock pós-publicação protege apenas a DIVISÃO DA TAXA (impacta preço já
    // acordado). Formas de pagamento e parcelamento seguem editáveis pelo
    // organizador — afetam só pagamentos futuros e o /pay valida a whitelist.
    const touchesLockedFields =
      data.organizerFeePercent !== undefined || data.participantFeePercent !== undefined;

    if (Object.keys(data).length === 0) {
      // PATCH vazio: no-op — devolve o estado atual sem tocar o banco.
      const event = await prismaWrite.event.findUnique({
        where: { id: eventId },
        select: this.financialSettingsSelect(),
      });
      if (!event) throw new NotFoundException('Evento não encontrado');
      return { data: this.buildFinancialSettingsPayload(event) };
    }

    if (opts.bypassLock || !touchesLockedFields) {
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
          message: 'A divisão da taxa não pode ser alterada após a publicação do evento.',
        });
      }
    }

    // Evento publicado pode ter cache público ativo — o checkout lê
    // acceptedPaymentMethods do payload público (TTL 30s degrada o resto).
    this.invalidateEventCacheById(eventId);

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
      // Endereço do card = Local, Cidade, Estado (igual ao card da home).
      const eventLocation = formatEventCardAddress(event);

      this.emailService
        .sendEventUnderReview({
          recipientEmail: organizer.email,
          eventName: event.name,
          // Imagem do e-mail = BANNER do evento (logoUrl descontinuado).
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

    const [
      totalRegistrations,
      confirmedRegistrations,
      revenueAggregate,
      ticketsSold,
      modalities,
    ] = await Promise.all([
      prismaRead.registration.count({ where: { eventId } }),
      prismaRead.registration.count({ where: { eventId, status: 'CONFIRMED' } }),
      prismaRead.order.aggregate({
        where: {
          eventId,
          payment: { status: 'PAID' },
        },
        _sum: { finalAmount: true },
      }),
      prismaRead.registrationModality.count({
        where: { registration: { eventId } },
      }),
      prismaRead.modality.findMany({
        where: { eventId, isActive: true },
      }),
    ]);

    const totalRevenue = revenueAggregate._sum.finalAmount ?? 0;

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
          // "Aguardando liberação" do organizador = tudo que ainda NÃO é sacável e vai
          // liberar: o que está na janela de compensação (aguardandoLiberacao) MAIS o 10%
          // retido aguardando auditoria do admin (valorRetido). Vale pra todos os métodos à
          // vista (PIX/débito/crédito à vista); parcelado não retém (vai pra parceladosAReceber),
          // então fica naturalmente de fora. Sem double-count: um pedido à vista está OU na
          // janela (aguardandoLiberacao) OU fora dela (saldo 90% + valorRetido 10%) — nunca nos dois.
          pendingRelease: breakdown.aguardandoLiberacao + breakdown.valorRetido,
          // Sub-detalhe: a parcela do "aguardando liberação" que está retida p/ auditoria do admin.
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

    // Prefixo '#' restringe a busca a IDs — mesma convenção da listagem de
    // inscrições (ver `getEventRegistrations`). O front exibe o pedido como
    // "#999ef0df" (`formatShortId`), então o termo copiado da tela chega com o '#'
    // e precisa ser removido antes do ILIKE (UUID não contém '#').
    const searchRaw = params.search?.trim();
    const isIdSearch = !!searchRaw && searchRaw.startsWith('#');
    const searchTrim = isIdSearch ? searchRaw.slice(1).trim() : searchRaw;
    if (searchTrim) {
      const pat = `%${this.escapeIlikePattern(searchTrim)}%`;
      // IDs: inscrição E PEDIDO. Os drawers de Estornado/Chargeback exibem o
      // `orderId`, então sem `o.id` a busca pelo ID lido na tela não casava nada
      // — só `r.id`, que não é exibido em lugar nenhum. Paridade com o
      // pré-filtro de UUID da listagem de inscrições (r.id OR o.id).
      const idSql = Prisma.sql`(r.id::text ILIKE ${pat} ESCAPE '\\' OR o.id::text ILIKE ${pat} ESCAPE '\\')`;
      if (isIdSearch) {
        parts.push(idSql);
      } else {
        // Métodos de pagamento casados pelo termo (ex.: "pix") — paridade com a listagem.
        const methods = this.matchPaymentMethodsFromSearch(searchTrim);
        const methodSql =
          methods.length > 0
            ? Prisma.sql` OR p.method::text IN (${Prisma.join(methods.map((m) => Prisma.sql`${m}`))})`
            : Prisma.empty;
        parts.push(
          Prisma.sql`(${idSql} OR COALESCE(r."participantName", '') ILIKE ${pat} ESCAPE '\\' OR (r."receiptSnapshot"->'participant'->>'name') ILIKE ${pat} ESCAPE '\\' OR (r."receiptSnapshot"->'participant'->>'email') ILIKE ${pat} ESCAPE '\\' OR (r."receiptSnapshot"->'participant'->>'documentNumber') ILIKE ${pat} ESCAPE '\\' OR (r."receiptSnapshot"->'participant'->>'cpf') ILIKE ${pat} ESCAPE '\\' OR EXISTS (SELECT 1 FROM "User" u WHERE u.id = r."userId" AND (u."firstName" ILIKE ${pat} ESCAPE '\\' OR u."lastName" ILIKE ${pat} ESCAPE '\\' OR (COALESCE(u."firstName", '') || ' ' || COALESCE(u."lastName", '')) ILIKE ${pat} ESCAPE '\\' OR u.email ILIKE ${pat} ESCAPE '\\' OR COALESCE(u."documentNumber", '') ILIKE ${pat} ESCAPE '\\')) OR EXISTS (SELECT 1 FROM "Coupon" c WHERE c.id = o."couponId" AND COALESCE(c.code, '') ILIKE ${pat} ESCAPE '\\') OR EXISTS (SELECT 1 FROM "Voucher" v WHERE v.id = o."voucherId" AND COALESCE(v.code, '') ILIKE ${pat} ESCAPE '\\')${methodSql})`,
        );
      }
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
            -- Receita LÍQUIDA por PEDIDO pago (fonte da verdade = financeiro/repasse:
            -- todo pedido PAID conta, sem filtrar por status de inscrição). ROUND por
            -- pedido (mesma unidade do orgNet do repasse). Order.eventId mapeia o
            -- pedido ao evento sem precisar de JOIN em Registration.
            SELECT o.id,
              ROUND(
                GREATEST(0, o."finalAmount" - COALESCE(o."serviceFee", 0))::numeric
                  * (1 - COALESCE(o."organizerFeePercent", e."organizerFeePercent", 0)::numeric / 100)
              ) AS "netCents"
            FROM "Order" o
            INNER JOIN "Event" e ON e.id = o."eventId"
            INNER JOIN "Payment" p ON p."orderId" = o.id
            WHERE o."eventId" = ${eventId}::uuid
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
            -- "Cancelados" = cancelamento REAL, sem estorno/chargeback (esses tem card
            -- proprio em refunded). Estorno/chargeback rebaixam a inscricao p/ CANCELLED E
            -- marcam o Payment como REFUNDED; sem este AND, eram contados nos DOIS cards.
            -- (p.status IS NULL mantem cancelamento de pedido sem pagamento.)
            COUNT(*) FILTER (
              WHERE r.status::text = 'CANCELLED'
                AND (p.status IS NULL OR p.status::text <> 'REFUNDED')
            )::bigint AS cancelled,
            COUNT(*) FILTER (WHERE p.status::text = 'REFUNDED')::bigint AS refunded,
            COALESCE((SELECT SUM("netCents") FROM paid_orders), 0)::bigint AS collected
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
            -- Idem variante com data: receita líquida por PEDIDO pago (todo PAID),
            -- ROUND por pedido. Sem JOIN/filtro de Registration (Order.eventId basta).
            SELECT o.id,
              ROUND(
                GREATEST(0, o."finalAmount" - COALESCE(o."serviceFee", 0))::numeric
                  * (1 - COALESCE(o."organizerFeePercent", e."organizerFeePercent", 0)::numeric / 100)
              ) AS "netCents"
            FROM "Order" o
            INNER JOIN "Event" e ON e.id = o."eventId"
            INNER JOIN "Payment" p ON p."orderId" = o.id
            WHERE o."eventId" = ${eventId}::uuid
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
            -- "Cancelados" = cancelamento REAL, sem estorno/chargeback (esses tem card
            -- proprio em refunded). Estorno/chargeback rebaixam a inscricao p/ CANCELLED E
            -- marcam o Payment como REFUNDED; sem este AND, eram contados nos DOIS cards.
            -- (p.status IS NULL mantem cancelamento de pedido sem pagamento.)
            COUNT(*) FILTER (
              WHERE r.status::text = 'CANCELLED'
                AND (p.status IS NULL OR p.status::text <> 'REFUNDED')
            )::bigint AS cancelled,
            COUNT(*) FILTER (WHERE p.status::text = 'REFUNDED')::bigint AS refunded,
            COALESCE((SELECT SUM("netCents") FROM paid_orders), 0)::bigint AS collected
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
  /**
   * Mapeia o texto da busca para métodos de pagamento (enum) — permite ao
   * organizador filtrar a listagem digitando "pix", "cartão", "boleto" etc.
   * direto no campo de pesquisa. Normaliza acentos/caixa e ignora termos
   * curtos demais (< 2 chars) para evitar matches espúrios.
   */
  private matchPaymentMethodsFromSearch(search: string): PaymentMethod[] {
    const term = search
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
    if (term.length < 2) return [];

    // Sinônimos por método (sem acento). Match bidirecional (kw contém termo
    // ou termo contém kw) para casar tanto "cart" → cartão quanto "cartao de credito".
    const keywords: Record<PaymentMethod, string[]> = {
      PIX: ['pix'],
      CREDIT_CARD: ['credito', 'credit', 'cartao de credito', 'cartao credito', 'cartao'],
      DEBIT_CARD: ['debito', 'debit', 'cartao de debito', 'cartao debito', 'cartao'],
      BOLETO: ['boleto'],
      CRYPTO: ['cripto', 'crypto', 'criptomoeda'],
    };

    const matched: PaymentMethod[] = [];
    for (const method of Object.keys(keywords) as PaymentMethod[]) {
      if (keywords[method].some((kw) => kw.includes(term) || term.includes(kw))) {
        matched.push(method);
      }
    }
    return matched;
  }

  /**
   * IDs de inscrições cujo termo casa em fontes fora do alcance do `where` do
   * Prisma: o nome COMPLETO do usuário vinculado (concat `firstName || ' ' ||
   * lastName`) e o snapshot IMUTÁVEL do participante (`receiptSnapshot.participant`).
   * O snapshot é o ÚNICO lugar com o nome/e-mail/documento do TERCEIRO quando ele
   * reusou o e-mail do comprador (aí a coluna `participantName` fica nula e o
   * `reg.user` é o comprador). Unir ao id-list de {@link buildRegistrationTextSearchOr}.
   */
  private async findRegistrationExtraSearchMatchIds(
    prismaRead: any,
    eventId: string,
    searchTerm: string,
  ): Promise<string[]> {
    const pat = `%${this.escapeIlikePattern(searchTerm)}%`;
    // Documento formatado (503.798.000-00) → casa também sem pontuação.
    const digitsTerm = searchTerm.replace(/[.\-\/]/g, '');
    const docPat = `%${this.escapeIlikePattern(digitsTerm)}%`;
    const rows = await prismaRead.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM "Registration" r
      LEFT JOIN "User" u ON u.id = r."userId"
      WHERE r."eventId" = ${eventId}::uuid
        AND (
          (COALESCE(u."firstName", '') || ' ' || COALESCE(u."lastName", '')) ILIKE ${pat} ESCAPE '\\'
          OR (r."receiptSnapshot"->'participant'->>'name') ILIKE ${pat} ESCAPE '\\'
          OR (r."receiptSnapshot"->'participant'->>'email') ILIKE ${pat} ESCAPE '\\'
          OR (r."receiptSnapshot"->'participant'->>'documentNumber') ILIKE ${docPat} ESCAPE '\\'
          OR (r."receiptSnapshot"->'participant'->>'cpf') ILIKE ${docPat} ESCAPE '\\'
        )
    `;
    return rows.map((row) => row.id);
  }

  /**
   * Cláusulas OR de busca textual da listagem de inscrições. Compartilhado entre
   * a listagem paginada e o export para manter o mesmo comportamento de pesquisa:
   * nome/e-mail/documento (conta e snapshot do participante), código de cupom,
   * código de voucher e método de pagamento (via {@link matchPaymentMethodsFromSearch}).
   * `uuidMatchIds` vem da pré-busca por ID (UUID não suporta `contains` no Prisma).
   */
  private buildRegistrationTextSearchOr(
    searchTerm: string,
    uuidMatchIds: string[],
  ): any[] {
    // CPF/CNPJ formatados (ex: 503.798.000-00) → buscar também sem pontuação
    const searchTermDigits = searchTerm.replace(/[.\-\/]/g, '');
    const methods = this.matchPaymentMethodsFromSearch(searchTerm);

    return [
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
      // Cupom/voucher aplicados no pedido — busca pelo código
      { order: { coupon: { code: { contains: searchTerm, mode: 'insensitive' } } } },
      { order: { voucher: { code: { contains: searchTerm, mode: 'insensitive' } } } },
      // Método de pagamento (só adiciona quando o termo casa algum método).
      // `amount > 0` exclui pedidos GRATUITOS: eles pulam o gateway e gravam um
      // método apenas NOMINAL (ex.: PIX) para fins de relatório (ver isFreeOrder
      // em orders.service). Sem esse guard, buscar "pix" trazia ingressos grátis,
      // que não são pagamento PIX real. Nenhum pagamento real tem amount 0.
      ...(methods.length > 0
        ? [{ order: { payment: { method: { in: methods }, amount: { gt: 0 } } } }]
        : []),
    ];
  }

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
      // Dia civil escolhido no seletor → fronteiras do DIA BRT (evita o skew de 3h).
      if (startDate) where.order.createdAt.gte = brtDayStartUtc(startDate);
      if (endDate) where.order.createdAt.lte = brtDayEndUtc(endDate);
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
        // Nome COMPLETO ("João Silva" não casa firstName/lastName isolados) e o
        // snapshot do participante (nome/e-mail/doc do TERCEIRO com e-mail reusado)
        // vivem fora do alcance do `where` do Prisma → pré-buscamos os IDs e unimos
        // ao OR de busca textual.
        const extraIds = await this.findRegistrationExtraSearchMatchIds(
          prismaRead,
          eventId,
          searchTerm,
        );
        const mergedIds = Array.from(new Set([...uuidMatchIds, ...extraIds]));
        where.OR = this.buildRegistrationTextSearchOr(searchTerm, mergedIds);
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

    // Lookup em lote dos convidados resolvíveis por documento (PRIORITY 2 do modal).
    const userByDoc = await this.buildParticipantUserByDocMap(prismaRead, registrations);

    // Formatar registrations
    // Cada registration representa um participante do pedido
    // O pedido (order) agrupa múltiplas inscrições e tem o pagamento
    const formattedRegistrations = registrations.map((reg: any) => {
      // Mesma resolução do modal de detalhe: snapshot → user → doc → colunas.
      // Antes lia só `reg.user`/colunas e saía vazio p/ convidados cujo dado
      // só existe no receiptSnapshot.
      const participantData = this.resolveOrganizerParticipant(reg, userByDoc);
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
          buyer: this.resolveOrderBuyer(reg.order),
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
          buyer: this.resolveOrderBuyer(order),
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
          buyer: this.resolveOrderBuyer(order),
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

    // Buscar pagamentos pagos do evento em lotes limitados para evitar carregar toda a tabela.
    // A filtragem por releaseDate é feita em JS (depende de RETENTION_DAYS por método),
    // então buscamos com um take máximo razoável e um count separado para métricas totais.
    const MAX_ORDERS_FETCH = 2000;
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
      take: MAX_ORDERS_FETCH,
    });

    const allPending: any[] = [];
    let totalPending = 0;
    let releaseToday = 0;

    for (const order of paidOrders) {
      if (!order.payment?.paymentDate) continue;

      const paymentDate = new Date(order.payment.paymentDate);
      const releaseDate = new Date(paymentDate);
      const retentionDays = RETENTION_DAYS[order.payment.method as string] ?? 31;
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
          buyer: this.resolveOrderBuyer(order),
          billingAddress: this.resolveOrderBillingAddress(order, order.payment),
          registrationsCount: order.registrations.length,
        });

        totalPending += netAmount;
        if (isReleaseToday) {
          releaseToday += netAmount;
        }
      }
    }

    // Ordenar por data de LIBERAÇÃO ascendente: a liberação mais próxima fica em
    // PRIMEIRO (mais antigo → mais recente). Tiebreak pela data do pagamento.
    allPending.sort((a, b) => {
      const byRelease =
        new Date(a.releaseDate).getTime() - new Date(b.releaseDate).getTime();
      if (byRelease !== 0) return byRelease;
      return new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime();
    });

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
   * Exporta em CSV o "aguardando liberação" — aba À VISTA (pending releases) ou
   * PARCELADOS (parcelas a receber agrupadas por pedido). Reusa os métodos já
   * validados (`getFinancialPending`/`getFinancialInstallments`), então herda o
   * controle de acesso e o mesmo cálculo de valores/prazos exibidos na tela.
   * Separador `;` + BOM UTF-8 (Excel pt-BR abre com acentos corretos).
   */
  async exportFinancialPendingCsv(
    userId: string,
    eventId: string,
    type: 'avista' | 'parcelados',
    fields?: string[],
  ): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    // verifyOrganizerAccess é chamado dentro dos métodos reusados abaixo.
    const prismaRead = this.prisma.getReadClient();
    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { name: true },
    });
    const eventName = event?.name ?? 'evento';

    const fmtDate = (iso: string) => {
      if (!iso) return '';
      const d = new Date(iso);
      const pad = (n: number) => String(n).padStart(2, '0');
      // UTC para bater com a exibição da tela (datetimeBR.ts usa UTC).
      return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
    };
    const fmtMoney = (cents: number) =>
      `R$ ${(cents / 100).toLocaleString('pt-BR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    const esc = (v: string) => {
      const s = v ?? '';
      // Aspas quando o campo tiver separador, aspa ou quebra de linha.
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    // Colunas exportáveis (ordem canônica) → cabeçalho + extrator. O modal do front
    // manda `fields`; sem seleção (ou lixo), exporta TODAS. Colunas type-específicas
    // (Forma de pagamento / Parcelas pagas) saem vazias quando não se aplicam.
    interface Rec {
      orderId: string;
      name: string;
      email: string;
      document: string;
      releaseISO: string;
      paymentMethod: string;
      installments: string;
      amount: number;
    }
    const COLUMNS: {
      key: string;
      header: string;
      value: (r: Rec) => string;
    }[] = [
      { key: 'orderId', header: 'ID pedido', value: (r) => r.orderId },
      { key: 'buyer', header: 'Comprador', value: (r) => r.name },
      { key: 'email', header: 'E-mail', value: (r) => r.email },
      { key: 'document', header: 'Documento', value: (r) => r.document },
      { key: 'releaseDate', header: 'Previsão de liberação', value: (r) => fmtDate(r.releaseISO) },
      { key: 'paymentMethod', header: 'Forma de pagamento', value: (r) => r.paymentMethod },
      { key: 'installments', header: 'Parcelas pagas', value: (r) => r.installments },
      { key: 'amount', header: 'Valor pendente', value: (r) => fmtMoney(r.amount) },
    ];
    const requested = Array.isArray(fields)
      ? fields.filter((f) => typeof f === 'string')
      : [];
    const cols =
      requested.length > 0
        ? COLUMNS.filter((c) => requested.includes(c.key))
        : COLUMNS;
    // Sem colunas válidas → cai de volta em todas (evita CSV só com cabeçalho vazio).
    const activeCols = cols.length > 0 ? cols : COLUMNS;

    const records: Rec[] = [];
    if (type === 'parcelados') {
      const res = await this.getFinancialInstallments(userId, eventId);
      const installments = (res.data?.installments ?? []) as any[];
      // Agrupa por pedido (1 linha/pedido); parcelas pagas = nº da próxima − 1.
      const byOrder = new Map<string, any[]>();
      for (const inst of installments) {
        const key = inst.orderId || inst.paymentId || inst.id;
        const g = byOrder.get(key);
        if (g) g.push(inst);
        else byOrder.set(key, [inst]);
      }
      for (const group of byOrder.values()) {
        const sorted = [...group].sort(
          (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime(),
        );
        const next = sorted[0];
        const total = next.totalInstallments ?? sorted.length;
        const paid = Math.max(0, (next.installmentNumber ?? 1) - 1);
        const amount = sorted.reduce((s, i) => s + (i.amount ?? 0), 0);
        const buyer = next.buyer ?? {};
        records.push({
          orderId: next.orderId || next.paymentId || '',
          name: buyer.fullName || `${buyer.firstName ?? ''} ${buyer.lastName ?? ''}`.trim(),
          email: buyer.email ?? '',
          document: buyer.documentNumber ?? '',
          releaseISO: next.dueDate,
          paymentMethod: 'Cartão de crédito',
          installments: `${paid}/${total}`,
          amount,
        });
      }
    } else {
      // Percorre todas as páginas (o método pagina em no máx. 100/página).
      let page = 1;
      let hasNext = true;
      while (hasNext && page <= 50) {
        const res = await this.getFinancialPending(userId, eventId, page, 100);
        const pending = (res.data?.pending ?? []) as any[];
        for (const p of pending) {
          const buyer = p.buyer ?? {};
          records.push({
            orderId: p.orderId ?? '',
            name: buyer.fullName || `${buyer.firstName ?? ''} ${buyer.lastName ?? ''}`.trim(),
            email: buyer.email ?? '',
            document: buyer.documentNumber ?? '',
            releaseISO: p.releaseDate,
            paymentMethod: p.paymentMethod === 'PIX' ? 'Pix' : 'Cartão de crédito',
            installments: '',
            amount: p.amount ?? 0,
          });
        }
        hasNext = !!res.data?.pagination?.hasNextPage;
        page += 1;
      }
    }

    const lines: string[] = [];
    lines.push(activeCols.map((c) => esc(c.header)).join(';'));
    for (const r of records) {
      lines.push(activeCols.map((c) => esc(String(c.value(r) ?? ''))).join(';'));
    }

    const csv = lines.join('\r\n');
    const buffer = Buffer.from('﻿' + csv, 'utf-8');
    const safeName = eventName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const suffix = type === 'parcelados' ? 'parcelados' : 'a-vista';
    return {
      buffer,
      filename: `aguardando-liberacao-${suffix}-${safeName}.csv`,
      contentType: 'text/csv; charset=utf-8',
    };
  }

  /**
   * Obtém lista de pagamentos estornados (refunded)
   */
  async getFinancialRefunded(
    userId: string,
    eventId: string,
    page: number = 1,
    limit: number = 20,
    search?: string,
  ) {
    await this.verifyOrganizerAccess(userId, eventId, 'financial');

    const prismaRead = this.prisma.getReadClient();
    const skip = (page - 1) * limit;

    // Página + total via helper canônico: pagina DEPOIS do filtro de refundType
    // (o antigo skip/take ANTES do filtro em memória podia devolver < limit itens)
    // e aplica a busca textual (nome/e-mail/documento/ID/cupom/voucher/método).
    const { ids, total } = await this.queryRegistrationIdsPageForRefundedMetadataFilter(
      prismaRead,
      {
        eventId,
        targetRefundType: 'REFUND',
        search,
        sortBy: 'purchaseDate',
        sortOrder: 'desc',
        skip,
        limit,
      },
    );

    const refunded = await this.mapRefundLikeRegistrationsPage(
      prismaRead,
      ids,
      'refundDate',
      'Estorno solicitado pelo cliente',
    );

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
          total,
          totalPages: Math.ceil(total / limit),
        },
        totalAmount,
      },
    };
  }

  /**
   * Carrega e mapeia a PÁGINA de inscrições (por ids já filtrados/ordenados pelo
   * helper de metadata) para o shape consumido pelos drawers de Estornados/
   * Chargebacks. `dateKey` troca o nome do campo de data (refundDate|chargebackDate)
   * e `defaultReason` o fallback do motivo — únicos pontos que divergem entre os dois.
   */
  private async mapRefundLikeRegistrationsPage(
    prismaRead: PrismaClient,
    ids: string[],
    dateKey: 'refundDate' | 'chargebackDate',
    defaultReason: string,
  ): Promise<any[]> {
    if (ids.length === 0) return [];

    const unsorted = await prismaRead.registration.findMany({
      where: { id: { in: ids } },
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
    });

    // Reordena conforme a ordem paginada dos ids (findMany não preserva ordem do IN).
    const orderMap = new Map(ids.map((id, i) => [id, i]));
    const sorted = [...unsorted].sort(
      (a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0),
    );

    return sorted.map((reg) => {
      const metadata = reg.order?.payment?.metadata as any;
      return {
        id: reg.order?.payment?.id,
        orderId: reg.orderId,
        registrationId: reg.id,
        amount: this.normalizeToCents(reg.order?.finalAmount),
        [dateKey]:
          reg.order?.payment?.updatedAt ||
          reg.order?.payment?.paymentDate ||
          reg.order?.createdAt,
        purchaseDate: reg.order?.createdAt,
        paymentMethod: reg.order?.payment?.method,
        buyer: this.resolveOrderBuyer(reg.order),
        participant: reg.user
          ? {
              id: reg.user.id,
              firstName: reg.user.firstName,
              lastName: reg.user.lastName,
              email: reg.user.email,
              avatarUrl: reg.user.avatarUrl,
            }
          : null,
        // Estorno/chargeback gravam `refundReason`; fallback p/ `reason` (legados).
        reason: metadata?.refundReason || metadata?.reason || defaultReason,
      };
    });
  }

  /**
   * Obtém lista de chargebacks
   */
  async getFinancialChargebacks(
    userId: string,
    eventId: string,
    page: number = 1,
    limit: number = 20,
    search?: string,
  ) {
    await this.verifyOrganizerAccess(userId, eventId, 'financial');

    const prismaRead = this.prisma.getReadClient();
    const skip = (page - 1) * limit;

    // Página + total corretos (pagina DEPOIS do filtro de metadata; substitui o
    // antigo scan em memória com take:5000 que não escalava e ignorava busca) +
    // busca textual server-side por nome/e-mail/documento/ID/cupom/voucher/método.
    const { ids, total } = await this.queryRegistrationIdsPageForRefundedMetadataFilter(
      prismaRead,
      {
        eventId,
        targetRefundType: 'CHARGEBACK',
        search,
        sortBy: 'purchaseDate',
        sortOrder: 'desc',
        skip,
        limit,
      },
    );

    const chargebacks = await this.mapRefundLikeRegistrationsPage(
      prismaRead,
      ids,
      'chargebackDate',
      'Chargeback solicitado pelo banco',
    );

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
          total,
          totalPages: Math.ceil(total / limit),
        },
        totalAmount,
      },
    };
  }

  /**
   * Aplica o filtro de status (valor vindo do front) ao `where`, com a MESMA semântica da
   * LISTA (getRegistrations) — reusado no export pra NÃO divergir. Ponto-chave: o front manda
   * `"COMPLETED"` para "Pago", que NÃO é o status de registro literal — significa PAGO =
   * `status IN [CONFIRMED, COMPLETED]` + `payment PAID`. Usar o valor cru (`where.status =
   * 'COMPLETED'`) perdia todas as CONFIRMED (pagas com evento futuro). CHARGEBACK/REFUNDED
   * filtram por `payment REFUNDED` + metadata (o chamador pós-filtra via `targetRefundType`).
   * Retorna `targetRefundType` quando o chamador precisa refinar por metadata do pagamento.
   */
  private applyRegistrationStatusFilter(
    where: any,
    status: string | undefined,
  ): { targetRefundType: 'CHARGEBACK' | 'REFUND' | null } {
    if (!status) return { targetRefundType: null };
    if (status === 'CHARGEBACK' || status === 'REFUNDED') {
      where.order = { ...where.order, payment: { status: PaymentStatus.REFUNDED } };
      return { targetRefundType: status === 'CHARGEBACK' ? 'CHARGEBACK' : 'REFUND' };
    }
    if (status === 'COMPLETED') {
      where.status = {
        in: [RegistrationStatus.CONFIRMED, RegistrationStatus.COMPLETED],
      } as any;
      where.order = { ...where.order, payment: { status: PaymentStatus.PAID } };
    } else if (status === 'CONFIRMED' || status === 'CANCELLED') {
      where.status = status as RegistrationStatus;
      if (status === 'CANCELLED') {
        // Exclui estorno/chargeback da view "Cancelado" (esses têm filtro próprio).
        if (!where.AND) where.AND = [];
        where.AND.push({ NOT: { order: { payment: { status: PaymentStatus.REFUNDED } } } });
      }
    }
    return { targetRefundType: null };
  }

  /**
   * Resolve os dados do PARTICIPANTE de uma inscrição para as telas do
   * organizador (lista + export), na MESMA ordem de prioridade do modal de
   * detalhe (`registrationsService.findOne`/`resolveParticipant`):
   *   1. `receiptSnapshot.participant` — congelado na compra; é o que o modal
   *      exibe (e a única fonte quando as colunas `participant*` ficaram vazias);
   *   2. `reg.user` — participante com conta vinculada;
   *   3. usuário real achado pelo documento (convidado por CPF que tem cadastro);
   *   4. colunas `participant*` da inscrição (legado).
   *
   * O fallback é campo a campo (não bloco): cobre o caso em que o snapshot tem
   * nome mas a coluna não — e o inverso. Era a causa de o export sair em branco
   * para convidados enquanto o modal mostrava tudo.
   *
   * `userByDoc` é o mapa pré-resolvido por {@link buildParticipantUserByDocMap}
   * (lookup em lote — evita N+1).
   */
  /**
   * Resolve a identidade do COMPRADOR de um pedido para as telas do organizador,
   * preferindo o snapshot congelado (`order.buyerSnapshot`, gravado quando a conta
   * do comprador é excluída/anonimizada) sobre o `order.user` vivo. Sem isso, o
   * bloco "comprador" mostraria os dados anônimos após o usuário excluir a conta.
   * Retorna shape uniforme (superset consumido pelas telas) ou null.
   */
  private resolveOrderBuyer(order: any) {
    const snap = (order?.buyerSnapshot as any) ?? null;
    const src = snap ?? order?.user ?? null;
    if (!src) return null;
    const firstName = src.firstName ?? '';
    const lastName = src.lastName ?? '';
    return {
      id: src.id ?? null,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`.trim(),
      email: src.email ?? null,
      phone: src.phone ?? null,
      documentNumber: src.documentNumber ?? null,
      avatarUrl: src.avatarUrl ?? null,
    };
  }

  private resolveOrganizerParticipant(reg: any, userByDoc: Map<string, any>) {
    const snap = (reg.receiptSnapshot as any)?.participant ?? null;
    const linked = reg.user ?? null;
    const cleanDoc = !linked
      ? reg.participantDocumentNumberClean || reg.participantCpfClean || null
      : null;
    const looked = cleanDoc ? userByDoc.get(cleanDoc) ?? null : null;
    // Cadastro real (vinculado direto ou achado pelo documento).
    const acct = linked ?? looked;

    const nz = (v: any) => (v != null && String(v).trim() !== '' ? v : null);
    const pick = (...vals: any[]) => {
      for (const v of vals) {
        const c = nz(v);
        if (c != null) return c;
      }
      return null;
    };
    const iso = (d: any) =>
      d == null ? null : d instanceof Date ? d.toISOString() : String(d);

    const fullName = pick(
      snap?.name,
      acct ? `${acct.firstName ?? ''} ${acct.lastName ?? ''}`.trim() : null,
      reg.participantName,
    );
    const parts = fullName ? String(fullName).trim().split(/\s+/) : [];

    return {
      id: acct?.id ?? null,
      firstName: parts[0] ?? '',
      lastName: parts.slice(1).join(' '),
      email: pick(snap?.email, acct?.email, reg.participantEmail),
      phone: pick(snap?.phone, acct?.phone, reg.participantPhone),
      documentNumber: pick(
        snap?.documentNumber,
        snap?.cpf,
        acct?.documentNumber,
        reg.participantDocumentNumber,
        reg.participantCpf,
      ),
      documentType: pick(snap?.documentType, acct?.documentType, reg.participantDocumentType),
      country: pick(snap?.country, acct?.country),
      dateOfBirth: pick(snap?.birthDate, iso(acct?.dateOfBirth), iso(reg.participantDateOfBirth)),
      gender: pick(snap?.gender, acct?.gender, reg.participantGender),
      avatarUrl: acct?.avatarUrl ?? null,
    };
  }

  /**
   * Resolve em UMA query os usuários reais dos participantes convidados por
   * documento (sem `user` vinculado e sem participante no `receiptSnapshot`),
   * indexados por `documentNumberClean`. Espelha o PRIORITY 2 do
   * `resolveParticipant`, em lote — evita N+1 no export (sem paginação).
   */
  private async buildParticipantUserByDocMap(
    prismaRead: any,
    registrations: any[],
  ): Promise<Map<string, any>> {
    const docs = new Set<string>();
    for (const reg of registrations) {
      if (reg.user) continue;
      const snap = (reg.receiptSnapshot as any)?.participant;
      const snapHasData =
        snap && (snap.name?.trim() || snap.email?.trim() || snap.documentNumber?.trim());
      if (snapHasData) continue; // snapshot já resolve — não precisa de lookup
      const clean = reg.participantDocumentNumberClean || reg.participantCpfClean;
      if (clean) docs.add(clean);
    }
    if (docs.size === 0) return new Map();

    const users = await prismaRead.user.findMany({
      where: { documentNumberClean: { in: [...docs] }, accountType: 'USER' },
      select: {
        id: true,
        documentNumberClean: true,
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
    });
    return new Map(users.map((u: any) => [u.documentNumberClean, u]));
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
          // `isActive` p/ excluir do export perguntas soft-deletadas (delete = isActive:false).
          question: { select: { id: true, question: true, type: true, isActive: true } },
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
              // `metadata` p/ distinguir estorno (REFUND) de chargeback no status do export.
              metadata: true,
            },
          },
          user: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          // Unidades e cupom do pedido: base p/ reproduzir a distribuição do desconto
          // por ingresso (valor pago por ingresso no export — computeRegistrationPaidValues).
          reservedTickets: {
            select: { ticketId: true, unitPrice: true, quantity: true },
          },
          coupon: { select: { type: true, value: true, appliesTo: true } },
        },
      },
    };

    // Base = não-PENDING (igual à lista). O filtro de status (quando houver) é mapeado pela
    // MESMA lógica da lista — "COMPLETED"=Pago vira [CONFIRMED,COMPLETED]+payment PAID, etc.
    const where: any = { eventId, status: { not: 'PENDING' as any } };
    const statusFilter =
      filters?.status && filters.status !== 'all' ? filters.status : undefined;
    const { targetRefundType } = this.applyRegistrationStatusFilter(where, statusFilter);

    if (filters?.ticketIds?.length) {
      where.tickets = { some: { ticketId: { in: filters.ticketIds } } };
    }

    if (filters?.startDate || filters?.endDate) {
      // MERGE em where.order (o filtro de status pode já ter setado where.order.payment).
      if (!where.order) where.order = {};
      if (!where.order.createdAt) where.order.createdAt = {};
      // Dia civil do seletor → fronteiras do DIA BRT (mesma regra da lista de inscrições).
      if (filters.startDate) where.order.createdAt.gte = brtDayStartUtc(filters.startDate);
      if (filters.endDate) where.order.createdAt.lte = brtDayEndUtc(filters.endDate);
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
      // Inclui nome completo + snapshot do participante (paridade com a listagem).
      const extraIds = await this.findRegistrationExtraSearchMatchIds(
        prismaRead,
        eventId,
        searchTerm,
      );
      const mergedIds = Array.from(new Set([...uuidMatchIds, ...extraIds]));
      where.OR = this.buildRegistrationTextSearchOr(searchTerm, mergedIds);
    }

    let registrations = await prismaRead.registration.findMany({
      where,
      include: includeClause,
      orderBy: [{ order: { createdAt: 'desc' } }, { id: 'asc' }],
    });

    // CHARGEBACK/REFUNDED: separa por `refundType` no metadata. O export pega TUDO (sem
    // paginação), então refina em memória (a lista usa um raw-SQL paginado p/ o mesmo fim).
    if (targetRefundType) {
      registrations = registrations.filter((r: any) =>
        targetRefundType === 'CHARGEBACK'
          ? isChargeback(r.order?.payment?.metadata)
          : !isChargeback(r.order?.payment?.metadata),
      );
    }

    // Lookup em lote dos convidados resolvíveis por documento (PRIORITY 2 do modal).
    const userByDoc = await this.buildParticipantUserByDocMap(prismaRead, registrations);

    // Valor pago POR INGRESSO (ingresso + produtos − cupom/voucher, sem taxa) —
    // reproduz a distribuição do recibo. Calculado sobre as inscrições CRUAS (têm
    // reservedTickets/coupon/products/batch price) antes do map de saída.
    const paidByRegId = computeRegistrationPaidValues(registrations);

    const mapped = registrations.map((reg: any) => {
      // Mesma resolução do modal de detalhe: snapshot → user → doc → colunas.
      const participant = this.resolveOrganizerParticipant(reg, userByDoc);

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
        // O export (campo "ingresso") agrega `reg.tickets[]` (RegistrationTicket[]),
        // preferindo o ticketSnapshot sobre a relação viva. Mantém a estrutura que
        // `extractField` espera: cada item com `ticketSnapshot` + `ticket{name,modality,category}`.
        // (Antes mapeava `ticket` singular, que o extractField não lê → coluna vazia.)
        tickets: (reg.tickets ?? []).map((rt: any) => ({
          ticketSnapshot: rt.ticketSnapshot ?? null,
          ticket: rt.ticket
            ? {
              name: rt.ticket.name ?? null,
              modality: rt.ticket.modality ?? null,
              // Distância + unidade (ex.: 5 + "KM") p/ a coluna "Modalidade" do
              // export ("Corrida 5KM"). Snapshot tem prioridade no extractField.
              distance: rt.ticket.distance ?? null,
              distanceUnit: rt.ticket.distanceUnit ?? null,
              category: rt.ticket.category ? { name: rt.ticket.category.name } : null,
            }
            : null,
        })),
        products: (reg.products ?? []).map((rp: any) => {
          const snap = rp.productSnapshot as Record<string, any> | null;
          return {
            product: { name: snap?.name ?? rp.product?.name ?? '' },
            // Variação: prefere a relação VIVA (rp.variation) — reflete a troca de
            // variação feita pelo cliente (o snapshot fica congelado na compra e
            // mostraria a variação ANTIGA). Igual ao que o organizador vê em
            // getRegistrations. Snapshot só como fallback (variação deletada). [[project_registration_snapshots]]
            variationName: rp.variation?.name ?? snap?.selectedVariation?.name ?? null,
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
          // Preserva 0 (pedido gratuito) em vez de virar null — o export usa isto
          // p/ exibir "R$ 0,00" e "Gratuito" como forma de pagamento.
          finalAmount: order.finalAmount != null ? this.normalizeToCents(order.finalAmount) : null,
          // Valor pago POR INGRESSO desta inscrição (ingresso + produtos − desconto,
          // sem taxa de serviço). Centavos; 0 preservado (pedido grátis).
          paidPerTicket: paidByRegId.get(reg.id) ?? null,
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
   * Igual ao `getRegistrationsForExport`, porém filtrado por USUÁRIO (todos os
   * eventos) em vez de por evento — usado no export CSV do drawer de detalhes do
   * usuário (admin). Reusa o MESMO include + mapeamento → MESMAS colunas do export
   * de inscrições. Sem filtros/refino de status: exporta tudo que não é PENDING.
   */
  async getUserRegistrationsForExport(
    userId: string,
  ): Promise<{ registrations: any[]; eventName: string }> {
    const prismaRead = this.prisma.getReadClient();

    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    const eventName =
      `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Ingressos';

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
          question: { select: { id: true, question: true, type: true, isActive: true } },
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
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          reservedTickets: {
            select: { ticketId: true, unitPrice: true, quantity: true },
          },
          coupon: { select: { type: true, value: true, appliesTo: true } },
        },
      },
    };

    const registrations = await prismaRead.registration.findMany({
      where: { userId, status: { not: 'PENDING' as any } },
      include: includeClause,
      orderBy: [{ order: { createdAt: 'desc' } }, { id: 'asc' }],
    });

    const userByDoc = await this.buildParticipantUserByDocMap(prismaRead, registrations);
    const paidByRegId = computeRegistrationPaidValues(registrations);

    const mapped = registrations.map((reg: any) => {
      const participant = this.resolveOrganizerParticipant(reg, userByDoc);
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
        tickets: (reg.tickets ?? []).map((rt: any) => ({
          ticketSnapshot: rt.ticketSnapshot ?? null,
          ticket: rt.ticket
            ? {
              name: rt.ticket.name ?? null,
              modality: rt.ticket.modality ?? null,
              // Distância + unidade (ex.: 5 + "KM") p/ a coluna "Modalidade" do
              // export ("Corrida 5KM"). Snapshot tem prioridade no extractField.
              distance: rt.ticket.distance ?? null,
              distanceUnit: rt.ticket.distanceUnit ?? null,
              category: rt.ticket.category ? { name: rt.ticket.category.name } : null,
            }
            : null,
        })),
        products: (reg.products ?? []).map((rp: any) => {
          const snap = rp.productSnapshot as Record<string, any> | null;
          return {
            product: { name: snap?.name ?? rp.product?.name ?? '' },
            variationName: rp.variation?.name ?? snap?.selectedVariation?.name ?? null,
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
          finalAmount:
            order.finalAmount != null ? this.normalizeToCents(order.finalAmount) : null,
          paidPerTicket: paidByRegId.get(reg.id) ?? null,
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
