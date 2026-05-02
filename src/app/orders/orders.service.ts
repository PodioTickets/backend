/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BadRequestException,
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
import { PatchCouponDto } from './dto/patch-coupon.dto';
import { EmailService } from '../../common/services/email.service';
import { TicketPdfService } from '../../common/services/ticket-pdf.service';
import { ReceiptPdfService } from '../../common/services/receipt-pdf.service';

// ─── helpers de formatação ────────────────────────────────────────────────────

function formatEventDate(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = new Date(date as string);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatEventAddress(event: any): string {
  const parts: string[] = [];
  const cityState: string[] = [];
  if (event.city) cityState.push(event.city);
  if (event.state) cityState.push(event.state);
  if (cityState.length) parts.push(cityState.join(' - '));
  if (event.neighborhood) parts.push(event.neighborhood);
  if (event.location) parts.push(event.location);
  if (event.zipCode) {
    const cep = String(event.zipCode).replace(/\D/g, '');
    parts.push(cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep);
  }
  return parts.join(', ');
}

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

// ─── shared include ──────────────────────────────────────────────────────────

const ORDER_INCLUDE = {
  reservedTickets: true,
  coupon: { select: { id: true, code: true, couponType: true, type: true, value: true, appliesTo: true, minAge: true, maxAge: true } },
  voucher: { select: { id: true, code: true, name: true, status: true } },
  payment: { select: { id: true, method: true, status: true, amount: true, transactionId: true, paymentDate: true, createdAt: true, metadata: true } },
} as const;

// ─── shape helpers ───────────────────────────────────────────────────────────

/**
 * Expande reservedTickets em entradas individuais (quantity: 1 cada) e distribui
 * o desconto do cupom apenas nas unidades cobertas pelo effectiveUsage.
 * Sempre retorna uma entrada por ingresso, permitindo ao frontend identificar
 * exatamente quais receberam desconto.
 */
function distributeDiscount(
  reservedTickets: any[],
  totalDiscount: number,
  effectiveUsage?: number,
  fixedPerUnit?: number,
  qualifyingSlots?: number[],
): any[] {
  // Expand all tickets into individual unit slots
  const units: { rt: any; discount: number }[] = [];
  for (const rt of reservedTickets) {
    for (let i = 0; i < rt.quantity; i++) {
      units.push({ rt, discount: 0 });
    }
  }

  if (!units.length) return [];

  const totalQuantity = units.length;
  const coveredQty = Math.min(effectiveUsage ?? totalQuantity, totalQuantity);

  if (totalDiscount > 0 && coveredQty > 0) {
    let sorted: number[];
    if (qualifyingSlots && qualifyingSlots.length > 0) {
      // Apply discount to specific participant positions first, then fill by price if needed
      const validSlots = qualifyingSlots.filter(i => i >= 0 && i < totalQuantity);
      if (validSlots.length >= coveredQty) {
        sorted = validSlots.slice(0, coveredQty);
      } else {
        const byPrice = [...units.keys()]
          .filter(i => !validSlots.includes(i))
          .sort((a, b) => units[b].rt.unitPrice - units[a].rt.unitPrice);
        sorted = [...validSlots, ...byPrice].slice(0, coveredQty);
      }
    } else {
      sorted = [...units.keys()].sort((a, b) => units[b].rt.unitPrice - units[a].rt.unitPrice);
    }

    if (fixedPerUnit !== undefined && fixedPerUnit > 0) {
      for (let i = 0; i < coveredQty; i++) {
        units[sorted[i]].discount = fixedPerUnit;
      }
    } else {
      // PERCENTAGE: distribute totalDiscount proportionally among covered slots
      const coveredSubtotal = sorted.slice(0, coveredQty).reduce((s, i) => s + units[i].rt.unitPrice, 0);
      let distrib = 0;
      for (let i = 0; i < coveredQty; i++) {
        const isLast = i === coveredQty - 1;
        const slotIdx = sorted[i];
        units[slotIdx].discount = isLast
          ? totalDiscount - distrib
          : Math.round(totalDiscount * (units[slotIdx].rt.unitPrice / coveredSubtotal));
        distrib += units[slotIdx].discount;
      }
    }
  }

  return units.map(({ rt, discount }) => ({
    ...rt,
    quantity: 1,
    unitDiscount: discount,
    totalDiscount: discount,
    couponApplied: discount > 0,
    finalUnitPrice: rt.unitPrice - discount,
    finalTotalPrice: rt.unitPrice - discount,
  }));
}

function computePartialCouponDiscount(
  reservedTickets: any[],
  couponValueType: string,
  couponValue: number,
  effectiveUsage: number,
): number {
  if (effectiveUsage <= 0) return 0;
  const units = reservedTickets
    .flatMap((rt: any) => Array(rt.quantity).fill(rt.unitPrice))
    .sort((a: number, b: number) => b - a)
    .slice(0, effectiveUsage);
  if (couponValueType === 'PERCENTAGE') {
    const base = units.reduce((s: number, p: number) => s + p, 0);
    return Math.floor(base * (couponValue / 100));
  }
  return effectiveUsage * couponValue;
}

function inferEffectiveUsage(
  reservedTickets: any[],
  coupon: { type: string; value: number; appliesTo?: string | null } | null | undefined,
  totalDiscount: number,
): number | undefined {
  if (!coupon || !totalDiscount || totalDiscount <= 0) return undefined;

  let applicable = reservedTickets;
  if (coupon.appliesTo && coupon.appliesTo !== 'all') {
    let allowed: string[] = [];
    try { allowed = JSON.parse(coupon.appliesTo); } catch { allowed = []; }
    applicable = reservedTickets.filter((rt) => allowed.includes(rt.ticketId));
  }

  const totalQty = applicable.reduce((s, rt) => s + rt.quantity, 0);
  if (totalQty === 0) return undefined;

  const units = applicable
    .flatMap((rt) => Array(rt.quantity).fill(rt.unitPrice))
    .sort((a: number, b: number) => b - a);

  if (coupon.type === 'PERCENTAGE') {
    for (let n = 1; n <= totalQty; n++) {
      const base = units.slice(0, n).reduce((s: number, p: number) => s + p, 0);
      const computed = Math.floor(base * (coupon.value / 100));
      if (computed === totalDiscount) return n;
      if (computed > totalDiscount) break;
    }
    return undefined;
  } else {
    if (coupon.value > 0 && totalDiscount % coupon.value === 0) {
      const n = totalDiscount / coupon.value;
      return n <= totalQty ? n : undefined;
    }
    return undefined;
  }
}

function orderShape(order: any, discountOverride?: number, extra?: Record<string, unknown>, effectiveUsage?: number, fixedPerUnit?: number, qualifyingSlots?: number[]): Record<string, any> {
  const coupon = order.coupon ?? null;
  const resolvedFixedPerUnit = fixedPerUnit ?? (coupon?.type === 'FIXED' ? coupon.value : undefined);

  // For AGE coupons without explicit effectiveUsage: re-derive from pendingParticipants.
  // This guarantees correct display regardless of stale order.discount in the DB.
  let resolvedEffectiveUsage = effectiveUsage;
  let resolvedQualifyingSlots = qualifyingSlots;
  if (resolvedEffectiveUsage === undefined && coupon?.couponType === 'AGE' && Array.isArray(order.pendingParticipants) && order.pendingParticipants.length > 0) {
    const participants = order.pendingParticipants as any[];
    const min: number = coupon.minAge ?? 0;
    const max: number = coupon.maxAge ?? Infinity;
    const now = new Date();
    const totalUnits = (order.reservedTickets ?? []).reduce((s: number, rt: any) => s + (rt.quantity ?? 1), 0);
    const derived = participants
      .map((p: any, i: number) => {
        if (!p.birthDate || i >= totalUnits) return -1;
        const age = Math.floor((now.getTime() - new Date(p.birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        return age >= min && age <= max ? i : -1;
      })
      .filter(i => i >= 0);
    if (derived.length > 0) {
      resolvedEffectiveUsage = derived.length;
      resolvedQualifyingSlots = resolvedQualifyingSlots ?? derived;
    }
  }

  // When effectiveUsage was re-derived for an AGE coupon, also recompute the discount
  // to avoid showing a stale DB value (e.g. 4470 when only 1 participant now qualifies).
  let discount: number;
  if (discountOverride !== undefined) {
    discount = discountOverride;
  } else if (resolvedEffectiveUsage !== undefined && effectiveUsage === undefined && coupon?.couponType === 'AGE') {
    discount = computePartialCouponDiscount(order.reservedTickets ?? [], coupon.type, coupon.value, resolvedEffectiveUsage);
  } else {
    discount = order.discount ?? 0;
  }

  if (resolvedEffectiveUsage === undefined) {
    resolvedEffectiveUsage = inferEffectiveUsage(order.reservedTickets ?? [], coupon, discount);
  }

  const tickets = distributeDiscount(order.reservedTickets ?? [], discount, resolvedEffectiveUsage, resolvedFixedPerUnit, resolvedQualifyingSlots);

  const payment = order.payment ?? null;
  const paymentMeta = (payment?.metadata as any) ?? {};
  const shapedPayment = payment
    ? {
        id: payment.id,
        method: payment.method,
        status: payment.status,
        amount: payment.amount,
        transactionId: payment.transactionId ?? null,
        paymentDate: payment.paymentDate ?? null,
        createdAt: payment.createdAt,
        pix:
          paymentMeta.pix?.qrCode || paymentMeta.pix?.pixCode || paymentMeta.qrCode || paymentMeta.pixCode
            ? {
                qrCode: paymentMeta.pix?.qrCode ?? paymentMeta.qrCode ?? null,
                pixCode: paymentMeta.pix?.pixCode ?? paymentMeta.pixCode ?? null,
                expiresAt: paymentMeta.pix?.expiresAt ?? paymentMeta.expiresAt ?? null,
              }
            : null,
        creditCard:
          paymentMeta.creditCard || paymentMeta.authorizationCode
            ? {
                brand: paymentMeta.creditCard?.brand ?? null,
                last4Digits: paymentMeta.creditCard?.last4Digits ?? null,
                holder: paymentMeta.creditCard?.holder ?? null,
                installments: paymentMeta.creditCard?.installments ?? null,
                authorizationCode: paymentMeta.authorizationCode ?? null,
                nsu: paymentMeta.proofOfSale ?? null,
              }
            : null,
      }
    : null;

  return {
    id: order.id,
    eventId: order.eventId,
    status: order.status,
    totalAmount: order.totalAmount,
    serviceFee: order.serviceFee,
    discount,
    finalAmount: order.finalAmount,
    coupon: order.coupon ?? null,
    voucher: order.voucher ?? null,
    expiresAt: order.expiresAt ?? null,
    reservedAt: order.reservedAt ?? null,
    cancelledAt: order.cancelledAt ?? null,
    cancelledReason: order.cancelledReason ?? null,
    reservedTickets: tickets,
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
    payment: shapedPayment,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    serverTime: new Date(),
    ...extra,
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
    private readonly emailService: EmailService,
    private readonly ticketPdfService: TicketPdfService,
    private readonly receiptPdfService: ReceiptPdfService,
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
      include: ORDER_INCLUDE,
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
        include: ORDER_INCLUDE,
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
      include: ORDER_INCLUDE,
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

    const [order, currentUser] = await Promise.all([
      r.order.findUnique({
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
                  documentNumberClean: true,
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
                          product: {
                            include: { variations: true },
                          },
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
                  product: { select: { id: true, name: true, image: true, basePrice: true, variationType: true, buyerVariationEditAllowed: true, variationEditDeadlineDays: true } },
                  variation: true,
                },
              },
            },
          },
        },
      }),
      r.user.findUnique({
        where: { id: userId },
        select: { documentNumber: true, documentNumberClean: true },
      }),
    ]);

    const isOwner = order.userId === userId;
    const userCpfClean = currentUser?.documentNumberClean ?? null;
    const isParticipant = (order.registrations as any[]).some(
      (reg: any) =>
        (userCpfClean && reg.participantCpfClean === userCpfClean) ||
        (userCpfClean && reg.user?.documentNumberClean === userCpfClean),
    );

    if (!order || (!isOwner && !isParticipant)) {
      throw new NotFoundException('Pedido não encontrado');
    }

    if (!isOwner && userCpfClean) {
      order.registrations = (order.registrations as any[]).filter(
        (reg: any) =>
          reg.participantCpfClean === userCpfClean ||
          reg.user?.documentNumberClean === userCpfClean,
      );
    }

    // Batch-fetch variations that are no longer reachable via the FK relation
    // (happens when organizer deletes+recreates variations — old IDs become orphans)
    const orphanVariationIds = new Set<string>();
    for (const reg of order.registrations as any[]) {
      for (const rp of reg.products ?? []) {
        if (!rp.variation && rp.variationId) orphanVariationIds.add(rp.variationId);
      }
    }
    const orphanVariationMap = new Map<string, any>();
    if (orphanVariationIds.size > 0) {
      const found = await r.productVariation.findMany({
        where: { id: { in: [...orphanVariationIds] } },
      });
      for (const v of found) orphanVariationMap.set(v.id, v);
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

    const eventDate = new Date((order as any).event?.eventDate ?? 0);
    const now = new Date();

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
        registrations: (order.registrations as any[]).map((reg: any) => {
          const receipt = reg.receiptSnapshot as any;

          // Participant: snapshot tem prioridade sobre dados em tempo real
          const snapP = receipt?.participant;
          const participant = snapP
            ? {
                id: reg.userId,
                fullName: snapP.name ?? null,
                firstName: snapP.name?.split(' ')[0] ?? null,
                lastName: snapP.name?.split(' ').slice(1).join(' ') ?? null,
                email: snapP.email ?? null,
                documentNumber: snapP.cpf ?? null,
                phone: snapP.phone ?? null,
                dateOfBirth: snapP.birthDate ?? null,
                gender: snapP.gender ?? null,
                avatarUrl: null,
              }
            : reg.user
            ? {
                id: reg.user.id,
                fullName: `${reg.user.firstName} ${reg.user.lastName}`,
                firstName: reg.user.firstName,
                lastName: reg.user.lastName,
                email: reg.user.email,
                documentNumber: reg.user.documentNumber ?? null,
                phone: reg.user.phone ?? null,
                dateOfBirth: reg.user.dateOfBirth ?? null,
                gender: reg.user.gender ?? null,
                avatarUrl: reg.user.avatarUrl ?? null,
              }
            : {
                id: null,
                fullName: reg.participantName ?? null,
                firstName: (reg.participantName ?? '').split(' ')[0] || null,
                lastName: (reg.participantName ?? '').split(' ').slice(1).join(' ') || null,
                email: reg.participantEmail ?? null,
                documentNumber: reg.participantCpf ?? null,
                phone: reg.participantPhone ?? null,
                dateOfBirth: reg.participantDateOfBirth ?? null,
                gender: reg.participantGender ?? null,
                avatarUrl: null,
              };

          // Ticket: nome/categoria do snapshot; includedProducts em tempo real (lógica de edição)
          const regTicket = reg.tickets?.[0];
          const ticketSnap = (regTicket?.ticketSnapshot ?? receipt?.ticket) as any;
          const liveTicket = regTicket?.ticket;

          const ticket = regTicket
            ? {
                id: ticketSnap?.id ?? liveTicket?.id,
                name: ticketSnap?.name ?? liveTicket?.name,
                category: ticketSnap?.category ?? liveTicket?.category ?? null,
                includedProducts: (liveTicket?.products ?? []).map((tp: any) => {
                  const regProduct = (reg.products ?? []).find((rp: any) => rp.productId === tp.product.id);
                  const variationEdited = regProduct?.variationEdited ?? false;

                  const resolvedVariationId =
                    regProduct?.variationId
                    ?? pendingProductsMap.get(tp.product.id)?.variationId
                    ?? null;

                  const selectedVariation: any =
                    regProduct?.variation
                    ?? (resolvedVariationId ? orphanVariationMap.get(resolvedVariationId) ?? null : null)
                    ?? (resolvedVariationId
                      ? (tp.product.variations ?? []).find((v: any) => v.id === resolvedVariationId) ?? null
                      : null);

                  const deadlineDays = tp.product.variationEditDeadlineDays ?? 0;
                  const deadlineMs = deadlineDays * 24 * 60 * 60 * 1000;
                  const variationEditDeadline = deadlineDays > 0
                    ? new Date(eventDate.getTime() - deadlineMs)
                    : null;
                  const editWindowOpen = variationEditDeadline ? now < variationEditDeadline : false;
                  const canEditVariation =
                    (tp.product.buyerVariationEditAllowed ?? false) &&
                    !variationEdited &&
                    editWindowOpen &&
                    tp.product.isIncludedInTicket === true;

                  return {
                    id: tp.product.id,
                    name: tp.product.name,
                    image: tp.product.image ?? null,
                    basePrice: tp.product.basePrice,
                    isIncludedInTicket: tp.product.isIncludedInTicket ?? false,
                    isRequired: tp.product.isRequired ?? false,
                    variationType: tp.product.variationType ?? null,
                    buyerVariationEditAllowed: tp.product.buyerVariationEditAllowed ?? false,
                    variationEditDeadline,
                    variationEdited,
                    canEditVariation,
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
            : null;

          // Question answers: questionSnapshot tem prioridade
          const questionAnswers = (reg.questionAnswers ?? []).map((qa: any) => {
            const qSnap = (qa.questionSnapshot ?? null) as any;
            return {
              question: qSnap?.question ?? qa.question?.question ?? null,
              type: qSnap?.type ?? qa.question?.type ?? null,
              answer: qa.answer,
            };
          });

          // Products: productSnapshot tem prioridade
          const products = (reg.products ?? []).map((rp: any) => {
            const pSnap = (rp.productSnapshot ?? null) as any;
            const selectedVar = pSnap?.selectedVariation ?? (rp.variation
              ? { id: rp.variation.id, name: rp.variation.name, price: rp.variation.price }
              : null);
            return {
              id: rp.id,
              product: {
                id: rp.productId ?? pSnap?.id ?? rp.product?.id,
                name: pSnap?.name ?? rp.product?.name ?? null,
                image: pSnap
                  ? (pSnap.images?.[pSnap.primaryImageIndex ?? 0] ?? pSnap.image ?? null)
                  : (rp.product?.image ?? null),
                basePrice: pSnap?.basePrice ?? rp.product?.basePrice ?? rp.unitPrice,
                variationType: pSnap?.variationType ?? rp.product?.variationType ?? null,
              },
              variation: selectedVar,
              variationName: selectedVar?.name ?? null,
              quantity: rp.quantity,
              unitPrice: rp.unitPrice,
              totalPrice: rp.totalPrice,
            };
          });

          return {
            id: reg.id,
            status: reg.status,
            qrCode: reg.qrCode ?? null,
            createdAt: reg.createdAt,
            emergencyContact:
              reg.emergencyContactName || reg.emergencyContactPhone
                ? { name: reg.emergencyContactName ?? null, phone: reg.emergencyContactPhone ?? null }
                : null,
            participant,
            ticket,
            modality:
              reg.modalities?.length > 0
                ? {
                    id: reg.modalities[0].modality.id,
                    name: reg.modalities[0].modality.name,
                    group: reg.modalities[0].modality.group ?? null,
                  }
                : null,
            questionAnswers,
            products,
          };
        }),
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
    const r: any = this.prisma.getReadClient();

    const reservedTickets = (order.reservedTickets ?? []) as any[];
    const participants = dto.participants as any[];

    // Auto-aplicar cupons QUANTITY/AGE — só se ainda não há cupom/voucher no pedido
    let autoCouponId: string | undefined;
    let autoDiscount = 0;
    let autoEffectiveUsage: number | undefined;
    let shouldRemoveAgeCoupon = false;
    let ageQualifyingSlots: number[] | undefined;

    // Re-avaliar cupom AGE já aplicado quando participantes mudam
    if (order.couponId && !order.voucherId) {
      const existingCoupon = await r.coupon.findUnique({
        where: { id: order.couponId },
        select: { id: true, couponType: true, type: true, value: true, minAge: true, maxAge: true, maxUsage: true, usageCount: true, appliesTo: true },
      });
      if (existingCoupon?.couponType === 'AGE') {
        const now = new Date();
        const min = existingCoupon.minAge ?? 0;
        const max = existingCoupon.maxAge ?? Infinity;
        const ageMatchCount = participants.filter((p: any) => {
          if (!p.birthDate) return false;
          const age = Math.floor((now.getTime() - new Date(p.birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
          return age >= min && age <= max;
        }).length;

        if (ageMatchCount <= 0) {
          shouldRemoveAgeCoupon = true;
        } else {
          let ageApplicableTickets = reservedTickets;
          if (existingCoupon.appliesTo && existingCoupon.appliesTo !== 'all') {
            let allowed: string[] = [];
            try { allowed = JSON.parse(existingCoupon.appliesTo); } catch { allowed = []; }
            ageApplicableTickets = reservedTickets.filter((rt: any) => allowed.includes(rt.ticketId));
          }
          const ageApplicableQty = ageApplicableTickets.reduce((s: number, rt: any) => s + rt.quantity, 0);
          const remaining = existingCoupon.maxUsage != null
            ? Math.max(0, existingCoupon.maxUsage - existingCoupon.usageCount)
            : ageMatchCount;
          const effectiveUsage = Math.min(remaining, ageMatchCount, ageApplicableQty);
          const totalUnits = reservedTickets.reduce((s: number, rt: any) => s + rt.quantity, 0);
          ageQualifyingSlots = participants
            .map((p: any, i: number) => {
              if (!p.birthDate || i >= totalUnits) return -1;
              const age = Math.floor((now.getTime() - new Date(p.birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
              return (age >= min && age <= max) ? i : -1;
            })
            .filter((i: number) => i >= 0);
          autoCouponId = existingCoupon.id;
          autoDiscount = computePartialCouponDiscount(ageApplicableTickets, existingCoupon.type, existingCoupon.value, effectiveUsage);
          autoEffectiveUsage = effectiveUsage;
        }
      }
    }

    if (!order.couponId && !order.voucherId) {
      const totalQuantity = reservedTickets.reduce((sum: number, rt: any) => sum + rt.quantity, 0);
      const ticketIds = reservedTickets.map((rt: any) => rt.ticketId);
      const ticketsSubtotal = reservedTickets.reduce((sum: number, rt: any) => sum + rt.unitPrice * rt.quantity, 0);

      const autoCoupons = await w.coupon.findMany({
        where: {
          eventId: order.eventId,
          status: 'ACTIVE',
          deletedAt: null,
          couponType: { in: ['QUANTITY', 'AGE'] },
          OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
        },
      });

      for (const coupon of autoCoupons) {
        // Verificar appliesTo
        if (coupon.appliesTo && coupon.appliesTo !== 'all') {
          let allowed: string[] = [];
          try { allowed = JSON.parse(coupon.appliesTo); } catch { allowed = [coupon.appliesTo]; }
          if (!ticketIds.some((id: string) => allowed.includes(id))) continue;
        }

        if (coupon.minCartValue && ticketsSubtotal < coupon.minCartValue) continue;

        if (coupon.couponType === 'QUANTITY') {
          if (coupon.minQuantity && totalQuantity < coupon.minQuantity) continue;
          // QUANTITY: all-or-nothing — se esgotado, não aplica
          if (coupon.maxUsage != null && coupon.usageCount >= coupon.maxUsage) continue;
        } else if (coupon.couponType === 'AGE') {
          const now = new Date();
          const min = coupon.minAge ?? 0;
          const max = coupon.maxAge ?? Infinity;
          const ageMatchCount = participants.filter((p: any) => {
            if (!p.birthDate) return false;
            const age = Math.floor((now.getTime() - new Date(p.birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
            return age >= min && age <= max;
          }).length;
          if (ageMatchCount <= 0) continue;
          // Store for use in the age discount block below
          (coupon as any)._ageMatchCount = ageMatchCount;
        }

        {
          let autoApplicableTickets = reservedTickets;
          if (coupon.appliesTo && coupon.appliesTo !== 'all') {
            let allowedIds: string[] = [];
            try { allowedIds = JSON.parse(coupon.appliesTo); } catch { allowedIds = [coupon.appliesTo]; }
            autoApplicableTickets = reservedTickets.filter((rt: any) => allowedIds.includes(rt.ticketId));
          }

          if (coupon.couponType === 'QUANTITY') {
            // QUANTITY: desconto sobre todo o pedido (all-or-nothing)
            const autoApplicableSubtotal = autoApplicableTickets.reduce((sum: number, rt: any) => sum + rt.unitPrice * rt.quantity, 0);
            const autoApplicableQty = autoApplicableTickets.reduce((sum: number, rt: any) => sum + rt.quantity, 0);
            const existingProductsSubtotal = ((order.pendingProducts as any[] | null) ?? []).reduce(
              (sum: number, p: any) => sum + (p.unitPrice ?? 0) * (p.quantity ?? 1),
              0,
            );
            if (coupon.type === 'PERCENTAGE') {
              const applicableRatio = ticketsSubtotal > 0 ? autoApplicableSubtotal / ticketsSubtotal : 1;
              const applicableBase = autoApplicableSubtotal + Math.round(existingProductsSubtotal * applicableRatio);
              autoDiscount = Math.floor(applicableBase * (coupon.value / 100));
            } else {
              autoDiscount = autoApplicableQty * coupon.value;
            }
            autoDiscount = Math.min(autoDiscount, ticketsSubtotal + existingProductsSubtotal);
          } else {
            // AGE: desconto apenas nos ingressos dos participantes que passaram no critério de idade
            const ageMatchCount: number = (coupon as any)._ageMatchCount ?? 0;
            const autoApplicableQty = autoApplicableTickets.reduce((sum: number, rt: any) => sum + rt.quantity, 0);
            const remaining = coupon.maxUsage != null
              ? Math.max(0, coupon.maxUsage - coupon.usageCount)
              : ageMatchCount;
            const effectiveUsage = Math.min(remaining, ageMatchCount, autoApplicableQty);
            if (effectiveUsage <= 0) continue;
            autoDiscount = computePartialCouponDiscount(autoApplicableTickets, coupon.type, coupon.value, effectiveUsage);
            autoEffectiveUsage = effectiveUsage;
            // Track which participant positions qualify for position-aware discount display
            const _ageNow = new Date();
            const _ageMin = coupon.minAge ?? 0;
            const _ageMax = coupon.maxAge ?? Infinity;
            const _totalUnits = reservedTickets.reduce((s: number, rt: any) => s + rt.quantity, 0);
            ageQualifyingSlots = participants
              .map((p: any, i: number) => {
                if (!p.birthDate || i >= _totalUnits) return -1;
                const age = Math.floor((_ageNow.getTime() - new Date(p.birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
                return (age >= _ageMin && age <= _ageMax) ? i : -1;
              })
              .filter((i: number) => i >= 0);
          }

          autoCouponId = coupon.id;
          break;
        }
      }
    }

    // Remover cupom QUANTITY se nova quantidade cair abaixo do mínimo
    let shouldRemoveQuantityCoupon = false;
    if (order.couponId && !autoCouponId) {
      const existingCoupon = await r.coupon.findUnique({
        where: { id: order.couponId },
        select: { couponType: true, minQuantity: true },
      });
      if (
        existingCoupon?.couponType === 'QUANTITY' &&
        existingCoupon.minQuantity &&
        participants.length < existingCoupon.minQuantity
      ) {
        shouldRemoveQuantityCoupon = true;
      }
    }

    // Calcular vagas a liberar se participantes < reservados
    // Participantes sem email são slots ainda não preenchidos — contam como reserva
    const totalReserved = reservedTickets.reduce((sum: number, rt: any) => sum + rt.quantity, 0);
    const totalParticipants = participants.length;

    if (totalParticipants > totalReserved) {
      throw new AppUnprocessableException(
        'PARTICIPANTS_EXCEED_TICKETS',
        `Número de participantes (${totalParticipants}) excede os ingressos reservados (${totalReserved}).`,
      );
    }

    // Calcular quais lotes liberar (remove do final da fila de reservas)
    const releasedBatches: { batchId: string; quantity: number }[] = [];
    let toRelease = totalReserved - totalParticipants;
    const updatedReserved = reservedTickets.map((rt: any) => ({ ...rt })).reverse();
    for (const rt of updatedReserved) {
      if (toRelease <= 0) break;
      const release = Math.min(rt.quantity, toRelease);
      rt.quantity -= release;
      toRelease -= release;
      releasedBatches.push({ batchId: rt.batchId, quantity: release });
    }
    const newReservedTickets = updatedReserved.reverse().filter((rt: any) => rt.quantity > 0);

    // Recalcular total com os ingressos restantes + produtos pendentes
    const newTicketsSubtotal = newReservedTickets.reduce(
      (sum: number, rt: any) => sum + rt.unitPrice * rt.quantity,
      0,
    );
    const productsSubtotal = ((order.pendingProducts as any[] | null) ?? []).reduce(
      (sum: number, p: any) => sum + (p.unitPrice ?? 0) * (p.quantity ?? 1),
      0,
    );
    const newTotalAmount = newTicketsSubtotal + productsSubtotal;
    const newDiscount = autoCouponId ? autoDiscount : (shouldRemoveQuantityCoupon || shouldRemoveAgeCoupon) ? 0 : (order.discount ?? 0);
    const newFinalAmount = Math.max(0, newTotalAmount - newDiscount);

    const updated = await w.$transaction(async (tx: any) => {
      // Restaurar availableQuantity nos lotes liberados
      for (const released of releasedBatches) {
        await tx.$executeRaw`
          UPDATE "TicketBatch"
          SET "availableQuantity" = LEAST("availableQuantity" + ${released.quantity}, "quantity")
          WHERE id = ${released.batchId}::uuid
        `;
      }

      // Atualizar ou deletar os OrderReservedTicket afetados
      for (const rt of updatedReserved) {
        if (rt.quantity === 0) {
          await tx.orderReservedTicket.delete({ where: { id: rt.id } });
        } else if (releasedBatches.some((rb) => rb.batchId === rt.batchId)) {
          await tx.orderReservedTicket.update({
            where: { id: rt.id },
            data: { quantity: rt.quantity },
          });
        }
      }

      return tx.order.update({
        where: { id: orderId },
        data: {
          pendingParticipants: dto.participants,
          totalAmount: newTotalAmount,
          finalAmount: newFinalAmount,
          ...(autoCouponId && {
            couponId: autoCouponId,
            discount: autoDiscount,
          }),
          ...(shouldRemoveQuantityCoupon && {
            couponId: null,
            discount: 0,
          }),
          ...(shouldRemoveAgeCoupon && {
            couponId: null,
            discount: 0,
          }),
          updatedAt: new Date(),
        },
        include: ORDER_INCLUDE,
      });
    });
    return orderShape(updated, newDiscount > 0 ? newDiscount : undefined, { couponAutoRemoved: shouldRemoveQuantityCoupon || shouldRemoveAgeCoupon }, autoEffectiveUsage, undefined, ageQualifyingSlots);
  }

  // ── 3b. patchCoupon ───────────────────────────────────────────────────────

  async patchCoupon(
    userId: string,
    orderId: string,
    dto: PatchCouponDto,
  ): Promise<Record<string, any>> {
    const order = await this.findOrderForWrite(userId, orderId);
    this.assertPending(order);

    if (dto.couponCode && dto.voucherCode) {
      throw new AppUnprocessableException(
        'DISCOUNT_CONFLICT',
        'Não é possível usar cupom e voucher ao mesmo tempo',
      );
    }

    const w: any = this.prisma.getWriteClient();
    const r: any = this.prisma.getReadClient();
    const reservedTickets = (order.reservedTickets ?? []) as any[];
    const ticketsSubtotal = reservedTickets.reduce((sum: number, rt: any) => sum + rt.unitPrice * rt.quantity, 0);
    const productsSubtotal = Math.max(0, (order.totalAmount as number) - ticketsSubtotal);

    let couponId: string | null = null;
    let voucherId: string | null = null;
    let discount = 0;
    let couponEffectiveUsage: number | undefined;
    let couponFixedPerUnit: number | undefined;

    if (dto.couponCode) {
      const coupon = await r.coupon.findFirst({
        where: {
          eventId: order.eventId,
          code: dto.couponCode.toUpperCase().trim(),
          status: 'ACTIVE',
          couponType: 'DISCOUNT',
          deletedAt: null,
        },
      });

      if (!coupon) throw new AppUnprocessableException('COUPON_NOT_FOUND', 'Cupom não encontrado ou inválido');
      if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) throw new AppUnprocessableException('COUPON_EXPIRED', 'Cupom expirado');
      if (coupon.minCartValue && order.totalAmount < coupon.minCartValue) {
        throw new AppUnprocessableException('COUPON_MIN_VALUE', `Valor mínimo do pedido para este cupom: R$ ${(coupon.minCartValue / 100).toFixed(2)}`);
      }

      // Filtrar apenas os tickets aos quais o cupom se aplica
      let applicableTickets = reservedTickets;
      if (coupon.appliesTo && coupon.appliesTo !== 'all') {
        let allowedIds: string[] = [];
        try { allowedIds = JSON.parse(coupon.appliesTo); } catch { allowedIds = [coupon.appliesTo]; }
        applicableTickets = reservedTickets.filter((rt: any) => allowedIds.includes(rt.ticketId));
      }

      const applicableQuantity = applicableTickets.reduce((sum: number, rt: any) => sum + rt.quantity, 0);
      // Aplicar desconto apenas nos ingressos mais caros dentro do uso restante
      const remaining = coupon.maxUsage != null
        ? Math.max(0, coupon.maxUsage - coupon.usageCount)
        : applicableQuantity;
      if (remaining <= 0) throw new AppUnprocessableException('COUPON_EXHAUSTED', 'Cupom esgotado');
      couponEffectiveUsage = Math.min(remaining, applicableQuantity);
      discount = computePartialCouponDiscount(applicableTickets, coupon.type, coupon.value, couponEffectiveUsage);
      discount = Math.min(discount, order.totalAmount as number);
      couponId = coupon.id;
      if (coupon.type === 'FIXED') couponFixedPerUnit = coupon.value;

    } else if (dto.voucherCode) {
      const voucher = await r.voucher.findUnique({
        where: { code: dto.voucherCode.toUpperCase().trim() },
      });

      if (!voucher || voucher.eventId !== order.eventId || voucher.status !== 'ACTIVE') {
        throw new AppUnprocessableException('VOUCHER_NOT_FOUND', 'Voucher não encontrado ou inválido');
      }
      if (voucher.expiryDate && new Date(voucher.expiryDate) < new Date()) {
        throw new AppUnprocessableException('VOUCHER_EXPIRED', 'Voucher expirado');
      }

      discount = ticketsSubtotal; // voucher = 100% dos ingressos
      voucherId = voucher.id;

    } else {
      // Sem código — remover cupom/voucher existente
      couponId = null;
      voucherId = null;
      discount = 0;
    }

    const finalAmount = Math.max(0, order.totalAmount - discount);

    const updated = await w.order.update({
      where: { id: orderId },
      data: {
        couponId,
        voucherId,
        discount,
        finalAmount,
        updatedAt: new Date(),
      },
      include: ORDER_INCLUDE,
    });

    return {
      ...orderShape(updated, discount, undefined, couponEffectiveUsage, couponFixedPerUnit),
      appliedDiscount: {
        type: couponId ? 'coupon' : voucherId ? 'voucher' : null,
        discount,
      },
    };
  }

  // ── 4. patchProducts ──────────────────────────────────────────────────────

  async patchProducts(
    userId: string,
    orderId: string,
    dto: PatchProductsDto,
  ): Promise<Record<string, any>> {
    const order = await this.findOrderForWrite(userId, orderId);
    this.assertPending(order);

    const w: any = this.prisma.getWriteClient();

    const participants = (order.pendingParticipants as any[] | null) ?? [];
    const validEmails = new Set(participants.map((p: any) => p.email?.toLowerCase()));

    // Recalculate product subtotal validando produtos e participantes
    let productsSubtotal = 0;
    for (const item of dto.products) {
      if (!validEmails.has(item.participantEmail.toLowerCase())) {
        throw new UnprocessableEntityException(
          `E-mail "${item.participantEmail}" não pertence a nenhum participante deste pedido.`,
        );
      }

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

    // Recalculate discount when products change: PERCENTAGE coupons apply to the full order.
    // AGE coupons are excluded — their discount is bounded by effectiveUsage (qualifying
    // participants), not totalAmount. Recalculating here would lose that constraint.
    let newDiscount = (order as any).discount ?? 0;
    const activeCoupon = (order as any).coupon;
    if (
      activeCoupon &&
      activeCoupon.type === 'PERCENTAGE' &&
      activeCoupon.couponType !== 'AGE' &&
      !(order as any).voucherId
    ) {
      newDiscount = Math.floor(totalAmount * (activeCoupon.value / 100));
      newDiscount = Math.min(newDiscount, totalAmount);
    }

    const finalAmount = Math.max(0, totalAmount - newDiscount);

    const updated = await w.order.update({
      where: { id: orderId },
      data: {
        pendingProducts: dto.products,
        totalAmount,
        discount: newDiscount,
        finalAmount,
        updatedAt: new Date(),
      },
      include: ORDER_INCLUDE,
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
      include: ORDER_INCLUDE,
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
      include: ORDER_INCLUDE,
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
      // Cupom com código (DISCOUNT type)
      const coupon = await r.coupon.findFirst({
        where: {
          eventId: order.eventId,
          code: dto.couponCode.toUpperCase().trim(),
          status: 'ACTIVE',
          deletedAt: null,
        },
      });
      if (coupon && (!coupon.expiryDate || new Date(coupon.expiryDate) > new Date())) {
        // Aplica desconto nos ingressos mais caros dentro do uso restante
        const applicableQty = reservedTickets.reduce((s: number, rt: any) => s + rt.quantity, 0);
        const remaining = coupon.maxUsage != null
          ? Math.max(0, coupon.maxUsage - coupon.usageCount)
          : applicableQty;
        const effectiveUsage = Math.min(remaining, applicableQty);
        couponDiscount = computePartialCouponDiscount(reservedTickets, coupon.type, coupon.value, effectiveUsage);
        couponId = coupon.id;
      }
    }

    // Cupons automáticos (QUANTITY / AGE) — sem código, aplicados se condição satisfeita
    if (!couponId && !dto.voucherCode) {
      const totalQuantity = reservedTickets.reduce((sum: number, rt: any) => sum + rt.quantity, 0);
      const ticketIds = reservedTickets.map((rt: any) => rt.ticketId);

      const autoCoupons = await w.coupon.findMany({
        where: {
          eventId: order.eventId,
          status: 'ACTIVE',
          deletedAt: null,
          couponType: { in: ['QUANTITY', 'AGE'] },
          OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
        },
      });

      for (const coupon of autoCoupons) {
        // Verificar appliesTo — se não for 'all', checar se algum ticket está na lista
        if (coupon.appliesTo && coupon.appliesTo !== 'all') {
          let allowedTicketIds: string[] = [];
          try {
            allowedTicketIds = JSON.parse(coupon.appliesTo);
          } catch {
            allowedTicketIds = [];
          }
          if (!ticketIds.some((id: string) => allowedTicketIds.includes(id))) continue;
        }

        if (coupon.couponType === 'QUANTITY') {
          if (totalQuantity < (coupon.minQuantity ?? 0)) continue;
          // QUANTITY: all-or-nothing — se esgotado, não aplica
          if (coupon.maxUsage != null && coupon.usageCount >= coupon.maxUsage) continue;

          // Aplica sobre todo o pedido
          couponDiscount =
            coupon.type === 'PERCENTAGE'
              ? Math.floor(preDiscountTotal * (coupon.value / 100))
              : Math.min(coupon.value, preDiscountTotal);
          couponId = coupon.id;
          break;
        } else if (coupon.couponType === 'AGE') {
          // Validar idade dos participantes — aplica apenas nos que passam no critério
          const now = new Date();
          const minAge = coupon.minAge ?? 0;
          const maxAge = coupon.maxAge ?? Infinity;
          const ageMatchCount = participants.filter((p: any) => {
            if (!p.birthDate) return false;
            const age = Math.floor((now.getTime() - new Date(p.birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
            return age >= minAge && age <= maxAge;
          }).length;

          if (ageMatchCount <= 0) continue;

          // AGE: aplica nos ingressos mais caros dos participantes qualificados
          let ageApplicableTickets = reservedTickets;
          if (coupon.appliesTo && coupon.appliesTo !== 'all') {
            let allowed: string[] = [];
            try { allowed = JSON.parse(coupon.appliesTo); } catch { allowed = []; }
            ageApplicableTickets = reservedTickets.filter((rt: any) => allowed.includes(rt.ticketId));
          }
          const ageApplicableQty = ageApplicableTickets.reduce((s: number, rt: any) => s + rt.quantity, 0);
          const remaining = coupon.maxUsage != null
            ? Math.max(0, coupon.maxUsage - coupon.usageCount)
            : ageMatchCount;
          const effectiveUsage = Math.min(remaining, ageMatchCount, ageApplicableQty);
          if (effectiveUsage <= 0) continue;
          couponDiscount = computePartialCouponDiscount(ageApplicableTickets, coupon.type, coupon.value, effectiveUsage);
          couponId = coupon.id;
          break;
        }
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
    const pixDiscount = 0;
    const finalTotal = discountedTotal;

    // 6.8 Prepare payment data
    const user = await r.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true },
    });

    const firstCpf = participants[0]?.cpf?.replace(/\D/g, '') || undefined;
    // Cielo limit: 50 chars. "order-" (6) + 8-char id slice (8) + "-" (1) + timestamp (13) = 28
    const merchantOrderId = `order-${orderId.replace(/-/g, '').slice(0, 8)}-${Date.now()}`;

    let cardData:
      | { number: string; holder: string; expiry: string; cvv: string; installments: number }
      | undefined;
    let cardTokenData:
      | { token: string; brand: string; holder?: string; securityCode?: string; installments: number }
      | undefined;
    let threedsData:
      | { cavv: string; eci: string; xid?: string; version?: string; referenceId?: string }
      | undefined;

    if (dto.method === PaymentMethod.CREDIT_CARD) {
      if (dto.cardToken) {
        cardTokenData = {
          token: dto.cardToken.token,
          brand: dto.cardToken.brand,
          holder: dto.cardToken.holder,
          securityCode: dto.cardToken.securityCode,
          installments: dto.cardToken.installments ?? 1,
        };
      } else if (dto.card) {
        cardData = {
          number: dto.card.number,
          holder: dto.card.name,
          expiry: dto.card.expiry,
          cvv: dto.card.cvv,
          installments: dto.card.installments ?? 1,
        };
      } else {
        throw new AppUnprocessableException('CARD_REQUIRED', 'Card data or card token is required');
      }
    }

    if (dto.method === PaymentMethod.DEBIT_CARD) {
      if (!dto.card) {
        throw new AppUnprocessableException('CARD_REQUIRED', 'Card data is required for debit card payments');
      }
      if (!dto.threeDs) {
        throw new AppUnprocessableException('THREEDS_REQUIRED', '3DS authentication data is required for debit card payments');
      }
      cardData = {
        number: dto.card.number,
        holder: dto.card.name,
        expiry: dto.card.expiry,
        cvv: dto.card.cvv,
        installments: 1,
      };
      threedsData = {
        cavv: dto.threeDs.cavv,
        eci: dto.threeDs.eci,
        xid: dto.threeDs.xid,
        version: dto.threeDs.version ?? '2',
        referenceId: dto.threeDs.referenceId,
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
        cardTokenData,
        threedsData,
      );
      if (!cieloResult.success) {
        paymentFailed = true;
      }
    } catch (err: any) {
      this.logger.warn(`Payment failed for order ${orderId}: ${err.message}`);
      paymentFailed = true;
      cieloResult = { success: false, error: err.message };
    }

    // 6.10 Payment failed → retornar erro sem cancelar o pedido (usuário pode tentar novamente)
    if (paymentFailed) {
      const errBody = {
        error: true,
        code: 'PAYMENT_REFUSED',
        message: cieloResult.error || 'Pagamento recusado. Verifique os dados e tente novamente.',
      };
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

        await tx.payment.upsert({
          where: { orderId },
          create: {
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
          update: {
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
          transactionId: cieloResult.paymentId ?? null,
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

    // 6.12 CREDIT_CARD / DEBIT_CARD: verify approval
    const isApproved =
      cieloResult.cieloStatus === 'Authorized' ||
      cieloResult.cieloStatus === 'PaymentConfirmed';

    if (!isApproved) {
      const errBody = { error: true, code: 'PAYMENT_REFUSED', message: 'Pagamento não autorizado. Verifique os dados do cartão e tente novamente.' };
      throw new HttpException(errBody, 402);
    }

    // 6.13 Pré-carregar dados para receipt snapshot (fora da tx para não bloquear locks)
    const ticketIds = reservedTickets.map((rt: any) => rt.ticketId);
    const [snapshotTickets, snapshotEvent, snapshotQuestions] = await Promise.all([
      r.ticket.findMany({
        where: { id: { in: ticketIds } },
        include: {
          category: { select: { id: true, name: true } },
          batches: { select: { id: true, price: true, sortOrder: true } },
        },
      }),
      r.event.findUnique({
        where: { id: order.eventId },
        select: {
          id: true, name: true, slug: true,
          eventDate: true, registrationStartDate: true, registrationEndDate: true,
          location: true, city: true, state: true, country: true, zipCode: true, neighborhood: true,
          bannerUrl: true, logoUrl: true,
        },
      }),
      r.question.findMany({
        where: { eventId: order.eventId, isActive: true },
        select: { id: true, question: true, description: true, type: true, options: true, isRequired: true },
      }),
    ]);
    const snapshotTicketById = new Map(snapshotTickets.map((t: any) => [t.id, t]));
    const snapshotQuestionById = new Map<any, any>(snapshotQuestions.map((q: any) => [q.id, q]));

    // 6.14 Finalize: mark PAID, create Payment, create Registrations
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

      // Upsert Payment record — a PENDING payment may already exist (e.g. prior PIX attempt).
      const paymentData = {
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
          ...(dto.card && dto.method === PaymentMethod.CREDIT_CARD && {
            creditCard: {
              brand: cieloResult.cardBrand ?? null,
              last4Digits: dto.card.number.replace(/\s/g, '').slice(-4),
              holder: dto.card.name,
              installments: dto.card.installments ?? 1,
            },
          }),
          ...(dto.card && dto.method === PaymentMethod.DEBIT_CARD && {
            debitCard: {
              brand: cieloResult.cardBrand ?? null,
              last4Digits: dto.card.number.replace(/\s/g, '').slice(-4),
              holder: dto.card.name,
            },
          }),
        },
      };
      await tx.payment.upsert({
        where: { orderId },
        create: paymentData,
        update: {
          method: paymentData.method,
          status: paymentData.status,
          amount: paymentData.amount,
          transactionId: paymentData.transactionId,
          paymentDate: paymentData.paymentDate,
          metadata: paymentData.metadata,
        },
      });

      // Apply coupon usage
      if (couponId) {
        const couponForUsage = await tx.coupon.findUnique({
          where: { id: couponId },
          select: { couponType: true, maxUsage: true, usageCount: true },
        });
        const ticketCount = reservedTickets.reduce((sum: number, rt: any) => sum + (rt.quantity ?? 1), 0);
        let usageIncrement: number;
        if (couponForUsage?.couponType === 'QUANTITY') {
          // QUANTITY: all-or-nothing — race condition protection
          if (couponForUsage.maxUsage != null && couponForUsage.usageCount >= couponForUsage.maxUsage) {
            throw new BadRequestException('Cupom esgotado. Prossiga sem desconto ou escolha outro cupom.');
          }
          usageIncrement = 1;
        } else {
          // DISCOUNT/AGE: uso parcial — registra apenas o que foi efetivamente aplicado
          const remaining = couponForUsage?.maxUsage != null
            ? Math.max(0, couponForUsage.maxUsage - couponForUsage.usageCount)
            : ticketCount;
          usageIncrement = Math.min(remaining, ticketCount);
        }
        if (usageIncrement > 0) await tx.coupon.update({
          where: { id: couponId },
          data: { usageCount: { increment: usageIncrement } },
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

          // Resolve participant — nunca cria User fantasma
          let participantUserId: string | null = userId;
          let guestSnapshot: { name: string; email: string; cpf: string; cpfClean: string; phone: string; dateOfBirth: Date | null; gender: string | null } | null = null;

          if (pData.email?.toLowerCase() !== buyerUser?.email?.toLowerCase()) {
            const existingUser = await tx.user.findFirst({ where: { email: pData.email } });
            if (existingUser) {
              participantUserId = existingUser.id;
            } else {
              participantUserId = null;
              guestSnapshot = {
                name: pData.name ?? '',
                email: pData.email ?? '',
                cpf: pData.cpf ?? '',
                cpfClean: (pData.cpf ?? '').replace(/\D/g, ''),
                phone: pData.phone ?? '',
                dateOfBirth: pData.birthDate ? new Date(pData.birthDate) : null,
                gender: pData.gender ?? null,
              };
            }
          }

          const isGuest = participantUserId === null;
          const isDifferentUser = participantUserId !== null && participantUserId !== userId;

          const reg = await tx.registration.create({
            data: {
              eventId: order.eventId,
              orderId,
              userId: participantUserId,
              invitedById: (isDifferentUser || isGuest) ? userId : null,
              status: RegistrationStatus.CONFIRMED,
              termsAccepted: true,
              rulesAccepted: true,
              emergencyContactName: pData.emergencyContactName?.trim() || null,
              emergencyContactPhone: pData.emergencyPhone?.trim() || null,
              ...(guestSnapshot && {
                participantName: guestSnapshot.name,
                participantEmail: guestSnapshot.email,
                participantCpf: guestSnapshot.cpf,
                participantCpfClean: guestSnapshot.cpfClean,
                participantPhone: guestSnapshot.phone,
                participantDateOfBirth: guestSnapshot.dateOfBirth,
                participantGender: guestSnapshot.gender,
              }),
            },
          });

          const frontendUrl = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');
          const qrPayload = `${frontendUrl}/user/tickets/${reg.id}`;
          const updatedReg = await tx.registration.update({
            where: { id: reg.id },
            data: { qrCode: qrPayload },
            select: { id: true, qrCode: true, status: true },
          });

          const ticketData = snapshotTicketById.get(rt.ticketId) as any;
          const batchData = ticketData?.batches?.find((b: any) => b.id === rt.batchId) ?? null;
          const ticketSnapshot = ticketData ? {
            id: ticketData.id,
            name: ticketData.name,
            description: ticketData.description ?? null,
            modality: ticketData.modality ?? null,
            distance: ticketData.distance ?? null,
            distanceUnit: ticketData.distanceUnit ?? null,
            gender: ticketData.gender ?? null,
            ageLimitMin: ticketData.ageLimitMin ?? null,
            ageLimitMax: ticketData.ageLimitMax ?? null,
            category: ticketData.category ?? null,
            batch: batchData ? { id: batchData.id, name: batchData.name, price: batchData.price } : null,
          } : null;

          await tx.registrationTicket.create({
            data: {
              registrationId: reg.id,
              ticketId: rt.ticketId,
              batchId: rt.batchId,
              ticketSnapshot,
            },
          });

          // Create RegistrationProduct records para este participante
          const participantProducts = (pendingProducts ?? []).filter(
            (item: any) => item.participantEmail?.toLowerCase() === pData.email?.toLowerCase(),
          );
          const participantProductMap = new Map<string, any>();
          if (participantProducts.length > 0) {
            for (const item of participantProducts) {
              const product = await r.product.findUnique({
                where: { id: item.productId },
                include: { variations: true },
              });
              if (product) participantProductMap.set(product.id, product);
              if (!product) continue;
              let unitPrice: number = product.basePrice;
              if (item.variationId) {
                const variation = product.variations.find((v: any) => v.id === item.variationId);
                if (variation) unitPrice = variation.name === 'Sem interesse' ? 0 : variation.price;
              }
              const selectedVariation = item.variationId
                ? (product.variations ?? []).find((v: any) => v.id === item.variationId)
                : null;
              const productSnapshot = {
                id: product.id,
                name: product.name,
                images: (product as any).images ?? [],
                primaryImageIndex: (product as any).primaryImageIndex ?? 0,
                basePrice: product.basePrice,
                isIncludedInTicket: (product as any).isIncludedInTicket,
                isRequired: (product as any).isRequired,
                variationType: (product as any).variationType ?? null,
                selectedVariation: selectedVariation
                  ? { id: selectedVariation.id, name: selectedVariation.name, price: (selectedVariation as any).price }
                  : null,
              };
              await tx.registrationProduct.create({
                data: {
                  registrationId: reg.id,
                  productId: item.productId,
                  variationId: item.variationId ?? null,
                  quantity: item.quantity ?? 1,
                  unitPrice,
                  totalPrice: unitPrice * (item.quantity ?? 1),
                  productSnapshot,
                },
              });
            }
          }

          // Question answers com snapshot da pergunta
          const snapshotedAnswers: any[] = [];
          if (pData.questionAnswers?.length) {
            for (const qa of pData.questionAnswers) {
              const questionData = snapshotQuestionById.get(qa.questionId);
              const questionSnapshot = questionData ? {
                id: questionData.id,
                question: questionData.question,
                description: questionData.description ?? null,
                type: questionData.type,
                options: questionData.options ?? null,
                isRequired: questionData.isRequired,
              } : null;
              await tx.questionAnswer.create({
                data: {
                  registrationId: reg.id,
                  questionId: qa.questionId,
                  answer: String(qa.answer),
                  questionSnapshot,
                },
              });
              snapshotedAnswers.push({
                question: questionSnapshot ?? { id: qa.questionId },
                answer: String(qa.answer),
              });
            }
          }

          // Construir receipt snapshot completo
          const participantProductSnapshots = (participantProducts ?? []).map((item: any) => {
            const prod = participantProductMap?.get(item.productId) as any;
            return prod ? {
              id: prod.id,
              name: prod.name,
              images: prod.images ?? [],
              primaryImageIndex: prod.primaryImageIndex ?? 0,
              basePrice: prod.basePrice,
              variationType: prod.variationType ?? null,
              quantity: item.quantity ?? 1,
              unitPrice: prod.basePrice,
              selectedVariation: item.variationId
                ? (prod.variations ?? []).find((v: any) => v.id === item.variationId) ?? null
                : null,
            } : { id: item.productId, quantity: item.quantity ?? 1 };
          });

          const receiptSnapshot = {
            event: snapshotEvent ? {
              id: snapshotEvent.id,
              name: snapshotEvent.name,
              slug: snapshotEvent.slug,
              startDate: snapshotEvent.startDate,
              endDate: snapshotEvent.endDate,
              location: {
                street: snapshotEvent.street ?? null,
                number: snapshotEvent.number ?? null,
                city: snapshotEvent.city ?? null,
                state: snapshotEvent.state ?? null,
                country: snapshotEvent.country ?? null,
                zipCode: snapshotEvent.zipCode ?? null,
              },
            } : null,
            ticket: ticketSnapshot,
            products: participantProductSnapshots,
            questionAnswers: snapshotedAnswers,
            participant: {
              name: pData.name ?? null,
              email: pData.email ?? null,
              cpf: pData.cpf ?? null,
              phone: pData.phone ?? null,
              birthDate: pData.birthDate ?? null,
              gender: pData.gender ?? null,
            },
            billing: {
              postalCode: order.billingPostalCode ?? null,
              street: order.billingStreet ?? null,
              number: order.billingNumber ?? null,
              complement: order.billingComplement ?? null,
              neighborhood: order.billingNeighborhood ?? null,
              city: order.billingCity ?? null,
              state: order.billingState ?? null,
              country: order.billingCountry ?? null,
            },
            pricing: {
              ticketsSubtotal,
              productsSubtotal,
              discount: couponDiscount + voucherDiscount,
              pixDiscount,
              finalTotal,
              coupon: order.coupon ? {
                id: order.coupon.id,
                code: order.coupon.code,
                type: order.coupon.type,
                value: order.coupon.value,
              } : null,
              voucher: order.voucher ? {
                id: order.voucher.id,
                code: order.voucher.code,
                name: order.voucher.name,
              } : null,
            },
            paidAt: new Date().toISOString(),
          };

          await tx.registration.update({
            where: { id: reg.id },
            data: { receiptSnapshot },
          });

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
        ...(dto.method === PaymentMethod.CREDIT_CARD && cardData && {
          creditCard: {
            installments: cardData.installments,
            installmentValue: Math.floor(finalTotal / cardData.installments),
          },
        }),
        ...(dto.method === PaymentMethod.DEBIT_CARD && cardData && {
          debitCard: {
            brand: cieloResult.cardBrand ?? null,
            last4Digits: cardData.number.replace(/\s/g, '').slice(-4),
          },
        }),
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

    // Envio de email de confirmação com PDF do ingresso — fire-and-forget
    if (snapshotEvent) {
      const r2: any = this.prisma.getReadClient();
      r2.order.findUnique({
        where: { id: orderId },
        include: {
          event: { include: { organization: true } },
          payment: true,
          coupon: true,
          voucher: true,
          registrations: {
            include: {
              user: true,
              tickets: { include: { ticket: { include: { category: true } }, batch: true } },
              products: { include: { product: true, variation: true } },
              questionAnswers: { include: { question: true } },
            },
          },
        },
      }).then(async (order: any) => {
        if (!order) return;
        const event = order.event ?? snapshotEvent;
        const org = event?.organization ?? {};
        const orgName = org.tradeName || org.name || '';
        const regs: any[] = order.registrations ?? [];
        const location = formatEventAddress(event) || '—';

        const issuedAt = new Date();
        const orderNumber = orderId.slice(0, 8).toUpperCase();

        const ticketPdfData = {
          orderNumber,
          issuedAt,
          event: {
            name: snapshotEvent.name ?? '',
            date: snapshotEvent.eventDate ?? new Date(),
            organization: orgName,
            location,
            participantCount: regs.length,
          },
          registrations: regs.map((reg: any, idx: number) => {
            const user = reg.user ?? {};
            const ticket = reg.tickets?.[0]?.ticket;
            const catName = ticket?.category?.name ?? '';
            const ticketName = ticket?.name ?? '';
            const fullTicketName = catName && ticketName && catName !== ticketName
              ? `${catName} - ${ticketName}` : ticketName || catName;
            return {
              index: idx + 1,
              qrCode: reg.qrCode ?? reg.id,
              participantName: (reg.participantName ?? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()) || 'Participante',
              ticketName: fullTicketName,
              email: reg.participantEmail ?? user.email,
              cpf: reg.participantCpf ?? user.documentNumber,
              dateOfBirth: reg.participantDateOfBirth ?? user.dateOfBirth,
              phone: reg.participantPhone ?? user.phone,
              gender: reg.participantGender ?? user.gender,
              questionAnswers: (reg.questionAnswers ?? []).map((qa: any) => ({
                question: qa.question?.question ?? '',
                answer: qa.answer ?? '',
              })),
              products: (reg.products ?? []).map((rp: any) => ({
                name: rp.product?.name ?? '',
                price: rp.unitPrice ?? 0,
                variationName: rp.variation?.name,
                imageUrl: rp.product?.images?.[rp.product?.primaryImageIndex ?? 0],
                isIncluded: rp.product?.isIncludedInTicket ?? false,
              })),
            };
          }),
        };

        const payment = order.payment ?? {};
        const buyerUser = regs.find((r: any) => r.user)?.user ?? {};
        const receiptPdfData = {
          orderNumber,
          issuedAt,
          organization: { name: orgName, document: org.document, logoUrl: org.logoUrl ?? undefined },
          buyer: {
            name: `${buyerUser.firstName ?? ''} ${buyerUser.lastName ?? ''}`.trim() || 'Comprador',
            document: buyerUser.documentNumber,
          },
          event: { name: snapshotEvent.name ?? '', date: snapshotEvent.eventDate ?? new Date(), location },
          payment: {
            method: payment.method ?? 'PIX',
            paidAt: payment.paymentDate ?? payment.updatedAt ?? issuedAt,
            gateway: 'Cielo',
            transactionId: payment.transactionId,
            txId: (payment.metadata as any)?.txId,
            e2eId: (payment.metadata as any)?.e2eId,
            voucherCode: order.voucher?.code,
            couponCode: order.coupon?.code,
            cardBrand: (payment.metadata as any)?.cardBrand ?? undefined,
          },
          financial: {
            subtotal: order.totalAmount ?? 0,
            discount: order.discount ?? 0,
            voucherCode: order.voucher?.code,
            serviceFee: order.serviceFee ?? 0,
            total: order.finalAmount ?? 0,
          },
          registrations: regs.map((reg: any) => {
            const user = reg.user ?? {};
            const ticket = reg.tickets?.[0]?.ticket;
            const catName = ticket?.category?.name ?? '';
            const ticketName = ticket?.name ?? '';
            const batch = reg.tickets?.[0]?.batch;
            return {
              id: reg.id,
              participantName: (reg.participantName ?? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()) || 'Participante',
              email: reg.participantEmail ?? user.email,
              ticketCategory: catName || undefined,
              ticketName: ticketName || catName,
              price: batch?.price ?? 0,
            };
          }),
        };

        const ticketPdf = await this.ticketPdfService.generateTicketPdf(ticketPdfData).catch((e: any) => { this.logger.warn('Ticket PDF failed:', e?.message); return undefined; });
        const receiptPdf = await this.receiptPdfService.generateReceiptPdf(receiptPdfData).catch((e: any) => { this.logger.warn('Receipt PDF failed:', e?.message); return undefined; });

        const buyer = regs.find((r: any) => r.user?.email)?.user;
        if (!buyer?.email) return;

        return this.emailService.sendRegistrationConfirmed({
          email: buyer.email,
          firstName: buyer.firstName || 'Participante',
          eventName: snapshotEvent.name,
          eventLocation: location,
          eventDate: formatEventDate(snapshotEvent.eventDate ?? (event as any).eventDate),
          eventAddress: location,
          eventBannerUrl: (snapshotEvent as any).logoUrl || (snapshotEvent as any).bannerUrl || '',
          ticketPdf: ticketPdf as Buffer | undefined,
          receiptPdf: receiptPdf as Buffer | undefined,
        });
      }).catch((err: any) => this.logger.warn('Failed to send registration confirmation email:', err));
    }

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
      include: ORDER_INCLUDE,
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
      include: ORDER_INCLUDE,
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
