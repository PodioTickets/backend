import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateTicketDto,
  UpdateTicketDto,
  FilterTicketsDto,
  ReorderTicketProductsDto,
  ReorderTicketsDto,
} from './dto/create-ticket.dto';
import { OrganizationsService } from '../organizations/organizations.service';
import { OrderStatus, Prisma, RegistrationStatus } from '@prisma/client';
import {
  summarizeTicketUpdateForAudit,
  type TicketBeforeAudit,
} from './ticket-audit.helpers';
import { CacheRedisService } from '../../common/services/cache-redis.service';
import { stripDeletedTicketFromKitSelectionDisplay } from '../events/kit-selection-display.prune';
import { resolveActiveBatch, type BatchWithSold } from './batch-active.util';

function resolveImageUrl(url: string | null | undefined, baseUrl: string): string | null | undefined {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
}

function batchOrdinalLabel(n: number, total: number): string | null {
  if (total <= 1) return null;
  const ordinals = ['1º', '2º', '3º', '4º', '5º', '6º', '7º', '8º', '9º', '10º'];
  const prefix = ordinals[n - 1] ?? `${n}º`;
  return `${prefix} lote`;
}

function resolveProductImages<T extends { image?: string | null; images?: string[] }>(
  product: T,
  baseUrl: string,
): T {
  return {
    ...product,
    image: resolveImageUrl(product.image, baseUrl) as string | null | undefined,
    images: (product.images ?? []).map((img) => resolveImageUrl(img, baseUrl) as string),
  };
}

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizationsService: OrganizationsService,
    private readonly cache: CacheRedisService,
  ) { }

  /**
   * Cache curto em GET /tickets/events/:eventId (TTL 15s) — **apenas para
   * leitores não-organizadores** (público / visitantes).
   *
   * Aceita-se uma janela de inconsistência de até 15s em vagas vendidas —
   * o checkout tem validação atômica que rejeita reserva de lote esgotado,
   * então o pior caso é UX (usuário vê "disponível" 15s depois de esgotar),
   * nunca venda dupla.
   *
   * Organizer bypassa o cache: precisa ver mudanças (criar/editar/deletar/
   * duplicar/reordenar tickets) imediatamente após a ação, sem aguardar TTL.
   * Como o `findAll` recebe `userId` e calcula `isOrganizer`, basta pular
   * `getJson`/`setJson` quando `isOrganizer === true` — sem necessidade de
   * SCAN ou versionamento.
   */
  private static readonly TICKETS_LIST_CACHE_TTL_SECONDS = 15;
  private ticketsListCacheKey(
    eventId: string,
    isOrganizer: boolean,
    categoryId: string | undefined,
    page: number,
    limit: number,
    includeInactive: boolean,
    baseUrl: string | undefined,
  ): string {
    return `tickets:list:${eventId}:org:${isOrganizer ? 1 : 0}:cat:${categoryId ?? 'all'}:p:${page}:l:${limit}:inact:${includeInactive ? 1 : 0}:base:${baseUrl ?? ''}`;
  }

  async create(
    userId: string,
    eventId: string,
    createTicketDto: CreateTicketDto,
    clientIp?: string | null,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Validações
    if (createTicketDto.batches.length === 0) {
      throw new BadRequestException('Ingresso deve ter pelo menos um lote');
    }

    // Validar ageLimit
    if (createTicketDto.ageLimit && !createTicketDto.ageLimit.min && !createTicketDto.ageLimit.max) {
      throw new BadRequestException('ageLimit must have at least min or max');
    }

    // Validar categoryId se fornecido
    if (createTicketDto.categoryId) {
      const category = await prismaRead.ticketCategory.findUnique({
        where: { id: createTicketDto.categoryId },
      });
      if (!category || category.eventId !== eventId) {
        throw new NotFoundException('Categoria de ingresso não encontrada');
      }
    }

    // Validar kitId se fornecido
    if (createTicketDto.hasKit && createTicketDto.kitId) {
      const kit = await prismaRead.kit.findUnique({
        where: { id: createTicketDto.kitId },
      });
      if (!kit || kit.eventId !== eventId) {
        throw new NotFoundException('Kit não encontrado');
      }
    }

    // Validar productIds se fornecido
    if (createTicketDto.hasKit && createTicketDto.productIds && createTicketDto.productIds.length > 0) {
      const products = await prismaRead.product.findMany({
        where: {
          id: { in: createTicketDto.productIds },
          eventId,
        },
      });
      if (products.length !== createTicketDto.productIds.length) {
        throw new NotFoundException('Um ou mais produtos não encontrados');
      }
    }

    const categoryKey = createTicketDto.categoryId ?? null;
    let nextSortOrder = createTicketDto.sortOrder;
    if (nextSortOrder === undefined) {
      const last = await prismaWrite.ticket.findFirst({
        where: { eventId, categoryId: categoryKey },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      nextSortOrder = last ? last.sortOrder + 1 : 0;
    }

    // Criar ticket com batches; o estoque das variações dos produtos vinculados
    // é sincronizado na MESMA transação (estoque = soma das vagas dos ingressos).
    const ticket = await prismaWrite.$transaction(async (tx) => {
      const created = await tx.ticket.create({
        data: {
          name: createTicketDto.name,
          description: createTicketDto.description,
          categoryId: createTicketDto.categoryId,
          sortOrder: nextSortOrder,
          modality: createTicketDto.modality,
          distance: createTicketDto.distance,
          distanceUnit: createTicketDto.distanceUnit || 'KM',
          gender: createTicketDto.gender || 'all',
          ageLimitMin: createTicketDto.ageLimit?.min,
          ageLimitMax: createTicketDto.ageLimit?.max,
          hasKit: createTicketDto.hasKit || false,
          // kitId/produtos só existem quando o ingresso TEM kit. Sem esse gate, um payload
          // com hasKit=false + productIds/kitId criaria vínculos órfãos e o checkout exibiria
          // produtos num ingresso sem kit.
          kitId: createTicketDto.hasKit ? createTicketDto.kitId : null,
          eventId,
          batches: {
            create: createTicketDto.batches.map((b, i) => ({
              quantity: b.quantity,
              availableQuantity: b.quantity,
              price: b.price,
              startDate: b.startDate ? new Date(b.startDate) : null,
              endDate: b.endDate ? new Date(b.endDate) : null,
              sortOrder: i,
              triggerType: b.triggerType ?? 'BY_TIME',
            })),
          },
          products: createTicketDto.hasKit && createTicketDto.productIds
            ? {
              create: createTicketDto.productIds.map((productId, index) => ({
                productId,
                sortOrder: index,
              })),
            }
            : undefined,
        },
        include: {
          batches: true,
          products: {
            orderBy: { sortOrder: 'asc' },
            include: {
              product: true,
            },
          },
          category: true,
          kit: true,
        },
      });

      return created;
    });

    // Auditoria best-effort: registra a criação do ingresso na trilha da organização.
    const eventRecord = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true, name: true },
    });
    if (eventRecord) {
      await this.organizationsService.recordOrganizationAuditLog({
        organizationId: eventRecord.organizationId,
        actorUserId: userId,
        ip: clientIp ?? null,
        action: `Criou o ingresso "${ticket.name}" no evento "${eventRecord.name}"`,
        metadata: {
          kind: 'TICKET_CREATE',
          eventId,
          ticketId: ticket.id,
        } as Prisma.InputJsonValue,
      });
    }

    return {
      message: 'Ticket created successfully',
      data: { ticket },
    };
  }

  async findAll(eventId: string, filterDto: FilterTicketsDto = {}, baseUrl?: string, userId?: string) {
    // Write client (primary) garante leitura sem lag de réplica,
    // essencial para refletir reservas recém-feitas imediatamente.
    const db = this.prisma.getWriteClient();

    const page = filterDto.page || 1;
    const limit = filterDto.limit || 20;
    const skip = (page - 1) * limit;

    const isOrganizer = userId ? await this.isOrganizerOfEvent(userId, eventId, db) : false;

    // Cache hot path (TTL 15s) apenas para leitores não-organizadores.
    // Organizer bypassa: precisa ver mudanças (criar/editar/deletar/duplicar)
    // imediatamente, sem aguardar o TTL expirar.
    // Fail-open: cache miss → query normal.
    const cacheKey = !isOrganizer
      ? this.ticketsListCacheKey(
          eventId,
          isOrganizer,
          filterDto.categoryId,
          page,
          limit,
          !!filterDto.includeInactive,
          baseUrl,
        )
      : null;
    if (cacheKey) {
      const cached = await this.cache.getJson<unknown>(cacheKey);
      if (cached) return cached as Awaited<ReturnType<TicketsService['findAll']>>;
    }

    const where: any = { eventId };
    if (!filterDto.includeInactive) {
      where.isActive = true;
    }
    if (filterDto.categoryId) {
      where.categoryId = filterDto.categoryId;
    }

    const [tickets, total] = await Promise.all([
      db.ticket.findMany({
        where,
        skip,
        take: limit,
        include: {
          batches: {
            orderBy: { sortOrder: 'asc' },
          },
          products: {
            orderBy: { sortOrder: 'asc' },
            include: {
              product: {
                include: {
                  variations: { orderBy: { sortOrder: 'asc' } },
                },
              },
            },
          },
          category: true,
          kit: {
            include: {
              items: true,
            },
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      db.ticket.count({ where }),
    ]);

    const batchIds = tickets.flatMap((t) => t.batches.map((b) => b.id));

    // Conta inscrições não-canceladas por lote — fonte de verdade para vagas vendidas
    const soldByBatch =
      batchIds.length > 0
        ? await db.registrationTicket.groupBy({
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

    // Teto de vagas do EVENTO: quando atingido, TODOS os ingressos ficam esgotados
    // (mesmo que lotes individuais ainda tenham saldo — o teto é o limite absoluto).
    // Fonte de verdade = Registration != CANCELLED (inclui reservas ativas), o mesmo
    // predicado do enforcement no reserve — assim a lista nunca diverge do que a
    // reserva permite. Só consulta quando o evento TEM teto (2 queries baratas).
    const eventCap = await db.event.findUnique({
      where: { id: eventId },
      select: { maxParticipants: true },
    });
    let eventCapReached = false;
    if (eventCap?.maxParticipants != null) {
      const totalRegistrations = await db.registration.count({
        where: { eventId, status: { not: 'CANCELLED' } },
      });
      eventCapReached = totalRegistrations >= eventCap.maxParticipants;
    }

    // Transformar para o formato esperado
    const transformedTickets = tickets.map((ticket) => {
      const batches: BatchWithSold[] = ticket.batches.map((batch) => ({
        ...batch,
        quantitySold: soldByBatchMap.get(batch.id) ?? 0,
      }));

      const totalQuantity = batches.reduce((sum, b) => sum + b.quantity, 0);
      const totalSold = batches.reduce((sum, b) => sum + b.quantitySold, 0);

      const { batch: activeBatch, batchNumber, status: activeBatchStatus } =
        resolveActiveBatch(batches, now);

      const label = batchOrdinalLabel(batchNumber, batches.length);

      // Esgotado quando: teto do evento atingido OU a regra canônica devolveu
      // SOLD_OUT (ex.: lote por tempo ENCERRADO sem fallback — tem saldo mas a
      // janela fechou). Nesse caso zeramos availableQuantity pra travar o stepper
      // (isAtMax no front) e casar isSoldOut/label com o status; senão o front veria
      // saldo > 0 e deixaria comprar um lote encerrado (bug do "não iniciado").
      const soldOut = eventCapReached || activeBatchStatus === 'SOLD_OUT';
      const effectiveStatus = soldOut ? 'SOLD_OUT' : activeBatchStatus;
      const effectiveAvailable = soldOut ? 0 : activeBatch.availableQuantity;

      return {
        ...ticket,
        price: activeBatch.price,
        totalQuantity,
        availableQuantity: effectiveAvailable,
        quantitySold: totalSold,
        isSoldOut: effectiveAvailable === 0,
        activeBatch,
        activeBatchNumber: batchNumber,
        activeBatchLabel: effectiveStatus === 'SOLD_OUT' && label ? `${label} esgotado` : label,
        activeBatchStatus: effectiveStatus,
        batches,
        ageLimit: {
          min: ticket.ageLimitMin,
          max: ticket.ageLimitMax,
        },
        productIds: ticket.products.map((tp) => tp.productId),
        products: baseUrl
          ? ticket.products.map((tp) => ({
            ...tp,
            product: tp.product ? resolveProductImages(tp.product, baseUrl) : tp.product,
          }))
          : ticket.products,
      };
    });

    const totalPages = Math.ceil(total / limit);

    const response = {
      message: 'Tickets fetched successfully',
      data: {
        tickets: transformedTickets,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      },
    };

    if (cacheKey) {
      await this.cache.setJson(cacheKey, response, TicketsService.TICKETS_LIST_CACHE_TTL_SECONDS);
    }
    return response;
  }

  async findOne(id: string, baseUrl?: string) {
    const prismaRead = this.prisma.getReadClient();
    const ticket = await prismaRead.ticket.findUnique({
      where: { id },
      include: {
        batches: {
          orderBy: { sortOrder: 'asc' },
        },
        products: {
          orderBy: { sortOrder: 'asc' },
          include: {
            product: {
              include: {
                variations: { orderBy: { sortOrder: 'asc' } },
              },
            },
          },
        },
        category: true,
        kit: {
          include: {
            items: true,
          },
        },
        event: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!ticket) {
      throw new NotFoundException('Ingresso não encontrado');
    }

    const batchIds = ticket.batches.map((b) => b.id);
    const soldByBatch =
      batchIds.length > 0
        ? await prismaRead.registrationTicket.groupBy({
          by: ['batchId'],
          where: {
            ticketId: id,
            batchId: { in: batchIds },
            registration: {
              status: { in: ['CONFIRMED', 'COMPLETED'] },
            },
          },
          _count: { id: true },
        })
        : [];
    const soldByBatchMap = new Map(
      soldByBatch.map((s) => [s.batchId, s._count.id]),
    );

    const now = new Date();

    const batches: BatchWithSold[] = ticket.batches.map((batch) => ({
      ...batch,
      quantitySold: soldByBatchMap.get(batch.id) ?? 0,
    }));

    const totalQuantity = batches.reduce((sum, b) => sum + b.quantity, 0);
    const totalSold = batches.reduce((sum, b) => sum + b.quantitySold, 0);

    const { batch: activeBatch, batchNumber, status: activeBatchStatus } =
      resolveActiveBatch(batches, now);

    const label = batchOrdinalLabel(batchNumber, batches.length);

    // SOLD_OUT canônico (inclui lote por tempo encerrado sem fallback) zera o saldo
    // exposto pra casar isSoldOut/label com o status — senão exibiria saldo > 0 num
    // lote encerrado e deixaria comprar.
    const effectiveAvailable =
      activeBatchStatus === 'SOLD_OUT' ? 0 : activeBatch.availableQuantity;

    const transformed = {
      ...ticket,
      price: activeBatch.price,
      totalQuantity,
      availableQuantity: effectiveAvailable,
      quantitySold: totalSold,
      isSoldOut: effectiveAvailable === 0,
      activeBatch,
      activeBatchNumber: batchNumber,
      activeBatchLabel: activeBatchStatus === 'SOLD_OUT' && label ? `${label} esgotado` : label,
      activeBatchStatus,
      batches,
      ageLimit: {
        min: ticket.ageLimitMin,
        max: ticket.ageLimitMax,
      },
      productIds: ticket.products.map((tp) => tp.productId),
      products: baseUrl
        ? ticket.products.map((tp) => ({
          ...tp,
          product: tp.product ? resolveProductImages(tp.product, baseUrl) : tp.product,
        }))
        : ticket.products,
    };

    return {
      message: 'Ticket fetched successfully',
      data: { ticket: transformed },
    };
  }

  async update(
    userId: string,
    eventId: string,
    ticketId: string,
    updateTicketDto: UpdateTicketDto,
    clientIp?: string | null,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const ticket = await prismaRead.ticket.findUnique({
      where: { id: ticketId },
      include: {
        registrations: true,
        products: { select: { productId: true }, orderBy: { sortOrder: 'asc' } },
        batches: {
          select: {
            id: true,
            quantity: true,
            price: true,
            startDate: true,
            endDate: true,
          },
        },
      },
    });

    if (!ticket || ticket.eventId !== eventId) {
      throw new NotFoundException('Ingresso não encontrado');
    }

    // Validações similares ao create
    if (updateTicketDto.batches && updateTicketDto.batches.length === 0) {
      throw new BadRequestException('Ingresso deve ter pelo menos um lote');
    }

    if (updateTicketDto.ageLimit && !updateTicketDto.ageLimit.min && !updateTicketDto.ageLimit.max) {
      throw new BadRequestException('ageLimit must have at least min or max');
    }

    const updateData: any = { ...updateTicketDto };
    delete updateData.batches;
    delete updateData.productIds;
    delete updateData.ageLimit;

    if ('ageLimit' in updateTicketDto) {
      updateData.ageLimitMin = updateTicketDto.ageLimit?.min ?? null;
      updateData.ageLimitMax = updateTicketDto.ageLimit?.max ?? null;
    }

    if (updateTicketDto.categoryId !== undefined) {
      if (updateTicketDto.categoryId) {
        const cat = await prismaRead.ticketCategory.findUnique({
          where: { id: updateTicketDto.categoryId },
        });
        if (!cat || cat.eventId !== eventId) {
          throw new NotFoundException('Categoria de ingresso não encontrada');
        }
      }
      const newCategoryId =
        updateTicketDto.categoryId === null
          ? null
          : updateTicketDto.categoryId;
      const categoryChanging =
        (ticket.categoryId ?? null) !== (newCategoryId ?? null);
      if (categoryChanging && updateTicketDto.sortOrder === undefined) {
        const last = await prismaRead.ticket.findFirst({
          where: { eventId, categoryId: newCategoryId },
          orderBy: { sortOrder: 'desc' },
          select: { sortOrder: true },
        });
        updateData.sortOrder = last ? last.sortOrder + 1 : 0;
      }
    }

    if (updateTicketDto.batches) {
      const existingBatches = await prismaRead.ticketBatch.findMany({
        where: { ticketId },
        select: { id: true },
      });
      const existingIds = new Set(existingBatches.map((b) => b.id));

      const [soldAgg, reservedAgg] = await Promise.all([
        prismaRead.registrationTicket.groupBy({
          by: ['batchId'],
          where: {
            ticketId,
            batchId: { not: null },
            registration: { status: { notIn: ['CANCELLED', 'PENDING'] } },
          },
          _count: { id: true },
        }),
        prismaRead.registrationTicket.groupBy({
          by: ['batchId'],
          where: {
            ticketId,
            batchId: { not: null },
            registration: { status: 'PENDING' },
          },
          _count: { id: true },
        }),
      ]);

      const soldByBatch = new Map<string, number>(
        soldAgg.map((r) => [r.batchId!, r._count.id]),
      );
      const reservedByBatch = new Map<string, number>(
        reservedAgg.map((r) => [r.batchId!, r._count.id]),
      );

      const seenDtoIds = new Set<string>();
      for (const b of updateTicketDto.batches) {
        if (b.id) {
          if (seenDtoIds.has(b.id)) {
            throw new BadRequestException(`Duplicate batch id: ${b.id}`);
          }
          seenDtoIds.add(b.id);
          if (!existingIds.has(b.id)) {
            throw new BadRequestException(
              `Batch id does not belong to this ticket: ${b.id}`,
            );
          }
        }
      }

      const dtoIdSet = new Set(
        updateTicketDto.batches
          .map((b) => b.id)
          .filter((id): id is string => Boolean(id)),
      );

      for (const eid of existingIds) {
        if (!dtoIdSet.has(eid)) {
          const sold = soldByBatch.get(eid) ?? 0;
          if (sold > 0) {
            throw new BadRequestException(
              `Cannot remove a batch that has sales (${sold} registration(s)). Include its id in batches to keep it.`,
            );
          }
        }
      }

      for (const b of updateTicketDto.batches) {
        const sold = b.id ? (soldByBatch.get(b.id) ?? 0) : 0;
        const reserved = b.id ? (reservedByBatch.get(b.id) ?? 0) : 0;
        const minimum = sold + reserved;
        if (b.quantity < minimum) {
          const parts: string[] = [];
          if (sold > 0) parts.push(`${sold} vendida${sold !== 1 ? 's' : ''}`);
          if (reserved > 0) parts.push(`${reserved} reservada${reserved !== 1 ? 's' : ''} aguardando pagamento`);
          throw new BadRequestException(
            `A quantidade do lote deve ser de no mínimo ${minimum} vaga${minimum !== 1 ? 's' : ''}.`,
          );
        }
      }
    }

    // Ingresso SEM kit não pode manter vínculos de produto nem kitId. Vale tanto quando o kit
    // é desligado neste update (hasKit=false) quanto pra higienizar dados legados órfãos no
    // próximo save. `?? ticket.hasKit`: se o payload não reenvia hasKit, mantém o estado atual.
    const resultingHasKit = updateTicketDto.hasKit ?? ticket.hasKit;
    if (!resultingHasKit) {
      updateData.kitId = null;
    }

    // Valida os produtos apenas quando eles serão de fato vinculados (ingresso com kit).
    // Ao desligar o kit, um productIds residual no payload é ignorado — não deve gerar erro.
    if (
      updateTicketDto.productIds !== undefined &&
      updateTicketDto.productIds.length > 0 &&
      resultingHasKit
    ) {
      const allProducts = await prismaWrite.product.findMany({
        where: {
          id: { in: updateTicketDto.productIds },
        },
        select: {
          id: true,
          eventId: true,
          name: true,
        },
      });
      const foundIds = allProducts.map(p => p.id);
      const missingIds = updateTicketDto.productIds.filter(id => !foundIds.includes(id));

      if (missingIds.length > 0) {
        throw new NotFoundException(`Products not found: ${missingIds.join(', ')}`);
      }
      const wrongEventProducts = allProducts.filter(p => p.eventId !== eventId);
      if (wrongEventProducts.length > 0) {
        const productNames = wrongEventProducts.map(p => p.name).join(', ');
        throw new BadRequestException(
          `Products do not belong to this event: ${productNames}`
        );
      }
    }
    updateData.products = undefined;

    const { labels: auditLabels, changes: auditChanges } =
      summarizeTicketUpdateForAudit(
        ticket as unknown as TicketBeforeAudit,
        updateData,
        updateTicketDto,
      );

    // Usa transação para garantir atomicidade
    const updatedTicket = await prismaWrite.$transaction(async (tx) => {
      // Sincroniza os vínculos de produto. Limpa quando o ingresso ficou sem kit
      // (resultingHasKit=false) OU quando um novo productIds foi enviado; só recria os
      // produtos quando o ingresso realmente tem kit. Assim, desligar o kit remove os
      // vínculos mesmo que o payload não reenvie productIds (fonte do "ingresso sem kit
      // mostrando produtos").
      const shouldSyncProducts =
        !resultingHasKit || updateTicketDto.productIds !== undefined;
      if (shouldSyncProducts) {
        await tx.ticketProduct.deleteMany({
          where: { ticketId },
        });

        const productIdsToLink = resultingHasKit
          ? (updateTicketDto.productIds ?? [])
          : [];
        if (productIdsToLink.length > 0) {
          await tx.ticketProduct.createMany({
            data: productIdsToLink.map((productId, index) => ({
              ticketId,
              productId,
              sortOrder: index,
            })),
          });
        }
      }

      if (updateTicketDto.batches) {
        const stillExisting = await tx.ticketBatch.findMany({
          where: { ticketId },
          select: { id: true },
        });
        const stillIds = new Set(stillExisting.map((b) => b.id));
        const keepIds = new Set(
          updateTicketDto.batches
            .map((b) => b.id)
            .filter((id): id is string => Boolean(id)),
        );
        for (const eid of stillIds) {
          if (!keepIds.has(eid)) {
            await tx.ticketBatch.delete({ where: { id: eid } });
          }
        }
        for (const [i, b] of updateTicketDto.batches.entries()) {
          const baseData = {
            price: b.price,
            startDate: b.startDate ? new Date(b.startDate) : null,
            endDate: b.endDate ? new Date(b.endDate) : null,
            sortOrder: i,
            triggerType: b.triggerType ?? 'BY_TIME',
          };
          if (b.id) {
            // Lote existente: preserva vendas já realizadas ao recalcular availableQuantity
            const sold = await tx.registrationTicket.count({
              where: {
                batchId: b.id,
                registration: { status: { not: 'CANCELLED' } },
              },
            });
            const availableQuantity = Math.max(0, b.quantity - sold);
            await tx.ticketBatch.update({
              where: { id: b.id },
              data: { ...baseData, quantity: b.quantity, availableQuantity },
            });
          } else {
            // Lote novo: availableQuantity começa igual à capacidade total
            await tx.ticketBatch.create({
              data: { ...baseData, quantity: b.quantity, availableQuantity: b.quantity, ticketId },
            });
          }
        }
      }

      // Atualizar o ticket
      const updated = await tx.ticket.update({
        where: { id: ticketId },
        data: updateData,
        include: {
          batches: true,
          products: {
            orderBy: { sortOrder: 'asc' },
            include: {
              product: true,
            },
          },
          category: true,
          kit: true,
        },
      });

      return updated;
    });

    const batchIdsAfter = updatedTicket.batches.map((b) => b.id);
    const soldAfterUpdate =
      batchIdsAfter.length > 0
        ? await prismaRead.registrationTicket.groupBy({
          by: ['batchId'],
          where: { ticketId, batchId: { in: batchIdsAfter } },
          _count: { id: true },
        })
        : [];
    const soldAfterMap = new Map(
      soldAfterUpdate.map((s) => [s.batchId!, s._count.id]),
    );

    const transformed = {
      ...updatedTicket,
      batches: updatedTicket.batches.map((batch) => ({
        ...batch,
        quantitySold: soldAfterMap.get(batch.id) ?? 0,
      })),
      ageLimit: {
        min: updatedTicket.ageLimitMin,
        max: updatedTicket.ageLimitMax,
      },
      productIds: updatedTicket.products.map((tp) => tp.productId),
    };

    const eventRecord = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true, name: true },
    });
    if (eventRecord) {
      await this.organizationsService.recordOrganizationAuditLog({
        organizationId: eventRecord.organizationId,
        actorUserId: userId,
        ip: clientIp ?? null,
        action: `Editou o ingresso "${updatedTicket.name}" do evento "${eventRecord.name}"`,
        metadata: {
          kind: 'TICKET_UPDATE',
          eventId,
          ticketId,
          fieldsEdited: auditLabels,
          changes: auditChanges,
        } as Prisma.InputJsonValue,
      });
    }

    return {
      message: 'Ticket updated successfully',
      data: { ticket: transformed },
    };
  }

  async remove(
    userId: string,
    eventId: string,
    ticketId: string,
    clientIp?: string | null,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const ticket = await prismaWrite.ticket.findUnique({
      where: { id: ticketId },
      include: {
        registrations: {
          where: { registration: { status: { not: RegistrationStatus.CANCELLED } } },
          take: 1,
        },
        reservedTickets: {
          where: { order: { status: { not: OrderStatus.CANCELLED } } },
          take: 1,
        },
      },
    });

    if (!ticket || ticket.eventId !== eventId || !ticket.isActive) {
      throw new NotFoundException('Ingresso não encontrado');
    }

    const hasSales = ticket.registrations.length > 0 || ticket.reservedTickets.length > 0;

    if (hasSales) {
      // Soft delete: ticket continua no evento (isActive=false), então não há
      // ID órfão em kitSelectionDisplay — não precisa de prune.
      await prismaWrite.ticket.update({
        where: { id: ticketId },
        data: { isActive: false },
      });
    } else {
      // Hard delete: ticket some do banco; o ticketId pode estar como chave em
      // event.kitSelectionDisplay.primaryKitProductByTicketId e quebraria a
      // validação no próximo PATCH /events/:id. Limpa o JSON na mesma tx.
      await prismaWrite.$transaction(async (tx) => {
        const ev = await tx.event.findUnique({
          where: { id: eventId },
          select: { kitSelectionDisplay: true },
        });
        if (ev?.kitSelectionDisplay != null) {
          const { next, changed } = stripDeletedTicketFromKitSelectionDisplay(
            ev.kitSelectionDisplay,
            ticketId,
          );
          if (changed) {
            await tx.event.update({
              where: { id: eventId },
              data: { kitSelectionDisplay: next },
            });
          }
        }
        await tx.ticket.delete({ where: { id: ticketId } });
      });
    }

    // Auditoria best-effort: registra a exclusão do ingresso na trilha da organização.
    const eventRecord = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true, name: true },
    });
    if (eventRecord) {
      await this.organizationsService.recordOrganizationAuditLog({
        organizationId: eventRecord.organizationId,
        actorUserId: userId,
        ip: clientIp ?? null,
        action: `Excluiu o ingresso "${ticket.name}" do evento "${eventRecord.name}"`,
        metadata: {
          kind: 'TICKET_DELETE',
          eventId,
          ticketId,
        } as Prisma.InputJsonValue,
      });
    }

    return {
      message: 'Ticket deleted successfully',
    };
  }

  async duplicate(
    userId: string,
    eventId: string,
    ticketId: string,
    clientIp?: string | null,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Buscar o ticket original com todas as relações
    const originalTicket = await prismaRead.ticket.findUnique({
      where: { id: ticketId },
      include: {
        batches: true,
        products: true,
      },
    });

    if (!originalTicket || originalTicket.eventId !== eventId) {
      throw new NotFoundException('Ingresso não encontrado');
    }

    const lastInGroup = await prismaRead.ticket.findFirst({
      where: {
        eventId,
        categoryId: originalTicket.categoryId,
      },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const duplicateSortOrder = lastInGroup ? lastInGroup.sortOrder + 1 : 0;

    // Criar novo ticket com os mesmos dados, mas com novo nome (adicionando "Cópia").
    // O estoque dos produtos vinculados é re-sincronizado na MESMA transação: a
    // cópia (ativa) soma suas vagas ao total de cada produto compartilhado.
    const duplicatedTicket = await prismaWrite.$transaction(async (tx) => {
      const created = await tx.ticket.create({
        data: {
          name: `${originalTicket.name} (Cópia)`,
          description: originalTicket.description,
          categoryId: originalTicket.categoryId,
          sortOrder: duplicateSortOrder,
          modality: originalTicket.modality,
          distance: originalTicket.distance,
          distanceUnit: originalTicket.distanceUnit,
          gender: originalTicket.gender,
          ageLimitMin: originalTicket.ageLimitMin,
          ageLimitMax: originalTicket.ageLimitMax,
          hasKit: originalTicket.hasKit,
          kitId: originalTicket.kitId,
          eventId: originalTicket.eventId,
          isActive: originalTicket.isActive,
          batches: {
            // Preservar sortOrder/triggerType do lote original — sem eles, todos
            // os lotes da cópia caíam no default (0 / BY_TIME) e o 2º lote em
            // diante perdia a configuração de ativação e a ordem.
            create: originalTicket.batches.map((batch) => ({
              quantity: batch.quantity,
              availableQuantity: batch.quantity,
              price: batch.price,
              startDate: batch.startDate,
              endDate: batch.endDate,
              sortOrder: batch.sortOrder,
              triggerType: batch.triggerType,
            })),
          },
          products: originalTicket.products.length > 0
            ? {
              create: [...originalTicket.products]
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((tp, index) => ({
                  productId: tp.productId,
                  sortOrder: index,
                })),
            }
            : undefined,
        },
        include: {
          batches: true,
          products: {
            orderBy: { sortOrder: 'asc' },
            include: {
              product: true,
            },
          },
          category: true,
          kit: true,
        },
      });

      return created;
    });

    const transformed = {
      ...duplicatedTicket,
      // Explícito para garantir o campo no payload mesmo após spread.
      // `categoryId` é null quando o ticket é avulso (sem categoria).
      categoryId: duplicatedTicket.categoryId,
      ageLimit: {
        min: duplicatedTicket.ageLimitMin,
        max: duplicatedTicket.ageLimitMax,
      },
      productIds: duplicatedTicket.products.map((tp) => tp.productId),
    };

    // Auditoria best-effort: registra a duplicação do ingresso na trilha da organização.
    const eventRecord = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true, name: true },
    });
    if (eventRecord) {
      await this.organizationsService.recordOrganizationAuditLog({
        organizationId: eventRecord.organizationId,
        actorUserId: userId,
        ip: clientIp ?? null,
        action: `Duplicou o ingresso "${duplicatedTicket.name}" no evento "${eventRecord.name}"`,
        metadata: {
          kind: 'TICKET_DUPLICATE',
          eventId,
          ticketId: duplicatedTicket.id,
        } as Prisma.InputJsonValue,
      });
    }

    return {
      message: 'Ticket duplicated successfully',
      data: { ticket: transformed },
    };
  }

  /**
   * Atualiza apenas sortOrder dos vínculos ticket–produto.
   * Uma query UPDATE com VALUES (evita N round-trips) dentro de transação.
   */
  async reorderTicketProducts(
    userId: string,
    eventId: string,
    ticketId: string,
    dto: ReorderTicketProductsDto,
    clientIp?: string | null,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const ticket = await prismaRead.ticket.findUnique({
      where: { id: ticketId },
      select: {
        eventId: true,
        name: true,
        products: {
          select: { productId: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!ticket || ticket.eventId !== eventId) {
      throw new NotFoundException('Ingresso não encontrado');
    }

    const currentIds = ticket.products.map((p) => p.productId);
    const { productIds } = dto;

    if (currentIds.length !== productIds.length) {
      throw new BadRequestException(
        'productIds must list every product linked to this ticket exactly once, in the new order',
      );
    }

    const currentSet = new Set(currentIds);
    for (const pid of productIds) {
      if (!currentSet.has(pid)) {
        throw new BadRequestException(
          `Product ${pid} is not linked to this ticket`,
        );
      }
    }

    await prismaWrite.$transaction(async (tx) => {
      if (productIds.length === 0) {
        return;
      }
      const valueRows = Prisma.join(
        productIds.map((id, i) => Prisma.sql`(${id}::uuid, ${i}::int)`),
        ', ',
      );
      await tx.$executeRaw`
        UPDATE "TicketProduct" AS tp
        SET "sortOrder" = v.ord
        FROM (VALUES ${valueRows}) AS v(pid, ord)
        WHERE tp."ticketId" = ${ticketId}::uuid AND tp."productId" = v.pid
      `;
    });

    const updated = await prismaRead.ticket.findUnique({
      where: { id: ticketId },
      include: {
        products: {
          orderBy: { sortOrder: 'asc' },
          include: { product: true },
        },
      },
    });

    const eventRecord = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true, name: true },
    });
    if (eventRecord) {
      await this.organizationsService.recordOrganizationAuditLog({
        organizationId: eventRecord.organizationId,
        actorUserId: userId,
        ip: clientIp ?? null,
        action: `Reordenou os produtos do ingresso "${ticket.name}" do evento "${eventRecord.name}"`,
        metadata: {
          kind: 'TICKET_PRODUCTS_REORDER',
          eventId,
          ticketId,
          productIds,
        } as Prisma.InputJsonValue,
      });
    }

    return {
      message: 'Ticket products reordered successfully',
      data: {
        ticketId,
        productIds: updated?.products.map((tp) => tp.productId) ?? [],
      },
    };
  }

  /**
   * Define sortOrder (0..n) para todos os ingressos do mesmo grupo: mesma categoryId ou sem categoria.
   */
  async reorderTickets(
    userId: string,
    eventId: string,
    dto: ReorderTicketsDto,
    clientIp?: string | null,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const categoryId = dto.categoryId ?? null;

    const inGroup = await prismaRead.ticket.findMany({
      where: {
        eventId,
        categoryId,
        isActive: true,
      },
      select: { id: true },
    });
    const groupSet = new Set(inGroup.map((t) => t.id));
    const incoming = dto.ticketIds;

    if (incoming.length !== groupSet.size) {
      throw new BadRequestException(
        'ticketIds must list every active ticket in this category scope exactly once',
      );
    }
    if (new Set(incoming).size !== incoming.length) {
      throw new BadRequestException('ticketIds must not contain duplicates');
    }
    for (const id of incoming) {
      if (!groupSet.has(id)) {
        throw new BadRequestException(
          `Ticket ${id} is not in this category scope or is inactive`,
        );
      }
    }

    await prismaWrite.$transaction(
      incoming.map((id, index) =>
        prismaWrite.ticket.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );

    const eventRecord = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true, name: true },
    });
    if (eventRecord) {
      await this.organizationsService.recordOrganizationAuditLog({
        organizationId: eventRecord.organizationId,
        actorUserId: userId,
        ip: clientIp ?? null,
        action: `Reordenou ingressos do evento "${eventRecord.name}"`,
        metadata: {
          kind: 'TICKETS_REORDER',
          eventId,
          categoryId,
          ticketIds: incoming,
        } as Prisma.InputJsonValue,
      });
    }

    return {
      message: 'Tickets reordered successfully',
      data: { categoryId, ticketIds: incoming },
    };
  }

  private async isOrganizerOfEvent(userId: string, eventId: string, prisma: any): Promise<boolean> {
    // Admin/staff contam como organizador — espelha o bypass do verifyOrganizerAccess.
    // Sem isso, um ADMIN que não é membro da organização caía no cache público de
    // 15s do findAll e via lista DESATUALIZADA logo após criar/editar/deletar
    // ingresso (ex.: DELETE seguido de GET /tickets-management ainda trazia o
    // ingresso deletado).
    const [user, event] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { role: true } }),
      prisma.event.findUnique({ where: { id: eventId }, select: { organizationId: true } }),
    ]);
    if (user?.role === 'ADMIN' || user?.role === 'PODIOGO_STAFF') return true;
    if (!event) return false;
    const member = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: event.organizationId, userId } },
    });
    return !!member;
  }

  private async verifyOrganizerAccess(userId: string, eventId: string) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Admin/staff bypassa checagens de organização
    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (user?.role === 'ADMIN' || user?.role === 'PODIOGO_STAFF') return;

    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    // Verificar se o usuário é membro da organização do evento
    const member = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: event.organizationId,
          userId,
        },
      },
    });

    if (!member) {
      throw new BadRequestException('Usuário não é membro da organização deste evento');
    }
  }
}
