/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PaymentMethod, PaymentStatus, RegistrationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from '../payments/cielo.service';
import { OrdersRedisService } from './orders-redis.service';
import { ReserveOrderDto } from './dto/reserve-order.dto';
import { PatchParticipantsDto } from './dto/patch-participants.dto';
import { PatchProductsDto } from './dto/patch-products.dto';
import { PatchBillingAddressDto } from './dto/patch-billing-address.dto';
import { PayOrderDto } from './dto/pay-order.dto';

// ─── typed error helpers ─────────────────────────────────────────────────────

class AppConflictException extends ConflictException {
  constructor(code: string, message: string) {
    super({ code, message });
  }
}

class AppUnprocessableException extends UnprocessableEntityException {
  constructor(code: string, message: string) {
    super({ code, message });
  }
}

// ─── batch resolver (mesma lógica do tickets service) ────────────────────────

function resolveActiveBatchForReserve(
  batches: Array<{
    id: string;
    quantity: number;
    availableQuantity: number;
    price: number;
    startDate: Date | null;
    endDate: Date | null;
    sortOrder: number;
    triggerType: string;
    quantitySold: number;
  }>,
  now: Date,
) {
  const sorted = [...batches].sort((a, b) => a.sortOrder - b.sortOrder);
  let activeIdx = 0;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[activeIdx];
    const curr = sorted[i];
    if (curr.triggerType === 'AFTER_PREVIOUS_SOLD_OUT') {
      if (prev.quantitySold >= prev.quantity) activeIdx = i;
    } else {
      if (curr.startDate && now >= curr.startDate) activeIdx = i;
    }
  }

  return sorted[activeIdx];
}

// ─── constants ───────────────────────────────────────────────────────────────

const RESERVATION_TTL_MINUTES = Number(process.env.RESERVATION_TTL_MINUTES ?? 30);
const MAX_TICKETS_PER_ORDER = 20;

// ─── shape helper ────────────────────────────────────────────────────────────

function orderShape(order: any): Record<string, any> {
  return {
    id: order.id,
    eventId: order.eventId,
    status: order.status,
    totalAmount: order.totalAmount,
    serviceFee: order.serviceFee,
    discount: order.discount,
    finalAmount: order.finalAmount,
    expiresAt: order.expiresAt ?? null,
    reservedAt: order.reservedAt ?? null,
    cancelledAt: order.cancelledAt ?? null,
    cancelledReason: order.cancelledReason ?? null,
    reservedTickets: order.reservedTickets ?? [],
    pendingParticipants: order.pendingParticipants ?? null,
    pendingProducts: order.pendingProducts ?? null,
    billingCountry: order.billingCountry ?? null,
    billingPostalCode: order.billingPostalCode ?? null,
    billingStateUf: order.billingStateUf ?? null,
    billingStreet: order.billingStreet ?? null,
    billingNumber: order.billingNumber ?? null,
    billingComplement: order.billingComplement ?? null,
    billingNeighborhood: order.billingNeighborhood ?? null,
    billingCity: order.billingCity ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    serverTime: new Date(),
  };
}

// ─── service ─────────────────────────────────────────────────────────────────

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cieloService: CieloService,
    private readonly redisService: OrdersRedisService,
  ) {}

  // ── 1. reserve ─────────────────────────────────────────────────────────────

  async reserve(userId: string, dto: ReserveOrderDto): Promise<Record<string, any>> {
    const r: any = this.prisma.getReadClient();
    const w: any = this.prisma.getWriteClient();

    // 1.1 Rate limit
    const allowed = await this.redisService.checkRateLimit(userId, 5, 60);
    if (!allowed) {
      throw new HttpException(
        {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Muitas tentativas. Aguarde alguns segundos e tente novamente.',
        },
        429,
      );
    }

    // 1.2 Cap: max 3 PENDING orders per user (ignora pedidos já expirados)
    const pendingCount = await r.order.count({
      where: {
        userId,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
    });
    if (pendingCount >= 3) {
      throw new AppConflictException(
        'TOO_MANY_PENDING_ORDERS',
        'Você já possui 3 pedidos pendentes. Conclua ou cancele-os antes de reservar um novo.',
      );
    }

    // 1.3 Ticket duplicates — cada ticketId deve aparecer uma única vez no array
    const ticketIdsSeen = new Set<string>();
    for (const t of dto.tickets) {
      if (ticketIdsSeen.has(t.ticketId)) {
        throw new AppUnprocessableException(
          'DUPLICATE_TICKET_ID',
          `ticketId "${t.ticketId}" aparece mais de uma vez. Para reservar múltiplas vagas use quantity.`,
        );
      }
      ticketIdsSeen.add(t.ticketId);
    }

    // 1.4 Ticket limit per order
    const totalTickets = dto.tickets.reduce((sum, t) => sum + t.quantity, 0);
    if (totalTickets > MAX_TICKETS_PER_ORDER) {
      throw new AppUnprocessableException(
        'ORDER_TICKET_LIMIT_EXCEEDED',
        `Limite de ${MAX_TICKETS_PER_ORDER} ingressos por pedido excedido. Total solicitado: ${totalTickets}.`,
      );
    }

    // 1.5 Validate event
    const event = await r.event.findUnique({
      where: { id: dto.eventId },
      select: {
        id: true,
        name: true,
        status: true,
        registrationStartDate: true,
        registrationEndDate: true,
      },
    });
    if (!event) throw new NotFoundException('Evento não encontrado');
    if (event.status !== 'PUBLISHED') {
      throw new AppConflictException(
        'EVENT_NOT_PUBLISHED',
        'Evento não está disponível para compra',
      );
    }
    const now = new Date();
    if (event.registrationStartDate && now < new Date(event.registrationStartDate)) {
      throw new AppConflictException(
        'REGISTRATION_NOT_OPEN',
        'Inscrições ainda não abertas para este evento',
      );
    }
    if (event.registrationEndDate && now > new Date(event.registrationEndDate)) {
      throw new AppConflictException('REGISTRATION_CLOSED', 'Período de inscrição encerrado');
    }

    // 1.6 Idempotency: return existing PENDING order somente se os tickets/quantidades
    // forem idênticos ao pedido atual. Se forem diferentes, cancela o antigo e cria novo.
    const existingPending = await r.order.findFirst({
      where: {
        userId,
        eventId: dto.eventId,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      include: { reservedTickets: true },
    });
    if (existingPending) {
      const existingItems = (existingPending.reservedTickets as any[])
        .map((rt) => `${rt.ticketId}:${rt.quantity}`)
        .sort()
        .join(',');
      const requestedItems = dto.tickets
        .map((t) => `${t.ticketId}:${t.quantity}`)
        .sort()
        .join(',');

      if (existingItems === requestedItems) {
        this.logger.log(
          `Reserve idempotent: returning existing order ${existingPending.id} for user ${userId}`,
        );
        return orderShape(existingPending);
      }

      // Pedido existente tem tickets diferentes — cancela e permite criar novo
      this.logger.log(
        `Reserve: cancelling stale pending order ${existingPending.id} (different tickets) for user ${userId}`,
      );
      const w2: any = this.prisma.getWriteClient();
      await this.cancelOrderAndRestoreStock(existingPending.id, 'REPLACED', w2);
    }

    // 1.7 Validate each ticket/batch
    type BatchInfo = {
      batchId: string;
      ticketId: string;
      quantity: number;
      unitPrice: number;
      ticketName: string;
    };
    const batchInfos: BatchInfo[] = [];

    for (const item of dto.tickets) {
      const ticket = await r.ticket.findUnique({
        where: { id: item.ticketId },
        select: { id: true, name: true, isActive: true, eventId: true },
      });
      if (!ticket || !ticket.isActive) {
        throw new NotFoundException(`Ingresso ${item.ticketId} não encontrado ou inativo`);
      }
      if (ticket.eventId !== dto.eventId) {
        throw new NotFoundException(`Ingresso ${item.ticketId} não pertence a este evento`);
      }

      // Busca todos os lotes do ingresso para resolver o lote ativo
      const allBatches = await r.ticketBatch.findMany({
        where: { ticketId: item.ticketId },
        select: {
          id: true,
          ticketId: true,
          price: true,
          quantity: true,
          availableQuantity: true,
          startDate: true,
          endDate: true,
          sortOrder: true,
          triggerType: true,
        },
        orderBy: { sortOrder: 'asc' },
      });

      if (allBatches.length === 0) {
        throw new NotFoundException(
          `Nenhum lote encontrado para o ingresso "${ticket.name}"`,
        );
      }

      // Conta vendas confirmadas por lote para resolução do lote ativo
      const batchIds = allBatches.map((b) => b.id);
      const soldAgg = await r.registrationTicket.groupBy({
        by: ['batchId'],
        where: { batchId: { in: batchIds }, registration: { status: { not: 'CANCELLED' } } },
        _count: { id: true },
      });
      const soldMap = new Map(soldAgg.map((s) => [s.batchId, s._count.id]));
      const batchesWithSold = allBatches.map((b) => ({
        ...b,
        quantitySold: soldMap.get(b.id) ?? 0,
      }));

      // Resolve o lote ativo com a mesma lógica do endpoint de tickets
      const activeBatch = resolveActiveBatchForReserve(batchesWithSold, now);

      // Se batchId foi enviado, valida que é o lote ativo
      if (item.batchId && item.batchId !== activeBatch.id) {
        throw new AppConflictException(
          'BATCH_NOT_ACTIVE',
          `O lote enviado não é o lote ativo para "${ticket.name}". Use o lote ${activeBatch.id}.`,
        );
      }

      const batch = activeBatch;

      if (batch.startDate && now < new Date(batch.startDate)) {
        throw new AppConflictException(
          'BATCH_NOT_STARTED',
          `Lote ainda não iniciado para o ingresso "${ticket.name}"`,
        );
      }
      if (batch.endDate && now > new Date(batch.endDate)) {
        throw new AppConflictException(
          'BATCH_EXPIRED',
          `Lote encerrado para o ingresso "${ticket.name}"`,
        );
      }

      // Camada 1 — pre-check otimista antes de entrar na transaction
      if (batch.availableQuantity < item.quantity) {
        throw new AppConflictException(
          'BATCH_SOLD_OUT',
          `Sem vagas disponíveis para o ingresso "${ticket.name}". Lote esgotado.`,
        );
      }

      batchInfos.push({
        batchId: batch.id,
        ticketId: item.ticketId,
        quantity: item.quantity,
        unitPrice: batch.price,
        ticketName: ticket.name,
      });
    }

    // 1.8 Atomic stock decrement + order creation inside a single transaction
    const order = await w.$transaction(async (tx: any) => {
      // Decrement availableQuantity atomically; 0 rows → sold out → rollback
      // A condição dupla garante consistência mesmo se availableQuantity estiver
      // fora de sincronia com o banco (ex: após update do lote pelo organizador):
      //   1) availableQuantity >= quantity_solicitada  (counter atômico)
      //   2) quantity - vendas_reais >= quantity_solicitada  (fonte de verdade)
      for (const info of batchInfos) {
        const rows: any[] = await tx.$queryRaw`
          UPDATE "TicketBatch" tb
          SET "availableQuantity" = tb."availableQuantity" - ${info.quantity}
          WHERE tb.id = ${info.batchId}::uuid
            AND tb."availableQuantity" >= ${info.quantity}
            AND (
              tb."quantity" - (
                SELECT COUNT(*)::int
                FROM "RegistrationTicket" rt
                JOIN "Registration" r ON rt."registrationId" = r.id
                WHERE rt."batchId" = tb.id
                  AND r.status != 'CANCELLED'
              )
            ) >= ${info.quantity}
          RETURNING tb.id
        `;
        if (!rows || rows.length === 0) {
          throw new AppConflictException(
            'BATCH_SOLD_OUT',
            `Sem vagas disponíveis para o ingresso "${info.ticketName}". Lote esgotado.`,
          );
        }
      }

      // 1.7 Calculate totals
      const totalAmount = batchInfos.reduce(
        (sum, info) => sum + info.unitPrice * info.quantity,
        0,
      );

      // 1.8 Create Order
      const createdOrder = await tx.order.create({
        data: {
          userId,
          eventId: dto.eventId,
          totalAmount,
          serviceFee: 0,
          discount: 0,
          finalAmount: totalAmount,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000),
          reservedAt: new Date(),
        },
      });

      // 1.9 Create OrderReservedTicket rows
      for (const info of batchInfos) {
        await tx.orderReservedTicket.create({
          data: {
            orderId: createdOrder.id,
            ticketId: info.ticketId,
            batchId: info.batchId,
            quantity: info.quantity,
            unitPrice: info.unitPrice,
            ticketName: info.ticketName,
          },
        });
      }

      // 1.10 Create placeholder PENDING Registrations (one per ingresso reservado)
      // Permite que o organizador veja as vagas ocupadas mesmo antes do pagamento.
      // Ao pagar: registrations são deletadas e recriadas como CONFIRMED com dados reais.
      // Ao cancelar/expirar: registrations são marcadas como CANCELLED.
      for (const info of batchInfos) {
        for (let i = 0; i < info.quantity; i++) {
          const reg = await tx.registration.create({
            data: {
              eventId: dto.eventId,
              orderId: createdOrder.id,
              userId,
              status: 'PENDING',
              termsAccepted: false,
              rulesAccepted: false,
            },
          });
          await tx.registrationTicket.create({
            data: {
              registrationId: reg.id,
              ticketId: info.ticketId,
              batchId: info.batchId,
            },
          });
        }
      }

      return tx.order.findUnique({
        where: { id: createdOrder.id },
        include: { reservedTickets: true },
      });
    });

    this.logger.log(`Reserved order ${order.id} for user ${userId}, event ${dto.eventId}`);
    return orderShape(order);
  }

  // ── 2. findOrder ───────────────────────────────────────────────────────────

  async findOrder(userId: string, orderId: string): Promise<Record<string, any>> {
    const r: any = this.prisma.getReadClient();
    const order = await r.order.findUnique({
      where: { id: orderId },
      include: { reservedTickets: true },
    });
    // Anti-IDOR: always 404
    if (!order || order.userId !== userId) {
      throw new NotFoundException('Pedido não encontrado');
    }
    return orderShape(order);
  }

  // ── 2b. getOrderDetails ────────────────────────────────────────────────────

  async getOrderDetails(userId: string, orderId: string): Promise<Record<string, any>> {
    const r: any = this.prisma.getReadClient();

    const order = await r.order.findUnique({
      where: { id: orderId },
      include: {
        reservedTickets: true,
        payment: true,
        coupon: {
          select: { id: true, code: true, type: true, value: true, couponType: true },
        },
        voucher: {
          select: { id: true, code: true, name: true, status: true },
        },
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            eventDate: true,
            bannerUrl: true,
            logoUrl: true,
            location: true,
            city: true,
            state: true,
            organization: {
              select: { id: true, name: true, logoUrl: true, email: true, phone: true },
            },
          },
        },
        registrations: {
          where: { status: { not: RegistrationStatus.PENDING } },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                documentNumber: true,
                phone: true,
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
                    products: {
                      orderBy: { sortOrder: 'asc' },
                      include: {
                        product: { include: { variations: true } },
                      },
                    },
                  },
                },
              },
            },
            modalities: {
              include: {
                modality: {
                  select: { id: true, name: true, group: { select: { id: true, name: true } } },
                },
              },
            },
            questionAnswers: {
              include: {
                question: { select: { id: true, question: true, type: true } },
              },
            },
            products: {
              include: {
                product: { select: { id: true, name: true, image: true, basePrice: true, variationType: true } },
                variation: true,
              },
            },
          },
        },
      },
    });

    if (!order || order.userId !== userId) {
      throw new NotFoundException('Pedido não encontrado');
    }

    const payment = order.payment as any;
    const metadata = (payment?.metadata as any) ?? {};

    // Billing address: prefer fields on order, fallback to payment metadata
    const billingAddress =
      order.billingPostalCode
        ? {
            country: order.billingCountry ?? null,
            postalCode: order.billingPostalCode ?? null,
            stateUf: order.billingStateUf ?? null,
            street: order.billingStreet ?? null,
            number: order.billingNumber ?? null,
            complement: order.billingComplement ?? null,
            neighborhood: order.billingNeighborhood ?? null,
            city: order.billingCity ?? null,
          }
        : (metadata.billingAddress ?? null);

    // Build a map of productId → { variationId, quantity } from the order's pending products
    const pendingProductsMap = new Map<string, { variationId?: string; quantity: number }>();
    for (const pp of (order.pendingProducts as any[] | null) ?? []) {
      pendingProductsMap.set(pp.productId, { variationId: pp.variationId, quantity: pp.quantity });
    }

    return {
      message: 'Order details fetched successfully',
      data: {
        order: {
          id: order.id,
          status: order.status,
          createdAt: order.createdAt,
          expiresAt: order.expiresAt ?? null,
          reservedAt: order.reservedAt ?? null,
          cancelledAt: order.cancelledAt ?? null,
          cancelledReason: order.cancelledReason ?? null,
          pricing: {
            subtotal: order.totalAmount,
            discount: order.discount,
            serviceFee: order.serviceFee,
            total: order.finalAmount,
            currency: 'BRL',
          },
          billingAddress,
          coupon: order.coupon
            ? { id: order.coupon.id, code: order.coupon.code, type: order.coupon.type, value: order.coupon.value }
            : null,
          voucher: order.voucher
            ? { id: order.voucher.id, code: order.voucher.code, name: order.voucher.name, status: order.voucher.status }
            : null,
        },
        event: order.event ?? null,
        payment: payment
          ? {
              id: payment.id,
              method: payment.method,
              status: payment.status,
              amount: payment.amount,
              transactionId: payment.transactionId ?? null,
              paymentDate: payment.paymentDate ?? null,
              createdAt: payment.createdAt,
              pix:
                metadata.pix?.qrCode || metadata.pix?.pixCode || metadata.qrCode || metadata.pixCode
                  ? {
                      qrCode: metadata.pix?.qrCode ?? metadata.qrCode ?? null,
                      pixCode: metadata.pix?.pixCode ?? metadata.pixCode ?? null,
                      expiresAt: metadata.pix?.expiresAt ?? null,
                    }
                  : null,
              creditCard:
                metadata.creditCard || metadata.authorizationCode
                  ? {
                      brand: metadata.creditCard?.brand ?? null,
                      last4Digits: metadata.creditCard?.last4Digits ?? null,
                      holder: metadata.creditCard?.holder ?? null,
                      installments: metadata.creditCard?.installments ?? null,
                      authorizationCode: metadata.authorizationCode ?? null,
                      nsu: metadata.proofOfSale ?? null,
                    }
                  : null,
            }
          : null,
        registrations: (order.registrations as any[]).map((reg: any) => ({
          id: reg.id,
          status: reg.status,
          qrCode: reg.qrCode ?? null,
          createdAt: reg.createdAt,
          emergencyContact:
            reg.emergencyContactName || reg.emergencyContactPhone
              ? { name: reg.emergencyContactName ?? null, phone: reg.emergencyContactPhone ?? null }
              : null,
          participant: {
            id: reg.user?.id ?? null,
            fullName: reg.user ? `${reg.user.firstName} ${reg.user.lastName}` : null,
            firstName: reg.user?.firstName ?? null,
            lastName: reg.user?.lastName ?? null,
            email: reg.user?.email ?? null,
            documentNumber: reg.user?.documentNumber ?? null,
            phone: reg.user?.phone ?? null,
            dateOfBirth: reg.user?.dateOfBirth ?? null,
            gender: reg.user?.gender ?? null,
            avatarUrl: reg.user?.avatarUrl ?? null,
          },
          ticket:
            reg.tickets?.length > 0
              ? {
                  id: reg.tickets[0].ticket.id,
                  name: reg.tickets[0].ticket.name,
                  category: reg.tickets[0].ticket.category ?? null,
                  includedProducts: (reg.tickets[0].ticket.products ?? []).map((tp: any) => {
                    const sel = pendingProductsMap.get(tp.product.id);
                    const selectedVariation = sel?.variationId
                      ? (tp.product.variations ?? []).find((v: any) => v.id === sel.variationId) ?? null
                      : null;
                    return {
                      id: tp.product.id,
                      name: tp.product.name,
                      image: tp.product.image ?? null,
                      basePrice: tp.product.basePrice,
                      isIncludedInTicket: tp.product.isIncludedInTicket ?? false,
                      isRequired: tp.product.isRequired ?? false,
                      variationType: tp.product.variationType ?? null,
                      selectedVariation: selectedVariation
                        ? { id: selectedVariation.id, name: selectedVariation.name, price: selectedVariation.price }
                        : null,
                      variations: (tp.product.variations ?? []).map((v: any) => ({
                        id: v.id,
                        name: v.name,
                        price: v.price,
                        stock: v.stock,
                      })),
                    };
                  }),
                }
              : null,
          modality:
            reg.modalities?.length > 0
              ? {
                  id: reg.modalities[0].modality.id,
                  name: reg.modalities[0].modality.name,
                  group: reg.modalities[0].modality.group ?? null,
                }
              : null,
          questionAnswers: (reg.questionAnswers ?? []).map((qa: any) => ({
            question: qa.question.question,
            type: qa.question.type,
            answer: qa.answer,
          })),
          products: (reg.products ?? []).map((rp: any) => ({
            id: rp.id,
            product: {
              id: rp.product.id,
              name: rp.product.name,
              image: rp.product.image ?? null,
              basePrice: rp.product.basePrice,
              variationType: rp.product.variationType ?? null,
            },
            variation: rp.variation
              ? { id: rp.variation.id, name: rp.variation.name, price: rp.variation.price }
              : null,
            variationName: rp.variation?.name ?? null,
            quantity: rp.quantity,
            unitPrice: rp.unitPrice,
            totalPrice: rp.totalPrice,
          })),
        })),
        serverTime: new Date(),
      },
    };
  }

  // ── 3. patchParticipants ──────────────────────────────────────────────────

  async patchParticipants(
    userId: string,
    orderId: string,
    dto: PatchParticipantsDto,
  ): Promise<Record<string, any>> {
    const order = await this.findOrderForWrite(userId, orderId);
    this.assertPending(order);

    const w: any = this.prisma.getWriteClient();
    const updated = await w.order.update({
      where: { id: orderId },
      data: { pendingParticipants: dto.participants, updatedAt: new Date() },
      include: { reservedTickets: true },
    });
    return orderShape(updated);
  }

  // ── 4. patchProducts ──────────────────────────────────────────────────────

  async patchProducts(
    userId: string,
    orderId: string,
    dto: PatchProductsDto,
  ): Promise<Record<string, any>> {
    const order = await this.findOrderForWrite(userId, orderId);
    this.assertPending(order);

    const r: any = this.prisma.getReadClient();
    const w: any = this.prisma.getWriteClient();

    // Recalculate product subtotal
    let productsSubtotal = 0;
    for (const item of dto.products) {
      // Usa write client para evitar lag de replicação na leitura de variações
      const product = await w.product.findUnique({
        where: { id: item.productId },
        include: { variations: true },
      });
      if (!product) throw new NotFoundException(`Produto ${item.productId} não encontrado`);

      let unitPrice: number = product.basePrice;
      if (item.variationId) {
        const variation = product.variations.find((v: any) => v.id === item.variationId);
        if (!variation) {
          throw new UnprocessableEntityException(
            `Variação selecionada não encontrada para "${product.name}". Selecione uma opção válida.`,
          );
        }
        unitPrice = variation.name === 'Sem interesse' ? 0 : variation.price;
      }
      productsSubtotal += unitPrice * item.quantity;
    }

    const ticketsSubtotal = (order.reservedTickets as any[]).reduce(
      (sum: number, rt: any) => sum + rt.unitPrice * rt.quantity,
      0,
    );
    const totalAmount = ticketsSubtotal + productsSubtotal;

    const updated = await w.order.update({
      where: { id: orderId },
      data: {
        pendingProducts: dto.products,
        totalAmount,
        finalAmount: totalAmount,
        updatedAt: new Date(),
      },
      include: { reservedTickets: true },
    });
    return orderShape(updated);
  }

  // ── 5. patchBillingAddress ────────────────────────────────────────────────

  async patchBillingAddress(
    userId: string,
    orderId: string,
    dto: PatchBillingAddressDto,
  ): Promise<Record<string, any>> {
    const order = await this.findOrderForWrite(userId, orderId);
    this.assertPending(order);

    const b = dto.billingAddress;
    const w: any = this.prisma.getWriteClient();
    const updated = await w.order.update({
      where: { id: orderId },
      data: {
        billingCountry: b.country ?? null,
        billingPostalCode: b.postalCode,
        billingStateUf: b.stateUf,
        billingStreet: b.street,
        billingNumber: b.number,
        billingComplement: b.complement ?? null,
        billingNeighborhood: b.neighborhood ?? null,
        billingCity: b.city,
        updatedAt: new Date(),
      },
      include: { reservedTickets: true },
    });
    return orderShape(updated);
  }

  // ── 6. pay ────────────────────────────────────────────────────────────────

  async pay(
    userId: string,
    orderId: string,
    idempotencyKey: string | undefined,
    dto: PayOrderDto,
  ): Promise<Record<string, any>> {
    const r: any = this.prisma.getReadClient();
    const w: any = this.prisma.getWriteClient();

    // 6.1 Idempotency check
    if (idempotencyKey) {
      const cached = await this.redisService.getIdempotencyResult(idempotencyKey);
      if (cached) {
        this.logger.log(`Idempotent pay: returning cached response for key ${idempotencyKey}`);
        return cached.body;
      }
    }

    // 6.2 Ownership check
    const order = await r.order.findUnique({
      where: { id: orderId },
      include: { reservedTickets: true },
    });
    if (!order || order.userId !== userId) {
      throw new NotFoundException('Pedido não encontrado');
    }

    // 6.3 Status + expiry check
    if (
      order.status !== 'PENDING' ||
      (order.expiresAt && new Date() > new Date(order.expiresAt))
    ) {
      throw new AppConflictException(
        'ORDER_NOT_PENDING',
        'Pedido não está mais pendente ou expirou',
      );
    }

    // 6.4 Billing address required
    if (!order.billingPostalCode || !order.billingStreet || !order.billingCity) {
      throw new AppUnprocessableException(
        'BILLING_ADDRESS_REQUIRED',
        'Endereço de cobrança é obrigatório',
      );
    }

    // 6.5 Participants required
    if (!order.pendingParticipants || (order.pendingParticipants as any[]).length === 0) {
      throw new AppUnprocessableException(
        'PARTICIPANTS_REQUIRED',
        'Dados dos participantes são obrigatórios',
      );
    }

    const reservedTickets = order.reservedTickets as any[];
    const participants = order.pendingParticipants as any[];

    // 6.6 Calculate final total
    const ticketsSubtotal = reservedTickets.reduce(
      (sum: number, rt: any) => sum + rt.unitPrice * rt.quantity,
      0,
    );
    let productsSubtotal = 0;
    const pendingProducts = order.pendingProducts as any[] | null;
    if (pendingProducts?.length) {
      for (const item of pendingProducts) {
        const product = await r.product.findUnique({
          where: { id: item.productId },
          include: { variations: true },
        });
        if (product) {
          let unitPrice: number = product.basePrice;
          if (item.variationId) {
            const variation = product.variations.find((v: any) => v.id === item.variationId);
            if (variation) unitPrice = variation.name === 'Sem interesse' ? 0 : variation.price;
          }
          productsSubtotal += unitPrice * item.quantity;
        }
      }
    }

    const preDiscountTotal = ticketsSubtotal + productsSubtotal;

    // 6.7 Apply coupon/voucher (mutually exclusive)
    if (dto.couponCode && dto.voucherCode) {
      throw new AppUnprocessableException(
        'DISCOUNT_CONFLICT',
        'Não é possível usar cupom e voucher ao mesmo tempo',
      );
    }

    let couponDiscount = 0;
    let couponId: string | undefined;
    let voucherDiscount = 0;
    let voucherId: string | undefined;

    if (dto.couponCode) {
      const coupon = await r.coupon.findFirst({
        where: {
          eventId: order.eventId,
          code: dto.couponCode.toUpperCase().trim(),
          status: 'ACTIVE',
        },
      });
      if (coupon && (!coupon.expiryDate || new Date(coupon.expiryDate) > new Date())) {
        couponDiscount =
          coupon.type === 'PERCENTAGE'
            ? Math.floor(preDiscountTotal * (coupon.value / 100))
            : Math.min(coupon.value, preDiscountTotal);
        couponId = coupon.id;
      }
    }

    if (dto.voucherCode) {
      const voucher = await r.voucher.findUnique({
        where: { code: dto.voucherCode.toUpperCase().trim() },
      });
      if (
        voucher &&
        voucher.eventId === order.eventId &&
        voucher.status === 'ACTIVE' &&
        (!voucher.expiryDate || new Date(voucher.expiryDate) > new Date())
      ) {
        voucherDiscount = ticketsSubtotal;
        voucherId = voucher.id;
      }
    }

    const discountedTotal = Math.max(0, preDiscountTotal - couponDiscount - voucherDiscount);
    const pixDiscount =
      dto.method === PaymentMethod.PIX ? Math.floor(discountedTotal * 0.05) : 0;
    const finalTotal = discountedTotal - pixDiscount;

    // 6.8 Prepare payment data
    const user = await r.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true },
    });

    const firstCpf = participants[0]?.cpf?.replace(/\D/g, '') || undefined;
    const merchantOrderId = `order-${orderId}-${Date.now()}`;

    let cardData:
      | { number: string; holder: string; expiry: string; cvv: string; installments: number }
      | undefined;
    if (dto.method === PaymentMethod.CREDIT_CARD) {
      if (!dto.card) {
        throw new AppUnprocessableException('CARD_REQUIRED', 'Dados do cartão são obrigatórios');
      }
      cardData = {
        number: dto.card.number,
        holder: dto.card.name,
        expiry: dto.card.expiry,
        cvv: dto.card.cvv,
        installments: dto.card.installments ?? 1,
      };
    }

    // 6.9 Call Cielo
    let cieloResult: any;
    let paymentFailed = false;
    try {
      cieloResult = await this.cieloService.createPayment(
        finalTotal,
        'BRL',
        dto.method,
        merchantOrderId,
        {
          name: `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim(),
          email: user?.email,
          identity: firstCpf,
          identityType: firstCpf ? 'CPF' : undefined,
        },
        cardData,
      );
      if (!cieloResult.success) {
        paymentFailed = true;
      }
    } catch (err: any) {
      this.logger.warn(`Payment failed for order ${orderId}: ${err.message}`);
      paymentFailed = true;
      cieloResult = { success: false, error: err.message };
    }

    // 6.10 Payment failed → cancel order + restore stock
    if (paymentFailed) {
      await this.cancelOrderAndRestoreStock(orderId, 'PAYMENT_REFUSED', w);
      const errBody = {
        error: true,
        code: 'PAYMENT_REFUSED',
        message: cieloResult.error || 'Pagamento recusado. Verifique os dados e tente novamente.',
      };
      if (idempotencyKey) {
        await this.redisService.setIdempotencyResult(idempotencyKey, 402, errBody);
      }
      throw new HttpException(errBody, 402);
    }

    // 6.11 PIX: extend expiry, create PENDING payment, return QR code
    if (dto.method === PaymentMethod.PIX) {
      const newExpiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000);

      await w.$transaction(async (tx: any) => {
        await tx.order.update({
          where: { id: orderId },
          data: {
            expiresAt: newExpiresAt,
            discount: couponDiscount + voucherDiscount,
            finalAmount: finalTotal,
            totalAmount: preDiscountTotal,
            ...(couponId && { couponId }),
            ...(voucherId && { voucherId }),
            updatedAt: new Date(),
          },
        });

        await tx.payment.create({
          data: {
            orderId,
            userId,
            method: dto.method,
            status: PaymentStatus.PENDING,
            amount: finalTotal,
            transactionId: cieloResult.paymentId ?? null,
            metadata: {
              cieloPaymentId: cieloResult.paymentId,
              qrCode: cieloResult.qrCode,
              pixCode: cieloResult.pixCode,
              expiresAt: cieloResult.expiresAt?.toISOString() ?? null,
            },
          },
        });
      });

      const body: Record<string, any> = {
        orderId,
        status: 'PENDING',
        payment: {
          method: dto.method,
          status: 'PENDING',
          pix: {
            qrCode: cieloResult.qrCode ?? null,
            qrCodeBase64: cieloResult.qrCode ?? null,
            pixCode: cieloResult.pixCode ?? null,
            expiresAt: cieloResult.expiresAt ?? newExpiresAt,
          },
        },
        expiresAt: newExpiresAt,
        serverTime: new Date(),
      };

      if (idempotencyKey) {
        await this.redisService.setIdempotencyResult(idempotencyKey, 202, body);
      }
      return body;
    }

    // 6.12 CREDIT_CARD: verify approval
    const isApproved =
      cieloResult.cieloStatus === 'Authorized' ||
      cieloResult.cieloStatus === 'PaymentConfirmed';

    if (!isApproved) {
      await this.cancelOrderAndRestoreStock(orderId, 'PAYMENT_REFUSED', w);
      const errBody = { error: true, code: 'PAYMENT_REFUSED', message: 'Pagamento não autorizado' };
      if (idempotencyKey) {
        await this.redisService.setIdempotencyResult(idempotencyKey, 402, errBody);
      }
      throw new HttpException(errBody, 402);
    }

    // 6.13 Finalize: mark PAID, create Payment, create Registrations
    const registrations: any[] = await w.$transaction(async (tx: any) => {
      // Atomic guard — only proceed if order is still PENDING
      const guardRows: any[] = await tx.$queryRaw`
        UPDATE "Order"
        SET "status" = 'PAID'::"OrderStatus",
            "updatedAt" = NOW()
        WHERE id = ${orderId}::uuid
          AND "status" = 'PENDING'::"OrderStatus"
        RETURNING id
      `;
      if (!guardRows || guardRows.length === 0) {
        throw new AppConflictException('ORDER_NOT_PENDING', 'Pedido não está mais pendente');
      }

      // Update financial fields
      await tx.order.update({
        where: { id: orderId },
        data: {
          discount: couponDiscount + voucherDiscount,
          finalAmount: finalTotal,
          totalAmount: preDiscountTotal,
          ...(couponId && { couponId }),
          ...(voucherId && { voucherId }),
          updatedAt: new Date(),
        },
      });

      // Create Payment record
      await tx.payment.create({
        data: {
          orderId,
          userId,
          method: dto.method,
          status: PaymentStatus.PAID,
          amount: finalTotal,
          transactionId: cieloResult.paymentId ?? null,
          paymentDate: new Date(),
          metadata: {
            cieloPaymentId: cieloResult.paymentId,
            authorizationCode: cieloResult.authorizationCode,
            proofOfSale: cieloResult.proofOfSale,
            cieloStatus: cieloResult.cieloStatus,
          },
        },
      });

      // Apply coupon usage
      if (couponId) {
        await tx.coupon.update({
          where: { id: couponId },
          data: { usageCount: { increment: 1 } },
        });
      }
      // Mark voucher as used
      if (voucherId) {
        await tx.voucher.update({
          where: { id: voucherId },
          data: { status: 'USED', usedAt: new Date(), usedBy: userId },
        });
      }

      // Remove placeholder PENDING registrations criadas na reserva
      await tx.registration.deleteMany({
        where: { orderId, status: RegistrationStatus.PENDING },
      });

      // Create Registrations from pendingParticipants
      const createdRegs: any[] = [];
      const buyerUser = await tx.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });

      let pIdx = 0;
      for (const rt of reservedTickets) {
        for (let i = 0; i < rt.quantity; i++) {
          const pData = participants[pIdx];
          if (!pData) break;

          // Resolve or create participant user
          let participantUserId = userId;
          if (pData.email?.toLowerCase() !== buyerUser?.email?.toLowerCase()) {
            let invitedUser = await tx.user.findFirst({
              where: { email: pData.email },
            });
            if (!invitedUser) {
              const clean = (pData.cpf ?? '').replace(/\D/g, '');
              invitedUser = await tx.user.create({
                data: {
                  email: pData.email,
                  firstName: pData.name.split(' ')[0],
                  lastName: pData.name.split(' ').slice(1).join(' ') || '',
                  documentNumber: pData.cpf ?? '',
                  documentNumberClean: clean,
                  password: '',
                  isActive: false,
                },
              });
            }
            participantUserId = invitedUser.id;
          }

          const reg = await tx.registration.create({
            data: {
              eventId: order.eventId,
              orderId,
              userId: participantUserId,
              invitedById: participantUserId !== userId ? userId : null,
              status: RegistrationStatus.CONFIRMED,
              termsAccepted: true,
              rulesAccepted: true,
              emergencyContactName: pData.emergencyContactName?.trim() || null,
              emergencyContactPhone: pData.emergencyPhone?.trim() || null,
            },
          });

          const qrPayload = JSON.stringify({
            registrationId: reg.id,
            eventId: order.eventId,
            userId: participantUserId,
          });
          const updatedReg = await tx.registration.update({
            where: { id: reg.id },
            data: { qrCode: qrPayload },
            select: { id: true, qrCode: true, status: true },
          });

          await tx.registrationTicket.create({
            data: {
              registrationId: reg.id,
              ticketId: rt.ticketId,
              batchId: rt.batchId,
            },
          });

          // Create RegistrationProduct records for the first participant only
          if (pIdx === 0 && pendingProducts?.length) {
            for (const item of pendingProducts) {
              const product = await r.product.findUnique({
                where: { id: item.productId },
                include: { variations: true },
              });
              if (!product) continue;
              let unitPrice: number = product.basePrice;
              if (item.variationId) {
                const variation = product.variations.find((v: any) => v.id === item.variationId);
                if (variation) unitPrice = variation.name === 'Sem interesse' ? 0 : variation.price;
              }
              await tx.registrationProduct.create({
                data: {
                  registrationId: reg.id,
                  productId: item.productId,
                  variationId: item.variationId ?? null,
                  quantity: item.quantity ?? 1,
                  unitPrice,
                  totalPrice: unitPrice * (item.quantity ?? 1),
                },
              });
            }
          }

          // Question answers
          if (pData.questionAnswers?.length) {
            for (const qa of pData.questionAnswers) {
              await tx.questionAnswer.create({
                data: {
                  registrationId: reg.id,
                  questionId: qa.questionId,
                  answer: String(qa.answer),
                },
              });
            }
          }

          createdRegs.push(updatedReg);
          pIdx++;
        }
      }

      return createdRegs;
    });

    const body: Record<string, any> = {
      orderId,
      status: 'PAID',
      registrations: registrations.map((reg) => ({
        id: reg.id,
        status: reg.status,
        qrCode: reg.qrCode,
      })),
      payment: {
        method: dto.method,
        status: 'PAID',
        transactionId: cieloResult.paymentId ?? null,
        creditCard: cardData
          ? {
              installments: cardData.installments,
              installmentValue: Math.floor(finalTotal / cardData.installments),
            }
          : undefined,
      },
      pricing: {
        ticketsSubtotal,
        productsSubtotal,
        discount: couponDiscount + voucherDiscount,
        pixDiscount,
        finalTotal,
      },
      serverTime: new Date(),
    };

    if (idempotencyKey) {
      await this.redisService.setIdempotencyResult(idempotencyKey, 201, body);
    }

    this.logger.log(`Order ${orderId} paid successfully for user ${userId}`);
    return body;
  }

  // ── 7. getPaymentStatus ───────────────────────────────────────────────────

  async getPaymentStatus(userId: string, orderId: string): Promise<Record<string, any>> {
    const r: any = this.prisma.getReadClient();
    const order = await r.order.findUnique({
      where: { id: orderId },
      include: { payment: true },
    });
    if (!order || order.userId !== userId) {
      throw new NotFoundException('Pedido não encontrado');
    }

    return {
      orderId,
      orderStatus: order.status,
      expiresAt: order.expiresAt ?? null,
      payment: order.payment
        ? {
            id: order.payment.id,
            method: order.payment.method,
            status: order.payment.status,
            amount: order.payment.amount,
            transactionId: order.payment.transactionId ?? null,
            paymentDate: order.payment.paymentDate ?? null,
          }
        : null,
      serverTime: new Date(),
    };
  }

  // ── 8. cancelExpiredOrders (cron) ─────────────────────────────────────────

  async cancelExpiredOrders(): Promise<number> {
    const w: any = this.prisma.getWriteClient();

    const expired = await w.order.findMany({
      where: { status: 'PENDING', expiresAt: { lte: new Date() } },
      select: {
        id: true,
        billingPostalCode: true,
        reservedTickets: { select: { batchId: true, quantity: true } },
      },
    });

    if (!expired.length) return 0;

    let cancelled = 0;
    for (const order of expired) {
      const reachedBilling = !!order.billingPostalCode;

      if (reachedBilling) {
        // Chegou na etapa de endereço/pagamento → mantém registro como CANCELLED
        const rows: any[] = await w.$queryRaw`
          UPDATE "Order"
          SET "status" = 'CANCELLED'::"OrderStatus",
              "cancelledAt" = NOW(),
              "cancelledReason" = 'EXPIRED',
              "updatedAt" = NOW()
          WHERE id = ${order.id}::uuid
            AND "status" = 'PENDING'::"OrderStatus"
          RETURNING id
        `;

        if (rows?.length > 0) {
          await w.$transaction(async (tx: any) => {
            for (const rt of order.reservedTickets as any[]) {
              await tx.$executeRaw`
                UPDATE "TicketBatch"
                SET "availableQuantity" = LEAST("availableQuantity" + ${rt.quantity}, "quantity")
                WHERE id = ${rt.batchId}::uuid
              `;
            }
            await tx.registration.updateMany({
              where: { orderId: order.id, status: 'PENDING' },
              data: { status: 'CANCELLED' },
            });
          });
          cancelled++;
          this.logger.debug(`Cancelled expired order ${order.id}`);
        }
      } else {
        // Nunca chegou na etapa de endereço → deleta o pedido (sem histórico necessário)
        // Restaura estoque e deleta em transação; cascade remove registrations e reservedTickets
        await w.$transaction(async (tx: any) => {
          for (const rt of order.reservedTickets as any[]) {
            await tx.$executeRaw`
              UPDATE "TicketBatch"
              SET "availableQuantity" = LEAST("availableQuantity" + ${rt.quantity}, "quantity")
              WHERE id = ${rt.batchId}::uuid
            `;
          }
          await tx.order.delete({ where: { id: order.id } });
        });
        cancelled++;
        this.logger.debug(`Deleted incomplete expired order ${order.id}`);
      }
    }

    return cancelled;
  }

  // ── dev helpers (non-production only) ────────────────────────────────────

  async forceExpire(userId: string, orderId: string): Promise<{ message: string }> {
    const w: any = this.prisma.getWriteClient();
    const order = await w.order.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) {
      throw new NotFoundException('Pedido não encontrado');
    }
    if (order.status !== 'PENDING') {
      throw new AppConflictException('ORDER_NOT_PENDING', 'Pedido não está mais pendente');
    }
    await w.order.update({
      where: { id: orderId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    return { message: 'expiresAt set to past — cron will process it within 30s' };
  }

  // ── private helpers ───────────────────────────────────────────────────────

  private async findOrderForWrite(userId: string, orderId: string): Promise<any> {
    const r: any = this.prisma.getReadClient();
    const order = await r.order.findUnique({
      where: { id: orderId },
      include: { reservedTickets: true },
    });
    if (!order || order.userId !== userId) {
      throw new NotFoundException('Pedido não encontrado');
    }
    return order;
  }

  private assertPending(order: any): void {
    if (order.status !== 'PENDING') {
      throw new AppConflictException(
        'ORDER_NOT_PENDING',
        'Pedido não está mais pendente e não pode ser alterado',
      );
    }
  }

  private async cancelOrderAndRestoreStock(
    orderId: string,
    reason: string,
    w: any,
  ): Promise<void> {
    const order = await w.order.findUnique({
      where: { id: orderId },
      include: { reservedTickets: true },
    });
    if (!order) return;

    const rows: any[] = await w.$queryRaw`
      UPDATE "Order"
      SET "status" = 'CANCELLED'::"OrderStatus",
          "cancelledAt" = NOW(),
          "cancelledReason" = ${reason},
          "updatedAt" = NOW()
      WHERE id = ${orderId}::uuid
        AND "status" = 'PENDING'::"OrderStatus"
      RETURNING id
    `;

    if (rows?.length > 0) {
      // Restore stock + cancel registrations atomicamente
      await w.$transaction(async (tx: any) => {
        for (const rt of order.reservedTickets as any[]) {
          // LEAST garante que availableQuantity nunca ultrapasse quantity (evita over-restore)
          await tx.$executeRaw`
            UPDATE "TicketBatch"
            SET "availableQuantity" = LEAST("availableQuantity" + ${rt.quantity}, "quantity")
            WHERE id = ${rt.batchId}::uuid
          `;
        }
        await tx.registration.updateMany({
          where: { orderId, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        });
      });
    }
  }
}
