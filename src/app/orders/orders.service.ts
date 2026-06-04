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
import {
  DocumentType,
  PaymentMethod,
  PaymentStatus,
  RegistrationStatus,
  UserActivityCategory,
  UserActivitySource,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from '../payments/cielo.service';
import { OrderFinalizationService, OrderFinalizationAbortError } from '../payments/order-finalization.service';
import { OrdersRedisService } from './orders-redis.service';
import { ReserveOrderDto } from './dto/reserve-order.dto';
import { PatchParticipantsDto } from './dto/patch-participants.dto';
import { PatchProductsDto } from './dto/patch-products.dto';
import { PatchBillingAddressDto } from './dto/patch-billing-address.dto';
import { PayOrderDto } from './dto/pay-order.dto';
import { PatchCouponDto } from './dto/patch-coupon.dto';
import { EmailService } from '../../common/services/email.service';
import { TicketPdfService } from '../../common/services/ticket-pdf.service';
import { UserActivityService } from '../../common/services/user-activity.service';
import { parseAppliesToArray } from '../../helpers/AppliesToHelper';
import {
  cleanDocumentNumber,
  resolveDocument,
} from '../../common/utils/document.util';
import { resolveProductUnitPrice } from '../../common/utils/product-price.util';
import {
  computeDocEligibleSlots,
  computeVoucherEligibleSlots,
  computeAgeEligibleSlots,
  computeCouponCoveredUnits,
} from '../../common/utils/coupon-eligibility.util';
import { claimVoucher, releaseVoucherByOrder } from '../../common/utils/voucher-reservation.util';
import { stripOrganizationContact } from '../../common/utils/organization-sanitizer.util';

// Fallback de expiração da reserva de voucher quando o pedido (excepcionalmente) não tem
// `expiresAt` — mantém a rede de segurança da reserva sem prendê-la para sempre.
const VOUCHER_RESERVATION_FALLBACK_MS = 30 * 60 * 1000; // 30 min

// Re-export dos helpers de elegibilidade (movidos p/ util neutro reusado pelo finalize sem
// criar ciclo de módulo) — mantém os imports/specs que os consomem a partir deste arquivo.
export {
  computeDocEligibleSlots,
  computeVoucherEligibleSlots,
  computeAgeEligibleSlots,
  computeCouponCoveredUnits,
};

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
      const prevExpired = prev.endDate && now > new Date(prev.endDate);
      const currStarted = !curr.startDate || now >= new Date(curr.startDate);
      if (prevExpired || (currStarted && curr.startDate != null)) activeIdx = i;
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
  coupon: { select: { id: true, code: true, couponType: true, type: true, value: true, appliesTo: true, minAge: true, maxAge: true, applyToProducts: true, cpfListStatus: true, documentList: true, cpfList: true, maxUsage: true, usageCount: true } },
  voucher: { select: { id: true, code: true, name: true, status: true, appliesTo: true, applyToProducts: true, cpfListStatus: true, documentList: true, cpfList: true } },
  payment: { select: { id: true, method: true, status: true, amount: true, transactionId: true, paymentDate: true, createdAt: true, metadata: true } },
  // participantFeePercent é necessário para calcular serviceFee em pedidos PENDING
  // (em que order.serviceFee ainda é 0). organizerFeePercent é congelado como snapshot no
  // pagamento (Order.organizerFeePercent). eventDate é usado como referência para validar
  // cupons AGE — a idade do participante é calculada na data do evento, não na atual.
  // Nada disso é exposto no payload — orderShape retorna apenas eventId.
  // acceptedPaymentMethods é a whitelist configurada na tela financeira do evento,
  // validada no pay() antes de chamar o gateway.
  event: { select: { participantFeePercent: true, organizerFeePercent: true, eventDate: true, acceptedPaymentMethods: true } },
} as const;

/**
 * Resolve a data de referência para validação de cupons AGE.
 * Usa eventDate quando disponível (fonte da verdade); fallback para "agora"
 * preserva comportamento em pedidos cujo include não trouxe o evento.
 */
function resolveAgeReferenceDate(order: any): Date {
  const ed = order?.event?.eventDate;
  return ed ? new Date(ed) : new Date();
}

/**
 * Taxa de serviço cobrada do participante.
 *
 * Fórmula aplicada: taxa incide sobre `(totalAmount - discount)`, em linha com
 *   ((ingresso - cupom/voucher) + produto adicional) + % taxa de serviço.
 * Como o desconto é construído para abater apenas o ingresso (clampado em
 * `ticketsSubtotal` no checkout), `total - discount` equivale a
 * `(ingresso_pós_desconto + produto)` sem precisar separar os subtotais aqui.
 *
 * - Pós-pagamento: usa o valor congelado em `order.serviceFee` (representa o que foi
 *   efetivamente cobrado, mesmo que a config do evento mude depois).
 * - PENDING (serviceFee = 0): calcula on-the-fly a partir de `event.participantFeePercent`.
 *   Requer que o caller tenha incluído `event` no select.
 */
function computeServiceFee(order: any): number {
  if (order?.serviceFee && order.serviceFee > 0) return order.serviceFee;
  const percent = order?.event?.participantFeePercent ?? 0;
  const total = order?.totalAmount ?? 0;
  const discount = order?.discount ?? 0;
  if (!total || !percent) return 0;
  const base = Math.max(0, total - discount);
  return Math.round(base * (percent / 100));
}

/**
 * Valor final exibido ao usuário: `(totalAmount - discount) + serviceFee`.
 * - Pós-pagamento (serviceFee já gravado): confia em `order.finalAmount` da DB
 *   (valor congelado no momento do pagamento).
 * - PENDING: recompõe a partir do serviceFee calculado.
 */
function computeFinalAmount(order: any, serviceFee: number): number {
  if (order?.serviceFee && order.serviceFee > 0) return order.finalAmount ?? 0;
  const total = order?.totalAmount ?? 0;
  const discount = order?.discount ?? 0;
  return Math.max(0, total - discount) + serviceFee;
}

// ─── shape helpers ───────────────────────────────────────────────────────────

/**
 * Expande reservedTickets em entradas individuais (quantity: 1 cada) e distribui
 * o desconto do cupom apenas nas unidades cobertas pelo effectiveUsage.
 * Sempre retorna uma entrada por ingresso, permitindo ao frontend identificar
 * exatamente quais receberam desconto.
 */
export function distributeDiscount(
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
      // FIXED: clampa o desconto por slot em unitPrice (evita finalUnitPrice negativo
      // quando o cupom é maior que o preço do ingresso — ex.: cupom FIXED grande com
      // applyToProducts=true cobrindo também produtos adicionais).
      for (let i = 0; i < coveredQty; i++) {
        const slotIdx = sorted[i];
        units[slotIdx].discount = Math.min(fixedPerUnit, units[slotIdx].rt.unitPrice);
      }
    } else {
      // PERCENTAGE: distribui totalDiscount proporcional ao unitPrice entre os slots cobertos.
      // Quando totalDiscount > subtotal dos ingressos cobertos (cupom com applyToProducts=true),
      // só a porção que cabe nos ingressos é distribuída por slot — o excedente fica implícito
      // em order.discount (finalAmount segue correto via order.discount agregado).
      const coveredSubtotal = sorted.slice(0, coveredQty).reduce((s, i) => s + units[i].rt.unitPrice, 0);
      const ticketsPortion = Math.min(totalDiscount, coveredSubtotal);
      let distrib = 0;
      for (let i = 0; i < coveredQty; i++) {
        const isLast = i === coveredQty - 1;
        const slotIdx = sorted[i];
        const unitPrice = units[slotIdx].rt.unitPrice;
        let allocated = isLast
          ? ticketsPortion - distrib
          : coveredSubtotal > 0
            ? Math.round(ticketsPortion * (unitPrice / coveredSubtotal))
            : 0;
        allocated = Math.min(allocated, unitPrice);
        units[slotIdx].discount = allocated;
        distrib += allocated;
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

/**
 * Desconto total do cupom (em centavos), considerando os N melhores slots de ingresso
 * cobertos (`effectiveUsage`).
 *
 * `productsBaseExtra` — valor extra que entra na base de cálculo quando o cupom tem
 * `applyToProducts=true`. Deve ser passado pelos callers como o subtotal dos produtos
 * adicionais aplicáveis (ou 0 quando o flag está desligado). Para PERCENTAGE, soma à
 * base do cálculo; para FIXED, amplia o cap do desconto.
 */
export function computePartialCouponDiscount(
  reservedTickets: any[],
  couponValueType: string,
  couponValue: number,
  effectiveUsage: number,
  productsBaseExtra: number = 0,
): number {
  if (effectiveUsage <= 0) return 0;
  const units = reservedTickets
    .flatMap((rt: any) => Array(rt.quantity).fill(rt.unitPrice))
    .sort((a: number, b: number) => b - a)
    .slice(0, effectiveUsage);
  const ticketsBase = units.reduce((s: number, p: number) => s + p, 0);
  const combinedBase = ticketsBase + Math.max(0, productsBaseExtra);
  if (couponValueType === 'PERCENTAGE') {
    return Math.floor(combinedBase * (couponValue / 100));
  }
  // FIXED: valor por uso, com cap no subtotal combinado (ingressos cobertos + produtos
  // aplicáveis quando applyToProducts=true). Sem o flag, productsBaseExtra=0 e o cap
  // reduz para ticketsBase — preserva clamp implícito de antes.
  return Math.min(effectiveUsage * couponValue, combinedBase);
}

/**
 * Subtotal (centavos) dos produtos adicionais no carrinho do pedido (PENDING).
 * Lê `order.pendingProducts` (Json) — formato `{ productId, variationId?, quantity, unitPrice, participantEmail }`.
 */
function computePendingProductsSubtotal(order: any): number {
  return ((order?.pendingProducts as any[] | null) ?? []).reduce(
    (s: number, p: any) => s + (p?.unitPrice ?? 0) * (p?.quantity ?? 1),
    0,
  );
}

/**
 * Mapa `email(lowercase) → ticketId` do participante, pela convenção POSICIONAL de slots:
 * expande `reservedTickets` por `quantity` e o participante do slot `i` recebe aquele `ticketId`.
 * É EXATAMENTE a regra usada no finalize (`OrderFinalizationService`) para materializar qual
 * ingresso cada participante levou — então o escopo de desconto aqui nunca diverge da venda.
 * Slots vazios (participante sem email) são ignorados.
 */
export function buildParticipantTicketMap(reservedTickets: any[], participants: any[]): Map<string, string> {
  const map = new Map<string, string>();
  let slot = 0;
  for (const rt of reservedTickets ?? []) {
    const qty = rt?.quantity ?? 0;
    for (let i = 0; i < qty; i++) {
      const email = (participants?.[slot]?.email ?? '').toString().trim().toLowerCase();
      // FIRST-WINS para e-mail duplicado em 2+ slots (comprador com 2 ingressos pra si):
      // sobrescrever fazia o ÚLTIMO slot vencer e o escopo de applyToProducts ser avaliado
      // contra o ingresso errado. Primeira ocorrência alinha com o consumo first-wins de
      // produtos no finalize (consumedProductIdx) — escopo e entrega nunca divergem.
      if (email && !map.has(email)) map.set(email, rt.ticketId);
      slot++;
    }
  }
  return map;
}

/**
 * Subtotal (centavos) dos produtos cujo PARTICIPANTE escolheu um ingresso APLICÁVEL ao
 * cupom/voucher (definido por `appliesTo`). Cada item de `pendingProducts` traz
 * `participantEmail`; o ingresso vem do mapa posicional. Produto de participante em ingresso
 * NÃO-aplicável (ex.: o ingresso do amigo) fica de fora — é o cerne do escopo por ingresso.
 * Produto sem participante mapeável também não entra.
 */
export function computeApplicableProductsSubtotal(
  pendingProducts: any[],
  participantTicketMap: Map<string, string>,
  applicableTicketIds: Set<string>,
): number {
  return (pendingProducts ?? []).reduce((s: number, pp: any) => {
    const email = (pp?.participantEmail ?? '').toString().trim().toLowerCase();
    const ticketId = email ? participantTicketMap.get(email) : undefined;
    return ticketId && applicableTicketIds.has(ticketId)
      ? s + (pp?.unitPrice ?? 0) * (pp?.quantity ?? 1)
      : s;
  }, 0);
}

/**
 * Conjunto de ticketIds do pedido que o `appliesTo` cobre. `'all'`/null → todos os ingressos
 * reservados; lista → interseção com os reservados. Base para escopar produtos por ingresso.
 */
export function resolveApplicableTicketIds(
  appliesTo: string | null | undefined,
  reservedTickets: any[],
): Set<string> {
  const all = new Set<string>((reservedTickets ?? []).map((rt: any) => rt.ticketId));
  if (!appliesTo || appliesTo === 'all') return all;
  const allowed = new Set(parseAppliesToArray(appliesTo));
  return new Set([...all].filter((id) => allowed.has(id)));
}

/**
 * Subtotal (centavos) dos produtos do PARTICIPANTE de um slot específico — usado pelo VOUCHER,
 * que cobre UM ingresso (a unidade `qualifyingSlot`). O desconto de produto do voucher incide
 * só nos produtos daquele participante (o "ingresso coberto"), nunca nos dos outros.
 * `slot < 0` (nenhuma unidade aplicável) ou participante sem email → 0.
 */
export function computeSlotParticipantProductsSubtotal(
  pendingProducts: any[],
  participants: any[],
  slot: number,
): number {
  if (slot == null || slot < 0) return 0;
  const email = (participants?.[slot]?.email ?? '').toString().trim().toLowerCase();
  if (!email) return 0;
  return (pendingProducts ?? []).reduce(
    (s: number, pp: any) =>
      (pp?.participantEmail ?? '').toString().trim().toLowerCase() === email
        ? s + (pp?.unitPrice ?? 0) * (pp?.quantity ?? 1)
        : s,
    0,
  );
}

/**
 * Resolve o preço unitário de um produto considerando a variação selecionada.
 *
 * Regra:
 * - Sem variação → basePrice.
 * - Variação "Sem interesse" → 0 (opt-out de produto opcional; convenção do projeto).
 * - Variação com `price > 0` → usa o price da variação (sobrescreve basePrice).
 * - Variação com `price === 0` (e nome ≠ "Sem interesse") → fallback para basePrice.
 *   Cobre o caso de organizer cadastrar variações P/M/G sem preencher price,
 *   esperando que o basePrice prevaleça.
 * (Implementação movida para `common/utils/product-price.util.ts` — fonte única
 *  compartilhada com o finalize do PIX/3DS via OrderFinalizationService.)
 */

export function inferEffectiveUsage(
  reservedTickets: any[],
  coupon: { type: string; value: number; appliesTo?: string | null } | null | undefined,
  totalDiscount: number,
): number | undefined {
  if (!coupon || !totalDiscount || totalDiscount <= 0) return undefined;

  let applicable = reservedTickets;
  if (coupon.appliesTo && coupon.appliesTo !== 'all') {
    const allowed = parseAppliesToArray(coupon.appliesTo);
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

/**
 * Cobertura de um voucher sobre os ingressos do pedido.
 *
 * Regra do produto: **voucher = UM ingresso grátis**. Cobre exatamente uma
 * unidade — a APLICÁVEL mais cara (respeita `voucher.appliesTo`) — nunca todos
 * os ingressos. Com 3 ingressos iguais, zera só um.
 *
 * @param reservedTickets ingressos reservados (`{ ticketId, unitPrice, quantity }`).
 * @param appliesTo `voucher.appliesTo`: `'all'`/`null` (qualquer ingresso) ou ticketIds.
 * @param excludeTicketIds ticketIds já cobertos por um cupom (desconto combinado);
 *   o voucher só cobre ingressos fora desse conjunto.
 * @returns `discount` em centavos da unidade coberta (0 se nenhuma aplicável);
 *   `qualifyingSlot` = índice da unidade coberta na expansão de `distributeDiscount`
 *   (mesma ordem: itera reservedTickets, `quantity` unidades cada) ou -1;
 *   `hasApplicable` = existe ≥1 ingresso elegível.
 */
export function resolveVoucherCoverage(
  reservedTickets: any[],
  appliesTo: string | null | undefined,
  excludeTicketIds?: Set<string>,
  eligibleSlots?: Set<number>,
): { discount: number; qualifyingSlot: number; hasApplicable: boolean } {
  const restricted = !!appliesTo && appliesTo !== 'all';
  const allowed = restricted ? new Set(parseAppliesToArray(appliesTo)) : null;

  let bestPrice = -1;
  let qualifyingSlot = -1;
  let hasApplicable = false;
  let slot = 0; // índice da próxima unidade na expansão por-unidade

  for (const rt of reservedTickets) {
    const qty = rt.quantity ?? 0;
    const ticketAllowed =
      (!allowed || allowed.has(rt.ticketId)) &&
      (!excludeTicketIds || !excludeTicketIds.has(rt.ticketId));
    if (ticketAllowed && qty > 0) {
      // Quando `eligibleSlots` é informado (voucher com lista de documento), só as
      // unidades de participantes elegíveis contam — itera por-unidade pra checar o
      // slot global. Sem o filtro, mantém o comportamento por-ticket original.
      for (let u = 0; u < qty; u++) {
        const unitSlot = slot + u;
        if (eligibleSlots && !eligibleSlots.has(unitSlot)) continue;
        hasApplicable = true;
        if ((rt.unitPrice ?? 0) > bestPrice) {
          bestPrice = rt.unitPrice ?? 0;
          qualifyingSlot = unitSlot;
        }
      }
    }
    slot += qty;
  }

  return {
    discount: hasApplicable ? Math.max(0, bestPrice) : 0,
    qualifyingSlot,
    hasApplicable,
  };
}

// computeDocEligibleSlots / computeVoucherEligibleSlots / computeAgeEligibleSlots /
// computeCouponCoveredUnits foram movidos para `common/utils/coupon-eligibility.util.ts`
// (util neutro reusado pelo OrderFinalizationService sem criar ciclo de módulo). Re-exportados
// no topo deste arquivo para manter os imports/specs existentes.

/**
 * Capa o nº de unidades cobertas por um cupom auto-aplicado (AGE / lista de documento) pelo
 * uso RESTANTE (`maxUsage − usageCount`). Em PENDING o `usageCount` ainda não conta o pedido
 * atual (só incrementa no finalize), logo é o remaining correto. Sem `maxUsage` → sem cap.
 */
export function capUsageByMax(
  count: number,
  coupon: { maxUsage?: number | null; usageCount?: number | null } | null | undefined,
): number {
  if (coupon?.maxUsage == null) return count;
  const remaining = Math.max(0, coupon.maxUsage - (coupon.usageCount ?? 0));
  return Math.min(count, remaining);
}

export function orderShape(order: any, discountOverride?: number, extra?: Record<string, unknown>, effectiveUsage?: number, fixedPerUnit?: number, qualifyingSlots?: number[]): Record<string, any> {
  const coupon = order.coupon ?? null;
  const resolvedFixedPerUnit = fixedPerUnit ?? (coupon?.type === 'FIXED' ? coupon.value : undefined);

  // For AGE coupons without explicit effectiveUsage: re-derive from pendingParticipants.
  // This guarantees correct display regardless of stale order.discount in the DB.
  let resolvedEffectiveUsage = effectiveUsage;
  let resolvedQualifyingSlots = qualifyingSlots;
  // Só PENDING: pedidos pagos mantêm discount/effectiveUsage congelados (recomputar com
  // `maxUsage - usageCount` subtrairia o PRÓPRIO uso já contabilizado no finalize → erraria).
  if (resolvedEffectiveUsage === undefined && coupon?.couponType === 'AGE' && order.status === 'PENDING' && Array.isArray(order.pendingParticipants) && order.pendingParticipants.length > 0) {
    const participants = order.pendingParticipants as any[];
    const min: number = coupon.minAge ?? 0;
    const max: number = coupon.maxAge ?? Infinity;
    const refDate = resolveAgeReferenceDate(order);
    const totalUnits = (order.reservedTickets ?? []).reduce((s: number, rt: any) => s + (rt.quantity ?? 1), 0);
    // Lenient (PENDING): slot ainda sem birthDate mantém o cupom aplicado até preencher.
    const derived = computeAgeEligibleSlots(participants, min, max, refDate, totalUnits, true);
    if (derived.length > 0) {
      // Capa pelo uso RESTANTE do cupom (maxUsage − usageCount). Em PENDING o usageCount
      // ainda não conta este pedido (só incrementa no finalize), então é o remaining correto.
      resolvedEffectiveUsage = capUsageByMax(derived.length, coupon);
      resolvedQualifyingSlots = resolvedQualifyingSlots ?? derived;
    }
  }

  // Cupom DISCOUNT com lista de documento: re-deriva os participantes ELEGÍVEIS (doc na
  // lista) p/ exibir o desconto nos slots certos e recomputar o total — mesma garantia do
  // AGE contra order.discount defasado em PENDING. Requer documentList/cpfList no include.
  // Restrição de documento por-participante vale APENAS para cupom DISCOUNT (manual). QUANTITY
  // é all-or-nothing por quantidade de carrinho e AGE tem seu próprio bloco (por idade) — nenhum
  // dos dois é gateado por CPF, então a checagem só roda quando couponType === 'DISCOUNT'.
  if (
    resolvedEffectiveUsage === undefined &&
    coupon?.couponType === 'DISCOUNT' &&
    coupon?.cpfListStatus === 'ENABLED' &&
    order.status === 'PENDING' &&
    Array.isArray(order.pendingParticipants) &&
    order.pendingParticipants.length > 0
  ) {
    const totalUnits = (order.reservedTickets ?? []).reduce((s: number, rt: any) => s + (rt.quantity ?? 1), 0);
    const derived = computeDocEligibleSlots(order.pendingParticipants as any[], coupon.documentList, coupon.cpfList, totalUnits, true);
    // Com participantes presentes, o cupom cpf é SEMPRE por-participante: effectiveUsage =
    // nº de elegíveis (0 quando NINGUÉM elegível → desconto 0). Não cai no inferEffectiveUsage
    // do order.discount provisório (que poderia mostrar o desconto cheio aplicado sem participantes).
    resolvedEffectiveUsage = capUsageByMax(derived.length, coupon);
    resolvedQualifyingSlots = resolvedQualifyingSlots ?? derived;
  }

  // Voucher = um ingresso grátis (a unidade aplicável mais cara). Sem cupom no
  // pedido, derivamos effectiveUsage=1 e o slot coberto a partir de
  // `voucher.appliesTo` — garante exibição por-ingresso correta em QUALQUER
  // leitura (GET details, patchProducts, etc.), não só na aplicação.
  // No caso combinado (cupom + voucher) o total já está correto em order.discount;
  // a distribuição por-unidade segue a lógica do cupom (aproximada para o voucher).
  // Só PENDING: pedidos pagos mantêm o desconto/finalAmount congelados no pay
  // (recomputar criaria divergência com o valor efetivamente cobrado).
  const voucher = order.voucher ?? null;
  let voucherDerivedDiscount: number | undefined;
  if (resolvedEffectiveUsage === undefined && !coupon && voucher && order.voucherId && order.status === 'PENDING') {
    // Voucher com lista de documento: restringe a cobertura aos slots dos participantes
    // elegíveis (senão recomputaria o total no ingresso mais caro, ignorando a lista).
    let voucherEligibleSlots: Set<number> | undefined;
    if (voucher.cpfListStatus === 'ENABLED') {
      const totalUnits = (order.reservedTickets ?? []).reduce((s: number, rt: any) => s + (rt.quantity ?? 1), 0);
      // Voucher = 1 ingresso: preenchido-elegível tem prioridade; vazio é só fallback
      // provisório (nunca concorre com um participante já validado). Ver computeVoucherEligibleSlots.
      voucherEligibleSlots = new Set(
        computeVoucherEligibleSlots(order.pendingParticipants ?? [], voucher.documentList, voucher.cpfList, totalUnits),
      );
    }
    const cov = resolveVoucherCoverage(order.reservedTickets ?? [], voucher.appliesTo, undefined, voucherEligibleSlots);
    if (cov.hasApplicable && cov.qualifyingSlot >= 0) {
      resolvedEffectiveUsage = 1;
      resolvedQualifyingSlots = resolvedQualifyingSlots ?? [cov.qualifyingSlot];
      // applyToProducts: o ingresso grátis cobre os produtos SÓ do participante do ingresso
      // coberto (slot `qualifyingSlot`), não os de todos — espelha o pay/patchCoupon.
      voucherDerivedDiscount =
        cov.discount +
        (voucher.applyToProducts
          ? computeSlotParticipantProductsSubtotal(
              (order.pendingProducts as any[]) ?? [],
              order.pendingParticipants ?? [],
              cov.qualifyingSlot,
            )
          : 0);
    } else {
      // NENHUMA unidade coberta (lista de documento sem participante elegível, ou
      // appliesTo sem ingresso correspondente no pedido): o voucher NÃO cobre nada —
      // espelha o pay (cpfBlocked → desconto 0). Sem este else, o order.discount
      // defasado caía no fallback do inferEffectiveUsage (undefined → cobre TODAS as
      // unidades) e o front exibia o desconto RATEADO entre todos os ingressos.
      resolvedEffectiveUsage = 0;
      voucherDerivedDiscount = 0;
    }
  }

  // When effectiveUsage was re-derived for an AGE coupon, also recompute the discount
  // to avoid showing a stale DB value (e.g. 4470 when only 1 participant now qualifies).
  let discount: number;
  if (discountOverride !== undefined) {
    discount = discountOverride;
  } else if (resolvedEffectiveUsage !== undefined && effectiveUsage === undefined && (coupon?.couponType === 'AGE' || (coupon?.couponType === 'DISCOUNT' && coupon?.cpfListStatus === 'ENABLED'))) {
    // AGE ou cupom com lista de documento: recomputa o total a partir do nº de
    // participantes elegíveis re-derivado (auto-corrige order.discount defasado em PENDING).
    // applyToProducts: só os produtos dos participantes cujo ingresso o cupom cobre (appliesTo).
    const productsExtra = coupon.applyToProducts
      ? computeApplicableProductsSubtotal(
          (order.pendingProducts as any[]) ?? [],
          buildParticipantTicketMap(order.reservedTickets ?? [], order.pendingParticipants ?? []),
          resolveApplicableTicketIds(coupon.appliesTo, order.reservedTickets ?? []),
        )
      : 0;
    discount = computePartialCouponDiscount(order.reservedTickets ?? [], coupon.type, coupon.value, resolvedEffectiveUsage, productsExtra);
  } else if (voucherDerivedDiscount !== undefined) {
    // Voucher sozinho: recomputa o total (1 ingresso) — auto-corrige order.discount
    // legado de pedidos PENDING aplicados antes da regra "voucher = 1 ingresso".
    discount = voucherDerivedDiscount;
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

  const serviceFee = computeServiceFee(order);
  // Em PENDING, o `order.finalAmount` da DB não soma a taxa de serviço — recompomos aqui.
  // Pós-pagamento, mantemos o valor congelado (representa o cobrado de fato).
  const finalAmount = (order.serviceFee && order.serviceFee > 0)
    ? (order.finalAmount ?? 0)
    : Math.max(0, (order.totalAmount ?? 0) + serviceFee - discount);

  // ── Breakdown rotulado de preço (checkout-coupons-server-spec §3.3) ──────────
  // ADITIVO: não altera discount/serviceFee/finalAmount/totalAmount (valores cobrados).
  // Classifica o `discount` (combinado) por ORIGEM, garantindo que a soma das parcelas
  // == discount. O front lê `pricing` e renderiza as linhas sem recalcular nada.
  const ticketsSubtotalCents = (order.reservedTickets ?? []).reduce(
    (s: number, rt: any) => s + (rt.unitPrice ?? 0) * (rt.quantity ?? 0),
    0,
  );
  const subtotalCents = order.totalAmount ?? 0;
  const productsSubtotalCents = Math.max(0, subtotalCents - ticketsSubtotalCents);

  // Porção do voucher: sem cupom → todo o desconto é do voucher; combinado → cobertura
  // do voucher (ingresso aplicável mais caro + produtos quando applyToProducts). O restante
  // vai pro balde do cupom. Cupom e voucher devem ser mutuamente exclusivos (spec); no caso
  // combinado legado a divisão é aproximada, mas a SOMA sempre bate com `discount`.
  let voucherDiscountCents = 0;
  if (voucher && order.voucherId) {
    if (!coupon) {
      voucherDiscountCents = discount;
    } else {
      const cov = resolveVoucherCoverage(order.reservedTickets ?? [], voucher.appliesTo);
      const voucherPortion = cov.hasApplicable
        ? cov.discount +
          (voucher.applyToProducts
            ? computeSlotParticipantProductsSubtotal(
                (order.pendingProducts as any[]) ?? [],
                order.pendingParticipants ?? [],
                cov.qualifyingSlot,
              )
            : 0)
        : 0;
      voucherDiscountCents = Math.min(discount, Math.max(0, voucherPortion));
    }
  }
  // Cupom é cupom: o desconto de QUALQUER tipo (DISCOUNT/AGE/QUANTITY) entra em
  // `couponDiscount`. O tipo específico fica em `coupon.couponType` (objeto `coupon`),
  // se o front quiser rotular. Voucher é entidade à parte → `voucherDiscount`.
  const couponDiscountCents = coupon ? Math.max(0, discount - voucherDiscountCents) : 0;

  const pricing = {
    ticketsSubtotal: ticketsSubtotalCents,
    productsSubtotal: productsSubtotalCents,
    subtotal: subtotalCents,
    couponDiscount: couponDiscountCents,
    voucherDiscount: voucherDiscountCents,
    serviceFee,
    total: finalAmount,
    currency: 'BRL',
  };

  return {
    id: order.id,
    eventId: order.eventId,
    status: order.status,
    totalAmount: order.totalAmount,
    serviceFee,
    discount,
    finalAmount,
    pricing,
    // Default; `...extra` (patchProducts) sobrescreve com true quando um auto-cupom cai.
    couponAutoRemoved: false,
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
    private readonly orderFinalization: OrderFinalizationService,
    private readonly activity: UserActivityService,
  ) {}

  private async isAdminUser(userId: string): Promise<boolean> {
    const user = await this.prisma.getReadClient().user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user?.role === 'PODIOGO_STAFF' || user?.role === 'ADMIN';
  }

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

    // 1.5 Validate event. `eventDate` é a referência de idade do cupom AGE (idade na data do
    // evento). O auto-cupom AGE no reserve (passo 1.7b) aplica PROVISORIAMENTE em TODOS os
    // ingressos reservados (slots ainda vazios) — a validação por participante acontece no
    // PATCH /participants conforme o comprador preenche.
    const event = await r.event.findUnique({
      where: { id: dto.eventId },
      select: {
        id: true,
        name: true,
        status: true,
        registrationStartDate: true,
        registrationEndDate: true,
        eventDate: true,
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
    // Lê do PRIMARY (write client): a réplica defasada poderia trazer uma versão antiga do
    // pedido (qtde errada → replace indevido) ou não enxergar um pedido recém-criado (duplicata).
    const existingPending = await w.order.findFirst({
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

    // 1.7b Auto-cupom AGE no reserve — aplica PROVISORIAMENTE em TODOS os ingressos reservados.
    // Como ainda não há participantes, tratamos cada unidade como um slot VAZIO (sem birthDate):
    // o modo lenient do `computeAgeEligibleSlots` conta slot vazio como elegível, então o AGE
    // cai nos N ingressos (capado por maxUsage). Conforme o comprador preenche os participantes,
    // o PATCH /participants revalida cada slot (preenchido → valida idade; vazio → mantém).
    const reserveTotalAmount = batchInfos.reduce(
      (sum, info) => sum + info.unitPrice * info.quantity,
      0,
    );
    const reservedTicketsLite = batchInfos.map((info) => ({
      ticketId: info.ticketId,
      quantity: info.quantity,
      unitPrice: info.unitPrice,
    }));
    const totalReservedUnits = batchInfos.reduce((sum, info) => sum + info.quantity, 0);
    // Slots provisórios = uma "vaga vazia" por unidade reservada.
    const provisionalParticipants = Array.from({ length: totalReservedUnits }, () => ({}));
    const {
      autoCouponId: ageCouponId,
      autoEffectiveUsage: ageEffectiveUsage,
      ageQualifyingSlots,
      newDiscount: ageDiscount,
    } = await this.evaluateAutoCoupons(
      {
        eventId: dto.eventId,
        couponId: null,
        voucherId: null,
        discount: 0,
        coupon: null,
        voucher: null,
        event: { eventDate: event.eventDate },
      },
      provisionalParticipants,
      reservedTicketsLite,
      reserveTotalAmount,
      0,
      { autoApplyCouponTypes: ['AGE'] },
    );

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
          // Cupom AGE auto-aplicado na reserva (passo 1.7b). Sem elegibilidade,
          // ageDiscount=0 e ageCouponId=undefined — comportamento original preservado.
          discount: ageDiscount,
          finalAmount: Math.max(0, totalAmount - ageDiscount),
          ...(ageCouponId && { couponId: ageCouponId }),
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

    this.logger.log(
      `Reserved order ${order.id} for user ${userId}, event ${dto.eventId}` +
        (ageCouponId ? ` (auto AGE coupon ${ageCouponId}, discount ${ageDiscount})` : ''),
    );
    // Quando o cupom AGE foi aplicado, passamos discount/effectiveUsage/slots explícitos
    // para o orderShape distribuir o desconto no slot do comprador (não há
    // pendingParticipants na reserva para re-derivar). Sem cupom, todos undefined → leitura padrão.
    return orderShape(
      order,
      ageCouponId ? ageDiscount : undefined,
      undefined,
      ageCouponId ? ageEffectiveUsage : undefined,
      undefined,
      ageCouponId ? ageQualifyingSlots : undefined,
    );
  }

  // ── 2. findOrder ───────────────────────────────────────────────────────────

  async findOrder(userId: string, orderId: string): Promise<Record<string, any>> {
    const r: any = this.prisma.getReadClient();
    const order = await r.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (order.userId !== userId && !await this.isAdminUser(userId)) {
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
              participantFeePercent: true,
              organization: {
                // Contato (email/phone) fora do contrato de rota de usuário.
                select: { id: true, name: true, logoUrl: true },
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
                  documentType: true,
                  documentNumber: true,
                  documentNumberClean: true,
                  country: true,
                  state: true,
                  city: true,
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
                            include: { variations: { orderBy: { sortOrder: 'asc' } } },
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
                  product: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                      basePrice: true,
                      variationType: true,
                      isIncludedInTicket: true,
                      buyerVariationEditAllowed: true,
                      variationEditDeadlineDays: true,
                      // Opções vivas pra montar o seletor de variação no recibo (ordenadas).
                      variations: { select: { id: true, name: true, price: true, stock: true, sortOrder: true }, orderBy: { sortOrder: 'asc' } },
                    },
                  },
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

    // Primeira registration com receiptSnapshot — quando existe, vira a fonte
    // de verdade pra event/coupon/voucher/billing. Pedidos PENDING (sem pay)
    // não têm snapshot e caem no caminho live.
    const primaryReceipt = ((order.registrations as any[]).find((reg: any) => reg.receiptSnapshot)?.receiptSnapshot ?? null) as any | null;
    const snapBilling = primaryReceipt?.billing ?? null;

    // Billing address: snapshot > order.* > payment metadata
    const billingAddress = snapBilling
      ? {
          country: snapBilling.country ?? null,
          postalCode: snapBilling.postalCode ?? null,
          stateUf: snapBilling.state ?? null,
          street: snapBilling.street ?? null,
          number: snapBilling.number ?? null,
          complement: snapBilling.complement ?? null,
          neighborhood: snapBilling.neighborhood ?? null,
          city: snapBilling.city ?? null,
        }
      : order.billingPostalCode
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

    // Preço do INGRESSO por (ticketId,batchId) — base do `ticket.unitPrice` por registration
    // (fallback quando o snapshot não tem batch.price). Garante o invariante
    // Σ(registrations[].ticket.unitPrice) == pricing.ticketsSubtotal.
    const reservedPriceByKey = new Map<string, number>();
    const reservedPriceByTicket = new Map<string, number>();
    for (const rt of ((order.reservedTickets as any[]) ?? [])) {
      reservedPriceByKey.set(`${rt.ticketId}:${rt.batchId}`, rt.unitPrice ?? 0);
      if (!reservedPriceByTicket.has(rt.ticketId)) reservedPriceByTicket.set(rt.ticketId, rt.unitPrice ?? 0);
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
          pricing: (() => {
            const serviceFee = computeServiceFee(order);
            // ticketsSubtotal vem dos reservedTickets; productsSubtotal é derivado
            // de (totalAmount − ticketsSubtotal) — invariante garantido pelo checkout
            // (vale tanto em PENDING quanto após o pagamento).
            const ticketsSubtotal = ((order.reservedTickets as any[]) ?? []).reduce(
              (s: number, rt: any) => s + (rt.unitPrice ?? 0) * (rt.quantity ?? 0),
              0,
            );
            const productsSubtotal = Math.max(0, (order.totalAmount ?? 0) - ticketsSubtotal);
            const discount = order.discount ?? 0;
            // Split do desconto por origem (checkout-coupons-server-spec §2): cupom e voucher
            // são mutuamente exclusivos no caso comum. Voucher só conta quando NÃO há cupom;
            // o restante vai pro cupom → couponDiscount + voucherDiscount == discount sempre.
            const hasCoupon = !!(primaryReceipt?.pricing?.coupon ?? order.coupon);
            const hasVoucher = !!(primaryReceipt?.pricing?.voucher ?? order.voucher);
            const voucherDiscount = hasVoucher && !hasCoupon ? discount : 0;
            const couponDiscount = discount - voucherDiscount;
            return {
              ticketsSubtotal,
              productsSubtotal,
              subtotal: order.totalAmount,
              couponDiscount,
              voucherDiscount,
              discount,
              serviceFee,
              total: computeFinalAmount(order, serviceFee),
              currency: 'BRL',
            };
          })(),
          billingAddress,
          coupon: primaryReceipt?.pricing?.coupon
            ? {
                id: primaryReceipt.pricing.coupon.id,
                code: primaryReceipt.pricing.coupon.code,
                type: primaryReceipt.pricing.coupon.type,
                value: primaryReceipt.pricing.coupon.value,
                // Prioridade da verdade histórica: snapshot do recibo →
                // metadata do pagamento (congelado no pay, cobre PIX que não tem
                // receiptSnapshot) → flag atual do cupom (fallback p/ recibos
                // legados pré-feature). `??` preserva `false` legítimo.
                applyToProducts:
                  primaryReceipt.pricing.coupon.applyToProducts
                  ?? metadata.coupon?.applyToProducts
                  ?? order.coupon?.applyToProducts
                  ?? false,
              }
            : order.coupon
              ? {
                  id: order.coupon.id,
                  code: order.coupon.code,
                  type: order.coupon.type,
                  value: order.coupon.value,
                  applyToProducts:
                    metadata.coupon?.applyToProducts
                    ?? order.coupon.applyToProducts
                    ?? false,
                }
              : null,
          voucher: primaryReceipt?.pricing?.voucher
            ? {
                id: primaryReceipt.pricing.voucher.id,
                code: primaryReceipt.pricing.voucher.code,
                name: primaryReceipt.pricing.voucher.name,
                // Recibo grava apenas vouchers usados — status implícito é USED.
                status: 'USED',
                // Verdade histórica: snapshot → metadata do pagamento (cobre PIX
                // sem receiptSnapshot) → flag live. `??` preserva `false`.
                applyToProducts:
                  primaryReceipt.pricing.voucher.applyToProducts
                  ?? metadata.voucher?.applyToProducts
                  ?? order.voucher?.applyToProducts
                  ?? false,
              }
            : order.voucher
              ? {
                  id: order.voucher.id,
                  code: order.voucher.code,
                  name: order.voucher.name,
                  status: order.voucher.status,
                  applyToProducts:
                    metadata.voucher?.applyToProducts
                    ?? order.voucher.applyToProducts
                    ?? false,
                }
              : null,
        },
        event: primaryReceipt?.event
          ? {
              id: primaryReceipt.event.id,
              name: primaryReceipt.event.name,
              slug: primaryReceipt.event.slug,
              description: primaryReceipt.event.description ?? null,
              eventDate: primaryReceipt.event.eventDate,
              registrationStartDate: primaryReceipt.event.registrationStartDate ?? null,
              registrationEndDate: primaryReceipt.event.registrationEndDate ?? null,
              bannerUrl: primaryReceipt.event.bannerUrl ?? null,
              logoUrl: primaryReceipt.event.logoUrl ?? null,
              location: primaryReceipt.event.location?.name ?? null,
              city: primaryReceipt.event.location?.city ?? null,
              state: primaryReceipt.event.location?.state ?? null,
              country: primaryReceipt.event.location?.country ?? null,
              zipCode: primaryReceipt.event.location?.zipCode ?? null,
              neighborhood: primaryReceipt.event.location?.neighborhood ?? null,
              googleMapsLink: primaryReceipt.event.location?.googleMapsLink ?? null,
              // Snapshots antigos congelaram email/phone da org — strip no read.
              organization: stripOrganizationContact(primaryReceipt.event.organization),
            }
          : order.event
            ? (({ participantFeePercent: _fee, ...rest }) => rest)(order.event as any)
            : null,
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
                payment.method === 'PIX'
                  ? {
                      qrCode: metadata.pix?.qrCode ?? metadata.qrCode ?? null,
                      qrCodeBase64: metadata.pix?.qrCode ?? metadata.qrCode ?? null,
                      pixCode: metadata.pix?.pixCode ?? metadata.pixCode ?? null,
                      expiresAt: metadata.pix?.expiresAt ?? metadata.expiresAt ?? null,
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
                // Snapshot é fonte de verdade pros dados do recibo (nome,
                // doc, contato). Pra nacionalidade/avatar — que não eram
                // snapshotados originalmente — caímos pro live user quando
                // disponível. Não é "violação" do snapshot: country/state/
                // city/avatar mudam raramente e não são parte do recibo
                // fiscal — recompor live mantém a UI atualizada e cobre
                // pedidos antigos sem backfill.
                id: reg.userId,
                fullName: snapP.name ?? null,
                firstName: snapP.name?.split(' ')[0] ?? null,
                lastName: snapP.name?.split(' ').slice(1).join(' ') ?? null,
                email: snapP.email ?? null,
                documentType: snapP.documentType ?? reg.user?.documentType ?? null,
                documentNumber: snapP.documentNumber ?? snapP.cpf ?? reg.user?.documentNumber ?? null,
                phone: snapP.phone ?? reg.user?.phone ?? null,
                dateOfBirth: snapP.birthDate ?? reg.user?.dateOfBirth ?? null,
                gender: snapP.gender ?? reg.user?.gender ?? null,
                country: snapP.country ?? reg.user?.country ?? null,
                state: snapP.state ?? reg.user?.state ?? null,
                city: snapP.city ?? reg.user?.city ?? null,
                avatarUrl: reg.user?.avatarUrl ?? null,
              }
            : reg.user
            ? {
                id: reg.user.id,
                fullName: `${reg.user.firstName} ${reg.user.lastName}`,
                firstName: reg.user.firstName,
                lastName: reg.user.lastName,
                email: reg.user.email,
                documentType: reg.user.documentType ?? null,
                documentNumber: reg.user.documentNumber ?? null,
                phone: reg.user.phone ?? null,
                dateOfBirth: reg.user.dateOfBirth ?? null,
                gender: reg.user.gender ?? null,
                country: reg.user.country ?? null,
                state: reg.user.state ?? null,
                city: reg.user.city ?? null,
                avatarUrl: reg.user.avatarUrl ?? null,
              }
            : {
                // Guest sem User: Registration não snapshota nacionalidade
                // (fora do escopo do snapshot de convidado). Front trata como
                // ausente.
                id: null,
                fullName: reg.participantName ?? null,
                firstName: (reg.participantName ?? '').split(' ')[0] || null,
                lastName: (reg.participantName ?? '').split(' ').slice(1).join(' ') || null,
                email: reg.participantEmail ?? null,
                documentType: reg.participantDocumentType ?? null,
                documentNumber: reg.participantDocumentNumber ?? reg.participantCpf ?? null,
                phone: reg.participantPhone ?? null,
                dateOfBirth: reg.participantDateOfBirth ?? null,
                gender: reg.participantGender ?? null,
                country: null,
                state: null,
                city: null,
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
                // ⭐ Preço SÓ do ingresso (sem produtos), centavos. Snapshot (batch.price congelado
                // no pay) tem prioridade; fallback nos reservedTickets do pedido. É o campo que
                // elimina a diluição do subtotal no front. Invariante: Σ == pricing.ticketsSubtotal.
                unitPrice:
                  ticketSnap?.batch?.price
                  ?? reservedPriceByKey.get(`${regTicket.ticketId}:${regTicket.batchId}`)
                  ?? reservedPriceByTicket.get(regTicket.ticketId)
                  ?? 0,
                distance: ticketSnap?.distance ?? liveTicket?.distance ?? null,
                distanceUnit: ticketSnap?.distanceUnit ?? liveTicket?.distanceUnit ?? null,
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
                      sortOrder: v.sortOrder,
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

          // Products: dados do recibo (productSnapshot tem prioridade) + metadados de edição
          // de variação em TEMPO REAL (mesma regra do ticket.includedProducts) — assim o front
          // mostra o recibo E habilita a troca de variação no mesmo item, sem cruzar listas.
          const products = (reg.products ?? []).map((rp: any) => {
            const pSnap = (rp.productSnapshot ?? null) as any;
            const liveP = rp.product as any;
            const variationEdited = rp.variationEdited ?? false;

            // Variação exibida: quando o comprador EDITOU a variação após a compra, o snapshot
            // (congelado no pay e NÃO reescrito pela edição) ficaria defasado → usamos a variação
            // ATUAL do RegistrationProduct (fallback p/ variação órfã quando o organizador recriou
            // as opções). Sem edição, mantém o snapshot (verdade do recibo). Espelha a mesma regra
            // de ticket.includedProducts pra não divergir.
            const orphanVar = rp.variationId ? orphanVariationMap.get(rp.variationId) ?? null : null;
            const liveVar = rp.variation
              ? { id: rp.variation.id, name: rp.variation.name, price: rp.variation.price }
              : (orphanVar ? { id: orphanVar.id, name: orphanVar.name, price: orphanVar.price } : null);
            const selectedVar = variationEdited
              ? liveVar
              : (pSnap?.selectedVariation ?? liveVar);

            // Janela de edição = config VIVA do produto (snapshot não serve: flags/prazo
            // podem ter mudado e as opções de variação precisam ser as atuais). Espelha
            // exatamente o cálculo de ticket.includedProducts pra não divergir do que o
            // PATCH de variação aceita.
            const deadlineDays = liveP?.variationEditDeadlineDays ?? 0;
            const deadlineMs = deadlineDays * 24 * 60 * 60 * 1000;
            const variationEditDeadline = deadlineDays > 0
              ? new Date(eventDate.getTime() - deadlineMs)
              : null;
            const editWindowOpen = variationEditDeadline ? now < variationEditDeadline : false;
            const canEditVariation =
              (liveP?.buyerVariationEditAllowed ?? false) &&
              !variationEdited &&
              editWindowOpen &&
              liveP?.isIncludedInTicket === true;

            return {
              id: rp.id,
              product: {
                id: rp.productId ?? pSnap?.id ?? liveP?.id,
                name: pSnap?.name ?? liveP?.name ?? null,
                image: pSnap
                  ? (pSnap.images?.[pSnap.primaryImageIndex ?? 0] ?? pSnap.image ?? null)
                  : (liveP?.image ?? null),
                basePrice: pSnap?.basePrice ?? liveP?.basePrice ?? rp.unitPrice,
                variationType: pSnap?.variationType ?? liveP?.variationType ?? null,
                isIncludedInTicket: liveP?.isIncludedInTicket ?? false,
              },
              variation: selectedVar,
              variationName: selectedVar?.name ?? null,
              quantity: rp.quantity,
              unitPrice: rp.unitPrice,
              totalPrice: rp.totalPrice,
              // ── Edição de variação ──
              buyerVariationEditAllowed: liveP?.buyerVariationEditAllowed ?? false,
              variationEditDeadline,
              variationEdited,
              canEditVariation,
              // Opções vivas pro seletor (vazio quando o produto não tem variações), ordenadas.
              variations: (liveP?.variations ?? []).map((v: any) => ({
                id: v.id,
                name: v.name,
                price: v.price,
                stock: v.stock,
                sortOrder: v.sortOrder,
              })),
            };
          })
          // "Sem interesse" = opt-out de produto opcional → NÃO exibir nem somar (spec §6.1).
          .filter((p: any) => p.variationName !== 'Sem interesse');

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

  /**
   * Avalia e (re)aplica cupons AUTOMÁTICOS (AGE/QUANTITY) a partir dos participantes e
   * ingressos ATUAIS — FONTE ÚNICA usada por `PATCH /participants` e `PATCH /products`.
   * NÃO persiste nada: devolve os valores que o caller grava no `order.update` + os que o
   * `orderShape` precisa pra exibir o desconto por unidade.
   *
   * Regras (espelham a aplicação no `pay`):
   *  (a) cupom AGE já aplicado → re-avalia contra os participantes (remove se nenhum qualifica);
   *  (b) sem cupom/voucher → tenta aplicar o 1º auto-cupom (QUANTITY/AGE) elegível;
   *  (c) cupom QUANTITY aplicado → remove se a quantidade caiu abaixo do mínimo.
   * Cupom MANUAL (DISCOUNT PERCENTAGE) e voucher isolado são RECALCULADOS sobre a nova base
   * (sem trocar de cupom), mantendo o total coerente quando carrinho/participantes mudam.
   */
  private async evaluateAutoCoupons(
    order: any,
    participants: any[],
    reservedTickets: any[],
    ticketsSubtotal: number,
    productsSubtotal: number,
    opts: { autoApplyCouponTypes?: ('QUANTITY' | 'AGE')[]; pendingProducts?: any[] } = {},
  ): Promise<{
    autoCouponId?: string;
    autoEffectiveUsage?: number;
    shouldRemoveAgeCoupon: boolean;
    shouldRemoveQuantityCoupon: boolean;
    ageQualifyingSlots?: number[];
    newDiscount: number;
  }> {
    const r: any = this.prisma.getReadClient();
    const w: any = this.prisma.getWriteClient();
    const totalAmount = ticketsSubtotal + productsSubtotal;

    // Lista AUTORITATIVA de produtos (com participantEmail) p/ escopar applyToProducts por
    // ingresso. Em patchProducts é a lista NOVA (enrichedProducts), não o order.pendingProducts
    // ainda-stale; por isso vem via opts. Mapa email→ingresso = mesma convenção posicional.
    const pendingProductsList = opts.pendingProducts ?? [];
    const participantTicketMap = buildParticipantTicketMap(reservedTickets, participants);
    // Produtos cobertos por um cupom que aplica aos ingressos `appliesTo` (escopo por ingresso).
    const scopedCouponProducts = (appliesTo: string | null | undefined): number =>
      computeApplicableProductsSubtotal(
        pendingProductsList,
        participantTicketMap,
        resolveApplicableTicketIds(appliesTo, reservedTickets),
      );

    let autoCouponId: string | undefined;
    let autoDiscount = 0;
    let autoEffectiveUsage: number | undefined;
    let shouldRemoveAgeCoupon = false;
    let shouldRemoveQuantityCoupon = false;
    let ageQualifyingSlots: number[] | undefined;

    // (a) Re-avaliar cupom AGE já aplicado (depende dos participantes atuais)
    if (order.couponId && !order.voucherId) {
      const existingCoupon = await r.coupon.findUnique({
        where: { id: order.couponId },
        select: { id: true, couponType: true, type: true, value: true, minAge: true, maxAge: true, maxUsage: true, usageCount: true, appliesTo: true, applyToProducts: true },
      });
      if (existingCoupon?.couponType === 'AGE') {
        const refDate = resolveAgeReferenceDate(order);
        const min = existingCoupon.minAge ?? 0;
        const max = existingCoupon.maxAge ?? Infinity;
        const totalUnits = reservedTickets.reduce((s: number, rt: any) => s + rt.quantity, 0);
        // Lenient (PENDING): slot ainda sem birthDate MANTÉM o cupom aplicado até o comprador
        // preencher; participante preenchido é validado pela idade. Só remove o cupom quando há
        // participantes preenchidos e NENHUM (preenchido ou vazio) qualifica.
        const ageSlots = computeAgeEligibleSlots(participants, min, max, refDate, totalUnits, true);
        const ageMatchCount = ageSlots.length;

        if (ageMatchCount <= 0) {
          shouldRemoveAgeCoupon = true;
        } else {
          let ageApplicableTickets = reservedTickets;
          if (existingCoupon.appliesTo && existingCoupon.appliesTo !== 'all') {
            const allowed = parseAppliesToArray(existingCoupon.appliesTo);
            ageApplicableTickets = reservedTickets.filter((rt: any) => allowed.includes(rt.ticketId));
          }
          const ageApplicableQty = ageApplicableTickets.reduce((s: number, rt: any) => s + rt.quantity, 0);
          const remaining = existingCoupon.maxUsage != null
            ? Math.max(0, existingCoupon.maxUsage - existingCoupon.usageCount)
            : ageMatchCount;
          const effectiveUsage = Math.min(remaining, ageMatchCount, ageApplicableQty);
          ageQualifyingSlots = ageSlots;
          autoCouponId = existingCoupon.id;
          const productsExtra = existingCoupon.applyToProducts ? scopedCouponProducts(existingCoupon.appliesTo) : 0;
          autoDiscount = computePartialCouponDiscount(ageApplicableTickets, existingCoupon.type, existingCoupon.value, effectiveUsage, productsExtra);
          autoEffectiveUsage = effectiveUsage;
        }
      }
    }

    // (b) Aplicação inicial — apenas se ainda não há cupom/voucher.
    // `autoApplyCouponTypes` restringe quais tipos podem ser auto-aplicados nesta
    // etapa. O `reserve` passa apenas ['AGE'] (idade do comprador como proxy); os
    // PATCH /participants e /products usam o default (QUANTITY + AGE), pois já têm
    // participantes/produtos reais para avaliar QUANTITY com segurança.
    const autoApplyCouponTypes = opts.autoApplyCouponTypes ?? ['QUANTITY', 'AGE'];
    if (!order.couponId && !order.voucherId) {
      const totalQuantity = reservedTickets.reduce((sum: number, rt: any) => sum + rt.quantity, 0);
      const ticketIds = reservedTickets.map((rt: any) => rt.ticketId);

      const autoCoupons = await w.coupon.findMany({
        where: {
          eventId: order.eventId,
          status: 'ACTIVE',
          deletedAt: null,
          couponType: { in: autoApplyCouponTypes },
          OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
        },
      });

      for (const coupon of autoCoupons) {
        // Verificar appliesTo
        if (coupon.appliesTo && coupon.appliesTo !== 'all') {
          const allowed = parseAppliesToArray(coupon.appliesTo);
          if (!ticketIds.some((id: string) => allowed.includes(id))) continue;
        }

        if (coupon.minCartValue && ticketsSubtotal < coupon.minCartValue) continue;

        if (coupon.couponType === 'QUANTITY') {
          if (coupon.minQuantity && totalQuantity < coupon.minQuantity) continue;
          // QUANTITY: all-or-nothing — se esgotado, não aplica
          if (coupon.maxUsage != null && coupon.usageCount >= coupon.maxUsage) continue;
        } else if (coupon.couponType === 'AGE') {
          const refDate = resolveAgeReferenceDate(order);
          const min = coupon.minAge ?? 0;
          const max = coupon.maxAge ?? Infinity;
          const totalUnits = reservedTickets.reduce((s: number, rt: any) => s + rt.quantity, 0);
          // Lenient (PENDING): slot vazio (sem birthDate) conta como elegível até preencher.
          const ageSlots = computeAgeEligibleSlots(participants, min, max, refDate, totalUnits, true);
          if (ageSlots.length <= 0) continue;
          (coupon as any)._ageSlots = ageSlots;
        }

        {
          let autoApplicableTickets = reservedTickets;
          if (coupon.appliesTo && coupon.appliesTo !== 'all') {
            const allowedIds = parseAppliesToArray(coupon.appliesTo);
            autoApplicableTickets = reservedTickets.filter((rt: any) => allowedIds.includes(rt.ticketId));
          }

          if (coupon.couponType === 'QUANTITY') {
            // QUANTITY: desconto sobre todo o pedido (all-or-nothing).
            // Produtos adicionais entram na base apenas quando applyToProducts=true.
            const autoApplicableSubtotal = autoApplicableTickets.reduce((sum: number, rt: any) => sum + rt.unitPrice * rt.quantity, 0);
            const autoApplicableQty = autoApplicableTickets.reduce((sum: number, rt: any) => sum + rt.quantity, 0);
            const productsContribution = coupon.applyToProducts ? productsSubtotal : 0;
            if (coupon.type === 'PERCENTAGE') {
              const applicableRatio = ticketsSubtotal > 0 ? autoApplicableSubtotal / ticketsSubtotal : 1;
              const applicableBase = autoApplicableSubtotal + Math.round(productsContribution * applicableRatio);
              autoDiscount = Math.floor(applicableBase * (coupon.value / 100));
            } else {
              // FIXED: valor por unidade aplicável; cap definido abaixo.
              autoDiscount = autoApplicableQty * coupon.value;
            }
            autoDiscount = Math.min(autoDiscount, autoApplicableSubtotal + productsContribution);
          } else {
            // AGE: desconto apenas nos ingressos dos participantes qualificados (slots do stash).
            const ageSlots: number[] = (coupon as any)._ageSlots ?? [];
            const ageMatchCount = ageSlots.length;
            const autoApplicableQty = autoApplicableTickets.reduce((sum: number, rt: any) => sum + rt.quantity, 0);
            const remaining = coupon.maxUsage != null
              ? Math.max(0, coupon.maxUsage - coupon.usageCount)
              : ageMatchCount;
            const effectiveUsage = Math.min(remaining, ageMatchCount, autoApplicableQty);
            if (effectiveUsage <= 0) continue;
            const productsExtra = coupon.applyToProducts ? scopedCouponProducts(coupon.appliesTo) : 0;
            autoDiscount = computePartialCouponDiscount(autoApplicableTickets, coupon.type, coupon.value, effectiveUsage, productsExtra);
            autoEffectiveUsage = effectiveUsage;
            ageQualifyingSlots = ageSlots;
          }

          autoCouponId = coupon.id;
          break;
        }
      }
    }

    // (c) Remover cupom QUANTITY se quantidade ficou abaixo do mínimo
    if (order.couponId && !autoCouponId && !shouldRemoveAgeCoupon) {
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

    // Discount final — prioridade: auto-aplicado > remoção > recálculo do cupom/voucher
    // existente > valor persistido. Os recálculos abaixo precisam respeitar a LISTA DE
    // DOCUMENTO por-participante (cpfListStatus) — sem isso, editar participantes para CPFs
    // fora da lista mantinha/recriava o desconto no banco e no display, divergindo do pay
    // (que bloqueia). Mesma família do bug do voucher rateado de 2026-06-04.
    let newDiscount: number;
    if (autoCouponId) {
      newDiscount = autoDiscount;
    } else if (shouldRemoveQuantityCoupon || shouldRemoveAgeCoupon) {
      newDiscount = 0;
    } else {
      newDiscount = (order as any).discount ?? 0;
      const activeCoupon = (order as any).coupon;
      if (
        activeCoupon &&
        activeCoupon.couponType === 'DISCOUNT' &&
        activeCoupon.cpfListStatus === 'ENABLED' &&
        !(order as any).voucherId
      ) {
        // Cupom DISCOUNT com lista de documento: re-deriva os participantes ELEGÍVEIS
        // (lenient: slot vazio mantém provisório) e recalcula POR SLOT — PERCENTAGE e
        // FIXED. Espelha patchCoupon/pay; nenhum elegível → desconto 0 (pay bloquearia).
        const totalUnits = reservedTickets.reduce((s: number, rt: any) => s + (rt.quantity ?? 0), 0);
        const eligibleSlots = computeDocEligibleSlots(
          participants, activeCoupon.documentList, activeCoupon.cpfList, totalUnits, true,
        );
        let applicableTickets = reservedTickets;
        if (activeCoupon.appliesTo && activeCoupon.appliesTo !== 'all') {
          const allowed = parseAppliesToArray(activeCoupon.appliesTo);
          applicableTickets = reservedTickets.filter((rt: any) => allowed.includes(rt.ticketId));
        }
        const applicableQty = applicableTickets.reduce((s: number, rt: any) => s + (rt.quantity ?? 0), 0);
        const usage = Math.min(capUsageByMax(eligibleSlots.length, activeCoupon), applicableQty);
        if (usage <= 0) {
          newDiscount = 0;
        } else {
          const productsExtra = activeCoupon.applyToProducts ? scopedCouponProducts(activeCoupon.appliesTo) : 0;
          newDiscount = computePartialCouponDiscount(applicableTickets, activeCoupon.type, activeCoupon.value, usage, productsExtra);
        }
      } else if (
        activeCoupon &&
        activeCoupon.type === 'PERCENTAGE' &&
        activeCoupon.couponType !== 'AGE' &&
        !(order as any).voucherId
      ) {
        let applicableTickets = reservedTickets;
        if (activeCoupon.appliesTo && activeCoupon.appliesTo !== 'all') {
          const allowed = parseAppliesToArray(activeCoupon.appliesTo);
          applicableTickets = reservedTickets.filter((rt: any) => allowed.includes(rt.ticketId));
        }
        const applicableSubtotal = applicableTickets.reduce(
          (s: number, rt: any) => s + rt.unitPrice * rt.quantity,
          0,
        );
        // applyToProducts escopado: só os produtos dos participantes com ingresso no appliesTo.
        const productsContribution = activeCoupon.applyToProducts ? scopedCouponProducts(activeCoupon.appliesTo) : 0;
        const applicableRatio = ticketsSubtotal > 0 ? applicableSubtotal / ticketsSubtotal : 1;
        const applicableBase = applicableSubtotal + Math.round(productsContribution * applicableRatio);
        newDiscount = Math.floor(applicableBase * (activeCoupon.value / 100));
        newDiscount = Math.min(newDiscount, applicableBase);
      } else if ((order as any).voucherId && !(order as any).couponId && (order as any).voucher) {
        const v = (order as any).voucher;
        // Voucher com lista de documento: a cobertura fica restrita aos slots dos
        // participantes elegíveis — antes ignorava a lista e mantinha o ingresso mais
        // caro grátis no banco/display mesmo sem nenhum elegível (pay bloquearia).
        let voucherEligibleSlots: Set<number> | undefined;
        if (v.cpfListStatus === 'ENABLED') {
          const totalUnits = reservedTickets.reduce((s: number, rt: any) => s + (rt.quantity ?? 0), 0);
          voucherEligibleSlots = new Set(
            computeVoucherEligibleSlots(participants, v.documentList, v.cpfList, totalUnits),
          );
        }
        const cov = resolveVoucherCoverage(reservedTickets, v.appliesTo, undefined, voucherEligibleSlots);
        if (!cov.hasApplicable) {
          newDiscount = 0; // nenhum slot coberto — espelha o pay (cpfBlocked) e o orderShape
        } else {
          // Voucher cobre os produtos SÓ do participante do ingresso coberto (slot).
          const vProductsExtra = v.applyToProducts
            ? computeSlotParticipantProductsSubtotal(pendingProductsList, participants, cov.qualifyingSlot)
            : 0;
          newDiscount = Math.min(cov.discount + vProductsExtra, totalAmount);
        }
      }
    }

    return {
      autoCouponId,
      autoEffectiveUsage,
      shouldRemoveAgeCoupon,
      shouldRemoveQuantityCoupon,
      ageQualifyingSlots,
      newDiscount,
    };
  }

  async patchParticipants(
    userId: string,
    orderId: string,
    dto: PatchParticipantsDto,
  ): Promise<Record<string, any>> {
    const order = await this.findOrderForWrite(userId, orderId);
    this.assertPending(order);

    const w: any = this.prisma.getWriteClient();

    // Normaliza documento de cada participante ANTES de persistir no JSONB
    // `pendingParticipants`. Garante que a versão visual ("123.456.789-00")
    // nunca chega ao banco — só letras/números. Mesma regra aplicada no
    // User (register/patch) pra evitar drift entre fontes.
    //
    // `resolveDocument` lida com os 3 formatos legados: `documentType`+
    // `documentNumber`, `cpf` puro, ou apenas `documentNumber`. Quando há
    // documento, sobrescreve as 3 chaves do payload em paralelo:
    //   - documentNumber  → limpo (era cru)
    //   - documentType    → inferido se não veio
    //   - cpf (alias)     → mesmo valor quando type=CPF; null caso contrário
    // Participantes sem documento (slot vazio pré-checkout) passam intactos.
    const participants = (dto.participants as any[]).map((p) => {
      const doc = resolveDocument(p);
      if (!doc.clean) return p;
      return {
        ...p,
        documentType: doc.type,
        documentNumber: doc.clean,
        cpf: doc.type === DocumentType.CPF ? doc.clean : null,
      };
    });

    // Cupons automáticos (QUANTITY/AGE) SÃO reavaliados aqui também (fonte única
    // evaluateAutoCoupons, mesma do PATCH /products) — atribuir/editar participante
    // reflete na hora no desconto. O subtotal de produtos vem de pendingProducts
    // (já gravado pelo /products anterior) p/ cupons com applyToProducts=true.

    // ── Reserva FIXA: a quantidade reservada NÃO muda no /participants ──────────────
    // O que foi reservado no `reserve` permanece intacto (OrderReservedTicket / estoque /
    // registrations placeholder). Aqui só PREENCHEMOS os participantes nos slots existentes.
    // Slots não enviados ficam VAZIOS ({}) — completamos `pendingParticipants` até o total
    // reservado para que o cupom/AGE continue aplicado neles (modo lenient) até o comprador
    // preencher. Mais participantes que ingressos → erro. Reduzir a quantidade = nova reserva.
    const reservedTickets = (order.reservedTickets ?? []) as any[];
    const totalReserved = reservedTickets.reduce((sum: number, rt: any) => sum + (rt.quantity ?? 0), 0);

    if (participants.length > totalReserved) {
      throw new AppUnprocessableException(
        'PARTICIPANTS_EXCEED_TICKETS',
        `Número de participantes (${participants.length}) excede os ingressos reservados (${totalReserved}).`,
      );
    }

    // Completa com slots VAZIOS até o total reservado (mantém os N slots; vazios = provisórios).
    const filledParticipants = [...participants];
    while (filledParticipants.length < totalReserved) filledParticipants.push({});

    const ticketsSubtotalNew = reservedTickets.reduce(
      (sum: number, rt: any) => sum + (rt.unitPrice ?? 0) * (rt.quantity ?? 0),
      0,
    );
    const productsSubtotal = ((order.pendingProducts as any[] | null) ?? []).reduce(
      (sum: number, p: any) => sum + (p.unitPrice ?? 0) * (p.quantity ?? 1),
      0,
    );
    const newTotalAmount = ticketsSubtotalNew + productsSubtotal;

    // Reavalia auto-cupom (AGE/QUANTITY) com os participantes (incl. slots vazios) sobre a
    // reserva FIXA. Fonte única compartilhada com PATCH /products.
    const {
      autoCouponId,
      autoEffectiveUsage,
      shouldRemoveAgeCoupon,
      shouldRemoveQuantityCoupon,
      ageQualifyingSlots,
      newDiscount,
    } = await this.evaluateAutoCoupons(
      order,
      filledParticipants,
      reservedTickets,
      ticketsSubtotalNew,
      productsSubtotal,
      { pendingProducts: (order.pendingProducts as any[]) ?? [] },
    );
    const newFinalAmount = Math.max(0, newTotalAmount - newDiscount);

    // Só atualiza os dados do pedido — NÃO toca em reserva/estoque/placeholders (fixos).
    const updated = await w.order.update({
      where: { id: orderId },
      data: {
        pendingParticipants: filledParticipants, // versão normalizada + slots vazios
        totalAmount: newTotalAmount,
        discount: newDiscount,
        finalAmount: newFinalAmount,
        ...(autoCouponId && { couponId: autoCouponId }),
        ...((shouldRemoveQuantityCoupon || shouldRemoveAgeCoupon) && { couponId: null }),
        updatedAt: new Date(),
      },
      include: ORDER_INCLUDE,
    });
    return orderShape(
      updated,
      newDiscount > 0 ? newDiscount : undefined,
      { couponAutoRemoved: shouldRemoveQuantityCoupon || shouldRemoveAgeCoupon },
      autoEffectiveUsage,
      undefined,
      ageQualifyingSlots,
    );
  }

  // ── 3a. removeReservedSlot ─────────────────────────────────────────────────

  /**
   * Remove UM ingresso/slot do pedido (reduz a quantidade reservada em 1) sem recriar o pedido.
   * `slotIndex` = índice (0-based) do participante/unidade reservada (mesma ordem do orderShape).
   * Ações atômicas: libera 1 vaga de estoque, cancela 1 placeholder PENDING daquele ingresso,
   * decrementa o `OrderReservedTicket` (deleta a linha se zerar), apara o participante do slot e
   * recalcula totais + cupom. Mantém o invariante reservedTickets == estoque retido == placeholders.
   */
  async removeReservedSlot(userId: string, orderId: string, slotIndex: number): Promise<Record<string, any>> {
    const order = await this.findOrderForWrite(userId, orderId);
    this.assertPending(order);

    const w: any = this.prisma.getWriteClient();
    const reservedTickets = (order.reservedTickets ?? []) as any[];

    // Expande os ingressos reservados em unidades (1 por slot), na MESMA ordem das linhas.
    const units: { ortId: string; ticketId: string; batchId: string }[] = [];
    for (const rt of reservedTickets) {
      for (let i = 0; i < (rt.quantity ?? 0); i++) {
        units.push({ ortId: rt.id, ticketId: rt.ticketId, batchId: rt.batchId });
      }
    }

    if (slotIndex < 0 || slotIndex >= units.length) {
      throw new AppUnprocessableException('INVALID_SLOT', `Slot ${slotIndex} inválido (pedido tem ${units.length} ingressos).`);
    }

    // Remover o ÚLTIMO ingresso = ZERAR o pedido (recomeçar). Mesma regra do cancelExpiredOrders:
    //   - JÁ preencheu endereço de cobrança (chegou ao billing) → mantém histórico como CANCELLED.
    //   - NÃO preencheu nada (só reservou) → DELETA o pedido (cascade remove registrations/
    //     reservedTickets); restaura estoque. Cupom/voucher PENDING não foram consumidos.
    if (units.length <= 1) {
      const reachedBilling = !!order.billingPostalCode;
      if (reachedBilling) {
        await this.cancelOrderAndRestoreStock(orderId, 'EMPTIED_BY_USER', w);
        const cancelled = await this.prisma.getReadClient().order.findUnique({
          where: { id: orderId },
          include: ORDER_INCLUDE,
        });
        return orderShape(cancelled, undefined, { orderCancelled: true });
      }
      // Sem endereço → deleta (restaura estoque + delete em transação).
      await w.$transaction(async (tx: any) => {
        for (const rt of reservedTickets) {
          await tx.$executeRaw`
            UPDATE "TicketBatch"
            SET "availableQuantity" = LEAST("availableQuantity" + ${rt.quantity}, "quantity")
            WHERE id = ${rt.batchId}::uuid
          `;
        }
        // `reservedByOrderId` não é FK (sem cascade) → libera a reserva de voucher ANTES de
        // deletar o pedido, senão o voucher ficaria preso a um pedido inexistente até
        // `reservedUntil` (até 30 min). Espelha o caminho gêmeo do cron de expiração.
        await releaseVoucherByOrder(tx, orderId);
        await tx.order.delete({ where: { id: orderId } });
      });
      return { id: orderId, status: 'DELETED', orderDeleted: true };
    }

    const target = units[slotIndex];

    // Nova reserva = decrementa a quantidade do ticket-alvo em 1 (remove a linha se zerar).
    const newReservedTickets = reservedTickets
      .map((rt: any) => (rt.id === target.ortId ? { ...rt, quantity: (rt.quantity ?? 0) - 1 } : rt))
      .filter((rt: any) => (rt.quantity ?? 0) > 0);

    // Participantes: remove EXATAMENTE o slot pedido; depois completa com vazios até o novo total.
    const existingParticipants = ((order.pendingParticipants as any[] | null) ?? []).filter((_: any, i: number) => i !== slotIndex);
    const newTotalReserved = newReservedTickets.reduce((s: number, rt: any) => s + (rt.quantity ?? 0), 0);
    const filledParticipants = existingParticipants.slice(0, newTotalReserved);
    while (filledParticipants.length < newTotalReserved) filledParticipants.push({});

    const ticketsSubtotal = newReservedTickets.reduce((s: number, rt: any) => s + (rt.unitPrice ?? 0) * (rt.quantity ?? 0), 0);
    const productsSubtotal = ((order.pendingProducts as any[] | null) ?? []).reduce(
      (s: number, p: any) => s + (p.unitPrice ?? 0) * (p.quantity ?? 1),
      0,
    );
    const newTotalAmount = ticketsSubtotal + productsSubtotal;

    const {
      autoCouponId,
      autoEffectiveUsage,
      shouldRemoveAgeCoupon,
      shouldRemoveQuantityCoupon,
      ageQualifyingSlots,
      newDiscount,
    } = await this.evaluateAutoCoupons(order, filledParticipants, newReservedTickets, ticketsSubtotal, productsSubtotal, { pendingProducts: (order.pendingProducts as any[]) ?? [] });
    const newFinalAmount = Math.max(0, newTotalAmount - newDiscount);

    const updated = await w.$transaction(async (tx: any) => {
      // 1) libera 1 vaga do lote do slot removido (LEAST evita ultrapassar quantity).
      await tx.$executeRaw`
        UPDATE "TicketBatch" SET "availableQuantity" = LEAST("availableQuantity" + 1, "quantity")
        WHERE id = ${target.batchId}::uuid
      `;

      // 2) DELETA 1 placeholder PENDING desse ingresso (sai da contagem de vendas → vaga livre).
      // Deletar (não cancelar): o placeholder é só um slot de reserva pré-pagamento, nunca foi
      // uma inscrição real. Cancelar (status=CANCELLED) deixava uma Registration fantasma que o
      // getOrderDetails (filtro `status != PENDING`) e o finalize (deleta só PENDING) não removiam
      // → o pedido aparecia com 1 ingresso a mais no /details (bug: reservou 2, removeu 1, mostrava 2).
      // O cascade remove o RegistrationTicket junto.
      const placeholder = await tx.registration.findFirst({
        where: { orderId, status: 'PENDING', tickets: { some: { ticketId: target.ticketId, batchId: target.batchId } } },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      });
      if (placeholder) {
        await tx.registration.delete({ where: { id: placeholder.id } });
      }

      // 3) decrementa (ou remove) a linha de OrderReservedTicket.
      const stillExists = newReservedTickets.some((rt: any) => rt.id === target.ortId);
      if (stillExists) {
        await tx.orderReservedTicket.update({ where: { id: target.ortId }, data: { quantity: { decrement: 1 } } });
      } else {
        await tx.orderReservedTicket.delete({ where: { id: target.ortId } });
      }

      return tx.order.update({
        where: { id: orderId },
        data: {
          pendingParticipants: filledParticipants,
          totalAmount: newTotalAmount,
          discount: newDiscount,
          finalAmount: newFinalAmount,
          ...(autoCouponId && { couponId: autoCouponId }),
          ...((shouldRemoveQuantityCoupon || shouldRemoveAgeCoupon) && { couponId: null }),
          updatedAt: new Date(),
        },
        include: ORDER_INCLUDE,
      });
    });

    return orderShape(
      updated,
      newDiscount > 0 ? newDiscount : undefined,
      { couponAutoRemoved: shouldRemoveQuantityCoupon || shouldRemoveAgeCoupon },
      autoEffectiveUsage,
      undefined,
      ageQualifyingSlots,
    );
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

    // #3 (checkout-coupons-server-spec §3.5): cupom/voucher inválido/expirado/abaixo do
    // mínimo NÃO quebra o checkout — vira rejeição SUAVE (`couponRejected`), mantendo o
    // pedido como está. Só o conflito cupom-vs-voucher (acima, uso indevido do cliente)
    // segue como erro. O bloco fica indentado um nível por estar dentro do try.
    try {
    const w: any = this.prisma.getWriteClient();
    const r: any = this.prisma.getReadClient();
    const reservedTickets = (order.reservedTickets ?? []) as any[];
    const ticketsSubtotal = reservedTickets.reduce((sum: number, rt: any) => sum + rt.unitPrice * rt.quantity, 0);
    const productsSubtotal = Math.max(0, (order.totalAmount as number) - ticketsSubtotal);
    // Participantes atuais + total de unidades — base da validação POR PARTICIPANTE da
    // lista de documento (cupom/voucher com cpfListStatus=ENABLED). O documento do
    // COMPRADOR deixou de gatear: cada participante elegível libera o desconto no seu
    // próprio ingresso (espelha o cupom AGE).
    const participants = (order.pendingParticipants as any[] | null) ?? [];
    const totalUnits = reservedTickets.reduce((sum: number, rt: any) => sum + (rt.quantity ?? 0), 0);

    let couponId: string | null = null;
    let voucherId: string | null = null;
    let discount = 0;
    let couponEffectiveUsage: number | undefined;
    let couponFixedPerUnit: number | undefined;
    let couponQualifyingSlots: number[] | undefined;

    if (dto.couponCode) {
      const normalizedCode = dto.couponCode.toUpperCase().trim();

      // Voucher takes priority over coupon when both share the same code
      const voucherByCode = await r.voucher.findUnique({ where: { code: normalizedCode } });
      if (voucherByCode && voucherByCode.eventId === order.eventId && voucherByCode.status === 'ACTIVE') {
        if (!voucherByCode.expiryDate || new Date(voucherByCode.expiryDate) > new Date()) {
          // Lista de documento por-participante. SEM participantes (voucher do link no início
          // do checkout) → aplica provisoriamente (sem gate); validação real no /participants e pay.
          let voucherEligibleSlots: Set<number> | undefined;
          if (voucherByCode.cpfListStatus === 'ENABLED' && participants.length > 0) {
            // 1 ingresso só: preenchido-elegível tem prioridade, vazio é fallback provisório.
            const slots = computeVoucherEligibleSlots(participants, voucherByCode.documentList, voucherByCode.cpfList, totalUnits);
            if (slots.length === 0) {
              throw new AppUnprocessableException('VOUCHER_CPF_RESTRICTED', 'Voucher não aplicável: nenhum participante elegível');
            }
            voucherEligibleSlots = new Set(slots);
          }
          // Voucher = 1 ingresso grátis: cobre só a unidade aplicável mais cara
          // (respeita appliesTo + slots elegíveis), nunca todos os ingressos.
          const cov = resolveVoucherCoverage(reservedTickets, voucherByCode.appliesTo, undefined, voucherEligibleSlots);
          if (!cov.hasApplicable) {
            throw new AppUnprocessableException(
              'VOUCHER_NOT_APPLICABLE',
              'Voucher não aplicável aos ingressos do pedido',
            );
          }
          // applyToProducts: o ingresso grátis cobre também os produtos adicionais — mas SÓ os
          // do participante do ingresso coberto (slot `qualifyingSlot`), não os dos outros.
          const voucherProductsExtra = voucherByCode.applyToProducts
            ? computeSlotParticipantProductsSubtotal(order.pendingProducts as any[], participants, cov.qualifyingSlot)
            : 0;
          discount = cov.discount + voucherProductsExtra;
          voucherId = voucherByCode.id;
          // Reserva de uso único: claim atômico antes de persistir. Indisponível (já reservado
          // por outro pedido ativo) → rejeição SUAVE (cai no catch → couponRejected).
          if (!(await this.reserveVoucherForOrder(w, order, voucherId))) {
            throw new AppUnprocessableException(
              'VOUCHER_UNAVAILABLE',
              'Este voucher já está sendo usado em outro pedido.',
            );
          }
          const finalAmountV = Math.max(0, order.totalAmount - discount);
          const updatedV = await w.order.update({
            where: { id: orderId },
            data: { couponId: null, voucherId, discount, finalAmount: finalAmountV, updatedAt: new Date() },
            include: ORDER_INCLUDE,
          });
          return {
            ...orderShape(updatedV, discount),
            appliedDiscount: { type: 'voucher', discount },
          };
        }
      }

      const coupon = await r.coupon.findFirst({
        where: {
          eventId: order.eventId,
          code: normalizedCode,
          status: 'ACTIVE',
          couponType: 'DISCOUNT',
          deletedAt: null,
        },
      });

      if (!coupon) {
        throw new AppUnprocessableException('COUPON_NOT_FOUND', 'Cupom não encontrado ou inválido');
      }
      if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) throw new AppUnprocessableException('COUPON_EXPIRED', 'Cupom expirado');
      if (coupon.minCartValue && order.totalAmount < coupon.minCartValue) {
        throw new AppUnprocessableException('COUPON_MIN_VALUE', `Valor mínimo do pedido para este cupom: R$ ${(coupon.minCartValue / 100).toFixed(2)}`);
      }

      // Lista de documento (CPF + estrangeiros) validada POR PARTICIPANTE (não mais pelo
      // comprador): só os ingressos dos participantes cujo documento está na lista recebem
      // o desconto — espelha o cupom AGE. Nenhum elegível → cupom rejeitado (soft).
      //
      // SEM participantes ainda (cupom do link aplicado no início do checkout, antes de
      // /participants) → aplica PROVISORIAMENTE (sem gate de CPF): o desconto aparece no resumo.
      // A validação por-participante real acontece no PATCH /participants e no pay (que exige
      // participantes). Por isso o gate só roda quando já há participantes.
      let docEligibleSlots: number[] | undefined;
      if (coupon.cpfListStatus === 'ENABLED' && participants.length > 0) {
        docEligibleSlots = computeDocEligibleSlots(participants, coupon.documentList, coupon.cpfList, totalUnits, true);
        if (docEligibleSlots.length === 0) {
          throw new AppUnprocessableException('COUPON_CPF_RESTRICTED', 'Cupom não aplicável: nenhum participante elegível');
        }
      }

      // Filtrar apenas os tickets aos quais o cupom se aplica
      let applicableTickets = reservedTickets;
      if (coupon.appliesTo && coupon.appliesTo !== 'all') {
        const allowedIds = parseAppliesToArray(coupon.appliesTo);
        applicableTickets = reservedTickets.filter((rt: any) => allowedIds.includes(rt.ticketId));
      }

      const applicableQuantity = applicableTickets.reduce((sum: number, rt: any) => sum + rt.quantity, 0);
      // Aplicar desconto apenas nos ingressos mais caros dentro do uso restante
      const remaining = coupon.maxUsage != null
        ? Math.max(0, coupon.maxUsage - coupon.usageCount)
        : applicableQuantity;
      if (remaining <= 0) throw new AppUnprocessableException('COUPON_EXHAUSTED', 'Cupom esgotado');
      // Com lista de documento, o uso é capado pelo nº de participantes ELEGÍVEIS e o
      // desconto incide nos slots deles (qualifyingSlots). Sem lista, comportamento original.
      couponEffectiveUsage = docEligibleSlots
        ? Math.min(remaining, applicableQuantity, docEligibleSlots.length)
        : Math.min(remaining, applicableQuantity);
      couponQualifyingSlots = docEligibleSlots;
      // applyToProducts incide SÓ nos produtos dos participantes cujo ingresso é coberto pelo
      // cupom (appliesTo), não em todos os produtos do pedido. Ex.: cupom no meu ingresso não
      // desconta os produtos do amigo (ingresso fora do appliesTo). Mapa email→ingresso posicional.
      const couponApplicableTicketIdSet = new Set<string>(applicableTickets.map((rt: any) => rt.ticketId));
      const participantTicketMap = buildParticipantTicketMap(reservedTickets, participants);
      const couponProductsExtra = coupon.applyToProducts
        ? computeApplicableProductsSubtotal(order.pendingProducts as any[], participantTicketMap, couponApplicableTicketIdSet)
        : 0;
      discount = computePartialCouponDiscount(applicableTickets, coupon.type, coupon.value, couponEffectiveUsage, couponProductsExtra);
      couponId = coupon.id;
      if (coupon.type === 'FIXED') couponFixedPerUnit = coupon.value;

      // Se o cupom não cobre todos os ingressos e já existe um voucher ativo no pedido,
      // manter o voucher nos ingressos que o cupom não alcança (desconto combinado)
      const applicableTicketIds = new Set(applicableTickets.map((rt: any) => rt.ticketId));
      const nonApplicableTickets = reservedTickets.filter((rt: any) => !applicableTicketIds.has(rt.ticketId));
      if (nonApplicableTickets.length > 0 && order.voucherId) {
        const existingVoucher = await r.voucher.findUnique({
          where: { id: order.voucherId },
          select: { id: true, status: true, expiryDate: true, eventId: true, appliesTo: true, applyToProducts: true },
        });
        if (
          existingVoucher &&
          existingVoucher.eventId === order.eventId &&
          existingVoucher.status === 'ACTIVE' &&
          (!existingVoucher.expiryDate || new Date(existingVoucher.expiryDate) > new Date())
        ) {
          // Voucher = 1 ingresso grátis, restrito aos ingressos NÃO cobertos pelo
          // cupom (combinado). Não erra aqui se nada sobrar — o cupom já cobre tudo.
          const cov = resolveVoucherCoverage(reservedTickets, existingVoucher.appliesTo, applicableTicketIds);
          if (cov.hasApplicable) {
            // Produtos entram no desconto NO MÁXIMO uma vez: se o cupom já os incluiu
            // (applyToProducts), o voucher cobre só o ingresso — evita double-count. Quando o
            // voucher cobre produtos, são SÓ os do participante do ingresso coberto (qualifyingSlot).
            const voucherProductsExtra =
              existingVoucher.applyToProducts && !coupon.applyToProducts
                ? computeSlotParticipantProductsSubtotal(order.pendingProducts as any[], participants, cov.qualifyingSlot)
                : 0;
            discount += cov.discount + voucherProductsExtra;
            voucherId = order.voucherId;
          }
        }
      }

      discount = Math.min(discount, order.totalAmount as number);

    } else if (dto.voucherCode) {
      const voucher = await r.voucher.findUnique({
        where: { code: dto.voucherCode.toUpperCase().trim() },
      });

      if (!voucher || voucher.eventId !== order.eventId) {
        throw new AppUnprocessableException('VOUCHER_NOT_FOUND', 'Voucher não encontrado ou inválido');
      }
      // USED tem mensagem própria — "não encontrado" confunde quem recebeu o link
      // e já usou (ou teve o voucher usado por outro pedido). Espelha o
      // `assertVoucherUsable` do products.service.
      if (voucher.status === 'USED') {
        throw new AppUnprocessableException('VOUCHER_ALREADY_USED', 'Este voucher já foi utilizado');
      }
      if (
        voucher.status === 'EXPIRED' ||
        (voucher.expiryDate && new Date(voucher.expiryDate) < new Date())
      ) {
        throw new AppUnprocessableException('VOUCHER_EXPIRED', 'Voucher expirado');
      }
      if (voucher.status !== 'ACTIVE') {
        // INACTIVE (ou estados futuros) — inválido sem vazar detalhe interno.
        throw new AppUnprocessableException('VOUCHER_NOT_FOUND', 'Voucher não encontrado ou inválido');
      }

      // Lista de documento por-participante. SEM participantes (voucher do link no início do
      // checkout) → aplica provisoriamente (sem gate); validação real no /participants e pay.
      let voucherEligibleSlots: Set<number> | undefined;
      if (voucher.cpfListStatus === 'ENABLED' && participants.length > 0) {
        // 1 ingresso só: preenchido-elegível tem prioridade, vazio é fallback provisório.
        const slots = computeVoucherEligibleSlots(participants, voucher.documentList, voucher.cpfList, totalUnits);
        if (slots.length === 0) {
          throw new AppUnprocessableException('VOUCHER_CPF_RESTRICTED', 'Voucher não aplicável: nenhum participante elegível');
        }
        voucherEligibleSlots = new Set(slots);
      }

      // Voucher = 1 ingresso grátis: cobre só a unidade aplicável mais cara
      // (respeita appliesTo + slots elegíveis), nunca todos os ingressos.
      const cov = resolveVoucherCoverage(reservedTickets, voucher.appliesTo, undefined, voucherEligibleSlots);
      if (!cov.hasApplicable) {
        throw new AppUnprocessableException(
          'VOUCHER_NOT_APPLICABLE',
          'Voucher não aplicável aos ingressos do pedido',
        );
      }
      // applyToProducts: o ingresso grátis cobre também os produtos — SÓ os do participante do
      // ingresso coberto (slot `qualifyingSlot`), nunca os dos demais participantes.
      const voucherProductsExtra = voucher.applyToProducts
        ? computeSlotParticipantProductsSubtotal(order.pendingProducts as any[], participants, cov.qualifyingSlot)
        : 0;
      discount = cov.discount + voucherProductsExtra;
      voucherId = voucher.id;

    } else {
      // Sem código — remover cupom/voucher existente
      couponId = null;
      voucherId = null;
      discount = 0;
    }

    // Reserva de uso único do voucher: claim do novo (se houver) + liberação do anterior em
    // troca/remoção/aplicação de cupom. `voucherId` null aqui já libera a reserva deste pedido.
    // Indisponível → rejeição SUAVE (cai no catch → couponRejected).
    if (!(await this.reserveVoucherForOrder(w, order, voucherId))) {
      throw new AppUnprocessableException(
        'VOUCHER_UNAVAILABLE',
        'Este voucher já está sendo usado em outro pedido.',
      );
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
      ...orderShape(updated, discount, undefined, couponEffectiveUsage, couponFixedPerUnit, couponQualifyingSlots),
      appliedDiscount: {
        type: couponId ? 'coupon' : voucherId ? 'voucher' : null,
        discount,
      },
    };
    } catch (e) {
      // Falha de validação de cupom/voucher → não quebra o fluxo: devolve o pedido
      // INALTERADO + o motivo, pro front exibir o aviso e seguir o checkout.
      if (e instanceof AppUnprocessableException) {
        const resp = e.getResponse() as { code?: string; message?: string };
        return {
          ...orderShape(order),
          couponRejected: {
            code: resp?.code ?? 'COUPON_REJECTED',
            reason: resp?.message ?? 'Cupom não pôde ser aplicado',
          },
        };
      }
      throw e;
    }
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
    const r: any = this.prisma.getReadClient();

    const participants = (order.pendingParticipants as any[] | null) ?? [];
    const validEmails = new Set(participants.map((p: any) => p.email?.toLowerCase()));
    const reservedTickets = (order.reservedTickets as any[]) ?? [];

    // Recalculate product subtotal validando produtos e participantes.
    // Enriquecemos cada item com `unitPrice` calculado para gravar no JSON
    // pendingProducts — é o snapshot do preço usado por patchParticipants e por
    // helpers como computePendingProductsSubtotal (que leem p.unitPrice direto).
    // Sem isso, qualquer recálculo de totalAmount posterior zera os produtos.
    let productsSubtotal = 0;
    const enrichedProducts: any[] = [];
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

      let variation: any = null;
      if (item.variationId) {
        variation = product.variations.find((v: any) => v.id === item.variationId);
        if (!variation) {
          throw new UnprocessableEntityException(
            `Variação selecionada não encontrada para "${product.name}". Selecione uma opção válida.`,
          );
        }
      }
      const unitPrice = resolveProductUnitPrice(product, variation);
      productsSubtotal += unitPrice * item.quantity;
      enrichedProducts.push({
        productId: item.productId,
        variationId: item.variationId ?? null,
        quantity: item.quantity,
        participantEmail: item.participantEmail,
        unitPrice,
      });
    }

    const ticketsSubtotal = reservedTickets.reduce(
      (sum: number, rt: any) => sum + rt.unitPrice * rt.quantity,
      0,
    );
    const totalAmount = ticketsSubtotal + productsSubtotal;

    // ── Cupons automáticos (QUANTITY/AGE) ──────────────────────────────────
    // FONTE ÚNICA (evaluateAutoCoupons), compartilhada com PATCH /participants.
    const {
      autoCouponId,
      autoEffectiveUsage,
      shouldRemoveAgeCoupon,
      shouldRemoveQuantityCoupon,
      ageQualifyingSlots,
      newDiscount,
    } = await this.evaluateAutoCoupons(order, participants, reservedTickets, ticketsSubtotal, productsSubtotal, { pendingProducts: enrichedProducts });

    const finalAmount = Math.max(0, totalAmount - newDiscount);

    const updated = await w.order.update({
      where: { id: orderId },
      data: {
        pendingProducts: enrichedProducts,
        totalAmount,
        discount: newDiscount,
        finalAmount,
        ...(autoCouponId && { couponId: autoCouponId }),
        ...((shouldRemoveQuantityCoupon || shouldRemoveAgeCoupon) && { couponId: null }),
        updatedAt: new Date(),
      },
      include: ORDER_INCLUDE,
    });
    return orderShape(
      updated,
      newDiscount > 0 ? newDiscount : undefined,
      { couponAutoRemoved: shouldRemoveQuantityCoupon || shouldRemoveAgeCoupon },
      autoEffectiveUsage,
      undefined,
      ageQualifyingSlots,
    );
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

    // Espelha o endereço de cobrança no perfil do DONO do pedido
    // (`updated.userId`, não o caller — admin pode editar em nome de terceiro
    // via `findOrderForWrite`). O `billingStateUf` mapeia para `user.state`;
    // os demais campos têm correspondência 1:1 com as colunas do perfil.
    //
    // IMPORTANTE: NUNCA sincronizar `country` do billing pro User. country no
    // User representa NACIONALIDADE (escolhida no cadastro/checkout), nao pais
    // do endereço de cobrança. Um argentino comprando no BR (endereço de cobrança
    // brasileiro) nao pode ter conta convertida pra Brasil — quebra formatação
    // de telefone, label de documento (CPF vs Documento), etc.
    //
    // Best-effort: persistir o billing é o caminho crítico do checkout; uma
    // falha aqui (improvável — colunas sem constraints) não deve abortar o
    // pedido. Só incluímos campos com valor não-vazio para nunca apagar dado
    // já existente no perfil (complement/neighborhood são opcionais).
    const profileAddress: Record<string, string> = {};
    if (b.stateUf?.trim()) profileAddress.state = b.stateUf.trim();
    if (b.city?.trim()) profileAddress.city = b.city.trim();
    if (b.postalCode?.trim()) profileAddress.postalCode = b.postalCode.trim();
    if (b.street?.trim()) profileAddress.street = b.street.trim();
    if (b.number?.trim()) profileAddress.number = b.number.trim();
    if (b.complement?.trim()) profileAddress.complement = b.complement.trim();
    if (b.neighborhood?.trim())
      profileAddress.neighborhood = b.neighborhood.trim();

    if (Object.keys(profileAddress).length > 0) {
      try {
        await w.user.update({
          where: { id: updated.userId },
          data: profileAddress,
        });
      } catch (err) {
        this.logger.warn(
          `Falha ao sincronizar endereço no perfil (user=${updated.userId}, order=${orderId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return orderShape(updated);
  }

  // ── 6. pay ────────────────────────────────────────────────────────────────

  /**
   * Wrapper de idempotência do pagamento. O check de cache + gravação do resultado não são
   * atômicos — sem o LOCK (SET NX), dois `pay` simultâneos com a MESMA Idempotency-Key
   * passavam ambos pelo check vazio e chamavam a Cielo DUAS vezes (dupla autorização no
   * cartão; QR PIX órfão). O lock garante exatamente UMA execução por chave por vez; o
   * concorrente recebe 409 e o front re-tenta/aguarda (o resultado cacheado atende o retry).
   */
  async pay(
    userId: string,
    orderId: string,
    idempotencyKey: string | undefined,
    dto: PayOrderDto,
  ): Promise<Record<string, any>> {
    // 6.1 Idempotency check (resposta cacheada de uma execução anterior)
    if (idempotencyKey) {
      const cached = await this.redisService.getIdempotencyResult(idempotencyKey);
      if (cached) {
        this.logger.log(`Idempotent pay: returning cached response for key ${idempotencyKey}`);
        return cached.body;
      }
      // 6.1b Lock atômico por chave — fail-open se Redis indisponível.
      const locked = await this.redisService.acquireIdempotencyLock(idempotencyKey);
      if (!locked) {
        throw new AppConflictException(
          'PAYMENT_IN_PROGRESS',
          'Já existe um pagamento em processamento para esta chave — aguarde a resposta.',
        );
      }
    }

    try {
      return await this.executePay(userId, orderId, idempotencyKey, dto);
    } finally {
      // Libera SEMPRE (sucesso ou falha). No sucesso o resultado já está cacheado, então
      // um retry posterior nem chega ao lock; na falha o usuário pode tentar de novo.
      if (idempotencyKey) {
        await this.redisService.releaseIdempotencyLock(idempotencyKey);
      }
    }
  }

  private async executePay(
    userId: string,
    orderId: string,
    idempotencyKey: string | undefined,
    dto: PayOrderDto,
  ): Promise<Record<string, any>> {
    const r: any = this.prisma.getReadClient();
    const w: any = this.prisma.getWriteClient();

    // 6.2 Ownership check
    // PRIMARY (write client): o pay COBRA com base no que lê aqui (ticketsSubtotal/finalTotal
    // recalculados de order.reservedTickets). Ler da RÉPLICA defasada cobrava a quantidade
    // ANTIGA (ex.: 3 ingressos) mesmo após o cliente ter removido um slot (primary = 2) — o
    // finalize roda em tx no primary e criava só 2 inscrições → cobrança divergente das inscrições.
    const order = await w.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (order.userId !== userId && !await this.isAdminUser(userId)) {
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

    // 6.3b Whitelist de métodos por evento (tela financeira). Array vazio/ausente
    // (registro pré-migration ou include sem event) = aceita todos — mesmo
    // comportamento dos eventos legados, que são backfillados com os 3 métodos.
    const acceptedMethods: string[] = (order as any).event?.acceptedPaymentMethods ?? [];
    if (acceptedMethods.length > 0 && !acceptedMethods.includes(dto.method)) {
      throw new AppUnprocessableException(
        'PAYMENT_METHOD_NOT_ACCEPTED',
        'Este evento não aceita esta forma de pagamento',
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

    // 6.5b Todos os slots preenchidos. No modelo de reserva FIXA, slots não preenchidos ficam
    // como objetos vazios ({}) em pendingParticipants — pagar assim criaria inscrição "em branco".
    // Um slot está preenchido se tem qualquer dado identificador (nome/email/documento).
    const reservedUnits = reservedTickets.reduce((sum: number, rt: any) => sum + (rt.quantity ?? 0), 0);
    const filledCount = participants.filter(
      (p: any) => !!(p && (p.email || p.name || p.documentNumber || p.cpf)),
    ).length;
    if (filledCount < reservedUnits) {
      throw new AppUnprocessableException(
        'INCOMPLETE_PARTICIPANTS',
        `Preencha os dados de todos os ${reservedUnits} participante(s) antes de pagar (${filledCount} preenchido(s)).`,
      );
    }

    // 6.6 Calculate final total
    const ticketsSubtotal = reservedTickets.reduce(
      (sum: number, rt: any) => sum + rt.unitPrice * rt.quantity,
      0,
    );
    let productsSubtotal = 0;
    const pendingProducts = order.pendingProducts as any[] | null;
    // Itens com preço LIVE recalculado + participantEmail preservado — base do escopo de
    // produtos por ingresso (applyToProducts). Usa o MESMO preço que entra no preDiscountTotal.
    const pricedPendingProducts: any[] = [];
    if (pendingProducts?.length) {
      for (const item of pendingProducts) {
        const product = await r.product.findUnique({
          where: { id: item.productId },
          include: { variations: true },
        });
        if (product) {
          const variation = item.variationId
            ? product.variations.find((v: any) => v.id === item.variationId)
            : null;
          const unitPrice = resolveProductUnitPrice(product, variation);
          productsSubtotal += unitPrice * item.quantity;
          pricedPendingProducts.push({ ...item, unitPrice });
        }
      }
    }
    // Mapa email→ingresso (posicional) reutilizado pelos escopos de produto do cupom/voucher.
    const participantTicketMap = buildParticipantTicketMap(reservedTickets, participants);

    const preDiscountTotal = ticketsSubtotal + productsSubtotal;

    // 6.7 Apply coupon/voucher (mutually exclusive)
    if (dto.couponCode && dto.voucherCode) {
      throw new AppUnprocessableException(
        'DISCOUNT_CONFLICT',
        'Não é possível usar cupom e voucher ao mesmo tempo',
      );
    }

    // Fall back to coupon/voucher already applied via PATCH /coupon, so the frontend
    // doesn't need to re-send the code on every pay attempt.
    // Quando ambos coexistem (desconto combinado: cupom em alguns ingressos + voucher nos restantes),
    // carrega os dois códigos independentemente.
    const effectiveCouponCode: string | undefined = dto.couponCode ?? (
      order.couponId && (order.coupon as any)?.couponType === 'DISCOUNT'
        ? (order.coupon as any)?.code
        : undefined
    );
    const effectiveVoucherCode: string | undefined = dto.voucherCode ?? (
      order.voucherId
        ? (order.voucher as any)?.code
        : undefined
    );

    let couponDiscount = 0;
    let couponId: string | undefined;
    // Flag do cupom efetivamente aplicado neste pagamento: indica se o desconto
    // incidiu também sobre os produtos adicionais (kits/extras). Capturada aqui
    // (do objeto cupom já carregado, sem query extra) para congelar a intenção
    // histórica no snapshot e no metadata do pagamento — o organizador pode
    // alterar `applyToProducts` do cupom após a venda, e o recibo deve refletir
    // o que valeu no momento da compra.
    let couponAppliedToProducts = false;
    let voucherDiscount = 0;
    let voucherId: string | undefined;
    // Mesma semântica de couponAppliedToProducts, para o voucher: o ingresso grátis
    // cobriu também os produtos adicionais. Congelada no snapshot/metadata do pagamento.
    let voucherAppliedToProducts = false;
    // IDs dos tickets cobertos pelo cupom — usado pelo bloco do voucher para cobrir o restante
    let couponApplicableTicketIds: Set<string> | undefined;

    if (effectiveCouponCode) {
      // Cupom com código (DISCOUNT type)
      const coupon = await r.coupon.findFirst({
        where: {
          eventId: order.eventId,
          code: effectiveCouponCode.toUpperCase().trim(),
          status: 'ACTIVE',
          deletedAt: null,
        },
      });
      if (coupon && (!coupon.expiryDate || new Date(coupon.expiryDate) > new Date())) {
        let applicableTicketsPay = reservedTickets;
        if (coupon.appliesTo && coupon.appliesTo !== 'all') {
          const allowedIds = parseAppliesToArray(coupon.appliesTo);
          applicableTicketsPay = reservedTickets.filter((rt: any) => allowedIds.includes(rt.ticketId));
        }
        couponApplicableTicketIds = new Set(applicableTicketsPay.map((rt: any) => rt.ticketId));

        // Lista de documento POR PARTICIPANTE (mesma regra do patchCoupon): só os
        // participantes elegíveis recebem o desconto; nenhum elegível → cupom NÃO aplica.
        // Recalculado aqui (momento decisivo do dinheiro) — não confia só no patchCoupon.
        // SÓ DISCOUNT é gateado por CPF (QUANTITY/AGE não usam lista de documento).
        let docEligibleCount: number | undefined;
        if (coupon.cpfListStatus === 'ENABLED' && coupon.couponType === 'DISCOUNT') {
          const totalUnitsPay = reservedTickets.reduce((s: number, rt: any) => s + (rt.quantity ?? 0), 0);
          docEligibleCount = computeDocEligibleSlots(participants, coupon.documentList, coupon.cpfList, totalUnitsPay).length;
          if (docEligibleCount === 0) {
            // Sem participante elegível → não aplica o cupom (couponId/desconto ficam vazios).
            applicableTicketsPay = [];
          }
        }

        if (applicableTicketsPay.length > 0) {
          const applicableQty = applicableTicketsPay.reduce((s: number, rt: any) => s + rt.quantity, 0);
          const remaining = coupon.maxUsage != null
            ? Math.max(0, coupon.maxUsage - coupon.usageCount)
            : applicableQty;
          const effectiveUsage = docEligibleCount != null
            ? Math.min(remaining, applicableQty, docEligibleCount)
            : Math.min(remaining, applicableQty);
          // applyToProducts SÓ nos produtos dos participantes cujo ingresso o cupom cobre
          // (couponApplicableTicketIds), via mapa email→ingresso — não em todos os produtos.
          const productsExtraPay = coupon.applyToProducts
            ? computeApplicableProductsSubtotal(pricedPendingProducts, participantTicketMap, couponApplicableTicketIds)
            : 0;
          couponDiscount = computePartialCouponDiscount(applicableTicketsPay, coupon.type, coupon.value, effectiveUsage, productsExtraPay);
          couponId = coupon.id;
          couponAppliedToProducts = coupon.applyToProducts;
        }
      }
    }

    // Cupons automáticos (QUANTITY / AGE) — sem código, aplicados se condição satisfeita
    if (!couponId && !effectiveVoucherCode) {
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
          const allowedTicketIds = parseAppliesToArray(coupon.appliesTo);
          if (!ticketIds.some((id: string) => allowedTicketIds.includes(id))) continue;
        }

        if (coupon.couponType === 'QUANTITY') {
          if (totalQuantity < (coupon.minQuantity ?? 0)) continue;
          // QUANTITY: all-or-nothing — se esgotado, não aplica
          if (coupon.maxUsage != null && coupon.usageCount >= coupon.maxUsage) continue;

          // Base de cálculo respeita applyToProducts: sem flag = só ingressos; com flag =
          // ingressos + produtos. Cap final é a própria base (não pode descontar mais do
          // que o subtotal coberto).
          const quantityBase = coupon.applyToProducts ? preDiscountTotal : ticketsSubtotal;
          couponDiscount =
            coupon.type === 'PERCENTAGE'
              ? Math.floor(quantityBase * (coupon.value / 100))
              : Math.min(coupon.value, quantityBase);
          couponId = coupon.id;
          couponAppliedToProducts = coupon.applyToProducts;
          break;
        } else if (coupon.couponType === 'AGE') {
          // Validar idade na data do evento. ESTRITO no pay (lenient=false): slot sem birthDate
          // NÃO recebe o desconto no commit — só idade informada e dentro da faixa.
          const refDate = resolveAgeReferenceDate(order);
          const minAge = coupon.minAge ?? 0;
          const maxAge = coupon.maxAge ?? Infinity;
          const totalUnitsAge = reservedTickets.reduce((s: number, rt: any) => s + (rt.quantity ?? 0), 0);
          const ageMatchCount = computeAgeEligibleSlots(participants, minAge, maxAge, refDate, totalUnitsAge).length;

          if (ageMatchCount <= 0) continue;

          // AGE: aplica nos ingressos mais caros dos participantes qualificados
          let ageApplicableTickets = reservedTickets;
          if (coupon.appliesTo && coupon.appliesTo !== 'all') {
            const allowed = parseAppliesToArray(coupon.appliesTo);
            ageApplicableTickets = reservedTickets.filter((rt: any) => allowed.includes(rt.ticketId));
          }
          const ageApplicableQty = ageApplicableTickets.reduce((s: number, rt: any) => s + rt.quantity, 0);
          const remaining = coupon.maxUsage != null
            ? Math.max(0, coupon.maxUsage - coupon.usageCount)
            : ageMatchCount;
          const effectiveUsage = Math.min(remaining, ageMatchCount, ageApplicableQty);
          if (effectiveUsage <= 0) continue;
          // applyToProducts SÓ nos produtos dos participantes cujo ingresso o cupom AGE cobre.
          const ageApplicableTicketIdSet = new Set<string>(ageApplicableTickets.map((rt: any) => rt.ticketId));
          const ageProductsExtra = coupon.applyToProducts
            ? computeApplicableProductsSubtotal(pricedPendingProducts, participantTicketMap, ageApplicableTicketIdSet)
            : 0;
          couponDiscount = computePartialCouponDiscount(ageApplicableTickets, coupon.type, coupon.value, effectiveUsage, ageProductsExtra);
          couponId = coupon.id;
          couponAppliedToProducts = coupon.applyToProducts;
          break;
        }
      }
    }

    if (effectiveVoucherCode) {
      const voucher = await r.voucher.findUnique({
        where: { code: effectiveVoucherCode.toUpperCase().trim() },
      });
      if (
        voucher &&
        voucher.eventId === order.eventId &&
        voucher.status === 'ACTIVE' &&
        (!voucher.expiryDate || new Date(voucher.expiryDate) > new Date())
      ) {
        // Lista de documento POR PARTICIPANTE (mesma regra do patchCoupon): o ingresso
        // grátis só cai na unidade de um participante elegível. Nenhum elegível → voucher
        // NÃO aplica. Recalculado aqui (momento decisivo do dinheiro).
        let voucherEligibleSlots: Set<number> | undefined;
        let cpfBlocked = false;
        if (voucher.cpfListStatus === 'ENABLED') {
          const totalUnitsPay = reservedTickets.reduce((s: number, rt: any) => s + (rt.quantity ?? 0), 0);
          const slots = computeDocEligibleSlots(participants, voucher.documentList, voucher.cpfList, totalUnitsPay);
          if (slots.length === 0) cpfBlocked = true;
          else voucherEligibleSlots = new Set(slots);
        }
        if (!cpfBlocked) {
          // Voucher = 1 ingresso grátis (a unidade aplicável mais cara), nunca todos.
          // Resolve a cobertura PRIMEIRO — o slot coberto (`qualifyingSlot`) define de qual
          // participante vêm os produtos no escopo de applyToProducts.
          const cov = couponApplicableTicketIds && couponApplicableTicketIds.size > 0
            // Combinado: voucher cobre 1 ingresso entre os NÃO cobertos pelo cupom
            // (0 se nenhum sobrar — o cupom já cobre tudo; não erra no pay).
            ? resolveVoucherCoverage(reservedTickets, voucher.appliesTo, couponApplicableTicketIds, voucherEligibleSlots)
            : resolveVoucherCoverage(reservedTickets, voucher.appliesTo, undefined, voucherEligibleSlots);
          if (!(couponApplicableTicketIds && couponApplicableTicketIds.size > 0) && !cov.hasApplicable) {
            throw new AppUnprocessableException(
              'VOUCHER_NOT_APPLICABLE',
              'Voucher não aplicável aos ingressos do pedido',
            );
          }
          // applyToProducts: cobre também os produtos — SÓ os do participante do ingresso coberto
          // (slot `qualifyingSlot`). Entra NO MÁXIMO uma vez: se o cupom já incluiu os produtos
          // (combinado), o voucher não soma de novo (evita double-count). Espelha o cupom.
          const voucherProductsExtra =
            voucher.applyToProducts && !couponAppliedToProducts
              ? computeSlotParticipantProductsSubtotal(pricedPendingProducts, participants, cov.qualifyingSlot)
              : 0;
          voucherDiscount = cov.discount + voucherProductsExtra;
          // Reserva de uso único: claim ATÔMICO ANTES de cobrar (o bloco do voucher roda antes
          // da chamada à Cielo). Se o voucher já está reservado por outro pedido ativo, NÃO
          // aplicamos o desconto — espelha o recheck de status logo acima e evita cobrar/finalizar
          // com um voucher indisponível (o consumo no finalize abortaria a tx pós-captura).
          const voucherReservedUntil =
            (order.expiresAt as Date | null) ?? new Date(Date.now() + VOUCHER_RESERVATION_FALLBACK_MS);
          if (await claimVoucher(w, voucher.id, orderId, voucherReservedUntil)) {
            voucherId = voucher.id;
            voucherAppliedToProducts = voucher.applyToProducts;
          } else {
            voucherDiscount = 0;
          }
        }
      }
    }

    // Snapshot da taxa de serviço (participantFeePercent congelado no instante do pay):
    // se o admin alterar a config do evento depois, este pedido mantém o que foi cobrado.
    // Base de cálculo: (preDiscountTotal − descontos), em linha com a fórmula acordada
    //   ((ingresso − cupom/voucher) + produto) + % taxa de serviço
    // (ver computeServiceFee, computeFinalAmount e sessão 2026-05-11).
    const participantFeePercent: number =
      (order as any).event?.participantFeePercent ?? 0;
    // Snapshot da taxa do organizador (Podio↔organizador) no MESMO instante — congela a
    // alíquota usada no repasse/financeiro pra este pedido, mesmo que o evento mude depois.
    const organizerFeePercent: number =
      (order as any).event?.organizerFeePercent ?? 0;
    const feeBase = Math.max(0, preDiscountTotal - couponDiscount - voucherDiscount);
    const serviceFee = Math.round(feeBase * (participantFeePercent / 100));

    // finalTotal = (preDiscountTotal − descontos) + serviceFee. A taxa entra na cobrança
    // (Cielo recebe o valor completo) e é gravada em order.serviceFee como snapshot.
    const discountedTotal = feeBase + serviceFee;
    const pixDiscount = 0;
    const finalTotal = discountedTotal;

    // Fragmento de auditoria de desconto para o metadata do pagamento. Persistido em
    // TODOS os métodos (PIX/cartão/débito), inclusive nas confirmações via webhook —
    // o webhook faz spread do metadata existente, então o campo sobrevive ao PAID.
    // Cada chave só aparece quando há o respectivo desconto (ausência = não aplicado);
    // evita gravar lixo e o strip de null do ResponseCompressionInterceptor não interfere.
    const discountMeta: Record<string, any> = {};
    if (couponId) discountMeta.coupon = { id: couponId, applyToProducts: couponAppliedToProducts };
    if (voucherId) discountMeta.voucher = { id: voucherId, applyToProducts: voucherAppliedToProducts };

    // Pedido grátis (voucher 100% ou cupom integral): não chama gateway, finaliza direto.
    // Cielo rejeita amount=0, então qualquer cobrança aqui falharia. Pulamos o gateway,
    // mantemos o método solicitado apenas para fins de relatório (amount=0).
    const isFreeOrder = finalTotal <= 0;

    // 6.8 Prepare payment data
    const user = await r.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true },
    });

    // Identidade enviada ao Cielo (antifraude). Aceita CPF formatado/legacy
    // e o novo documentNumber+documentType. Se for passaporte ou ausente,
    // não setamos identity (Cielo aceita ausência).
    const firstParticipantDoc = resolveDocument(participants[0] ?? {});
    const firstCpf =
      firstParticipantDoc.type === DocumentType.CPF && firstParticipantDoc.clean
        ? firstParticipantDoc.clean
        : undefined;
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

    // Pedidos grátis pulam a validação de cartão — não há cobrança
    if (!isFreeOrder && dto.method === PaymentMethod.CREDIT_CARD) {
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

    if (!isFreeOrder && dto.method === PaymentMethod.DEBIT_CARD) {
      if (!dto.card) {
        throw new AppUnprocessableException('CARD_REQUIRED', 'Card data is required for debit card payments');
      }
      cardData = {
        number: dto.card.number,
        holder: dto.card.name,
        expiry: dto.card.expiry,
        cvv: dto.card.cvv,
        installments: 1,
      };
      if (dto.threeDs) {
        threedsData = {
          cavv: dto.threeDs.cavv,
          eci: dto.threeDs.eci,
          xid: dto.threeDs.xid,
          version: dto.threeDs.version ?? '2',
          referenceId: dto.threeDs.referenceId,
        };
      }
    }

    // 6.9 Call Cielo (skipped para pedidos grátis — Cielo rejeita amount=0)
    let cieloResult: any;
    let paymentFailed = false;
    if (isFreeOrder) {
      cieloResult = {
        success: true,
        paymentId: null,
        cieloStatus: 'PaymentConfirmed',
        authorizationCode: null,
        proofOfSale: null,
        cardBrand: null,
      };
    } else {
    try {
      let debitReturnUrl: string | undefined;
      if (dto.method === PaymentMethod.DEBIT_CARD && !threedsData) {
        const serverUrl = (process.env.SERVER_URL ?? '').replace(/\/$/, '');
        if (!serverUrl || !serverUrl.startsWith('http')) {
          throw new AppUnprocessableException(
            'SERVER_URL_REQUIRED',
            'SERVER_URL environment variable must be set to a valid HTTP(S) URL to use debit card without pre-authenticated 3DS',
          );
        }
        debitReturnUrl = `${serverUrl}/api/v1/payments/3ds-callback?orderId=${orderId}`;
      }

      // Customer.Name é OBRIGATÓRIO no Cielo (erro 105 "Customer Name is required",
      // inclusive em PIX). O comprador pode estar sem firstName/lastName preenchidos
      // (ex.: conta criada por fluxo que não exige nome) — então caímos no nome do
      // 1º participante e, em último caso, num rótulo genérico, para nunca enviar vazio.
      const customerName =
        `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim()
        || (participants[0]?.name ?? '').toString().trim()
        || 'Cliente';

      cieloResult = await this.cieloService.createPayment(
        finalTotal,
        'BRL',
        dto.method,
        merchantOrderId,
        {
          name: customerName,
          email: user?.email,
          identity: firstCpf,
          identityType: firstCpf ? 'CPF' : undefined,
        },
        cardData,
        cardTokenData,
        threedsData,
        debitReturnUrl,
      );
      if (!cieloResult.success) {
        paymentFailed = true;
      }
    } catch (err: any) {
      this.logger.warn(`Payment failed for order ${orderId}: ${err.message}`);
      paymentFailed = true;
      cieloResult = { success: false, error: err.message };
    }
    } // fim do else (não-free)

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
    // Para pedidos grátis pulamos o QR — vai direto pro finalize.
    if (dto.method === PaymentMethod.PIX && !isFreeOrder) {
      const newExpiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000);

      await w.$transaction(async (tx: any) => {
        await tx.order.update({
          where: { id: orderId },
          data: {
            expiresAt: newExpiresAt,
            discount: couponDiscount + voucherDiscount,
            serviceFee,
            participantFeePercent,
            organizerFeePercent,
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
              ...discountMeta,
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
              ...discountMeta,
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

    // 6.11.5 DEBIT_CARD: bank requested 3DS authentication — store pending payment, return redirectUrl
    // Pedidos grátis nunca passam por aqui (cieloResult.authenticationUrl é undefined no stub).
    if (dto.method === PaymentMethod.DEBIT_CARD && cieloResult.authenticationUrl && !isFreeOrder) {
      const newExpiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000);

      await w.$transaction(async (tx: any) => {
        await tx.order.update({
          where: { id: orderId },
          data: {
            expiresAt: newExpiresAt,
            discount: couponDiscount + voucherDiscount,
            serviceFee,
            participantFeePercent,
            organizerFeePercent,
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
            method: PaymentMethod.DEBIT_CARD,
            status: PaymentStatus.PENDING,
            amount: finalTotal,
            transactionId: cieloResult.paymentId ?? null,
            metadata: {
              cieloPaymentId: cieloResult.paymentId,
              debitCard: {
                brand: cieloResult.cardBrand ?? null,
                last4Digits: dto.card!.number.replace(/\s/g, '').slice(-4),
                holder: dto.card!.name,
              },
              ...discountMeta,
            },
          },
          update: {
            status: PaymentStatus.PENDING,
            amount: finalTotal,
            transactionId: cieloResult.paymentId ?? null,
            metadata: {
              cieloPaymentId: cieloResult.paymentId,
              debitCard: {
                brand: cieloResult.cardBrand ?? null,
                last4Digits: dto.card!.number.replace(/\s/g, '').slice(-4),
                holder: dto.card!.name,
              },
              ...discountMeta,
            },
          },
        });
      });

      const body = {
        orderId,
        status: 'PENDING',
        payment: {
          method: PaymentMethod.DEBIT_CARD,
          status: 'pending',
          redirectUrl: cieloResult.authenticationUrl,
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

    // 6.13 Pré-carregar o evento para o e-mail de confirmação (fora da tx p/ não
    // bloquear locks). Os snapshots de ingresso/produto/recibo são montados dentro
    // do finalize compartilhado (OrderFinalizationService), que carrega o que precisa.
    const snapshotEvent = await r.event.findUnique({
      where: { id: order.eventId },
      select: {
        id: true, name: true, slug: true, description: true,
        eventDate: true, registrationStartDate: true, registrationEndDate: true,
        location: true, city: true, state: true, country: true, zipCode: true, neighborhood: true,
        googleMapsLink: true, bannerUrl: true, logoUrl: true,
        // Só o necessário pro e-mail de confirmação (nome/logo) — sem contato.
        organization: { select: { id: true, name: true, logoUrl: true } },
      },
    });

    // 6.14 Finalize: mark PAID, create Payment, create Registrations
    let registrations: any[];
    try {
      registrations = await w.$transaction(async (tx: any) => {
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
          serviceFee,
          participantFeePercent,
          organizerFeePercent,
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
          ...discountMeta,
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

      return await this.orderFinalization.finalizePaidOrder(tx, orderId);
      }, { timeout: 30000, maxWait: 10000 });
    } catch (e: unknown) {
      // Finalize abortado PÓS-CAPTURA (ex.: voucher consumido por outro pedido na janela
      // entre a autorização e o finalize): a tx deu rollback (pedido volta a PENDING, sem
      // Payment), mas o dinheiro JÁ foi capturado na Cielo → VOID imediato + 422 amigável.
      // Sem o void, o cliente ficava cobrado sem ingresso e sem estorno.
      if (e instanceof OrderFinalizationAbortError) {
        if (cieloResult.paymentId) {
          await this.cieloService.cancelPayment(cieloResult.paymentId).catch((voidErr: any) => {
            this.logger.error(
              `[PAY-ABORT] VOID falhou para payment ${cieloResult.paymentId} (order ${orderId}, ${e.code}): ${voidErr?.message ?? voidErr} — estornar manualmente`,
            );
          });
        }
        throw new AppUnprocessableException(e.code, e.friendlyMessage);
      }
      throw e;
    }

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

        // Comprador = DONO do pedido (order.userId). NUNCA usar
        // `regs.find(r => r.user?.email)` — isso pega a primeira inscrição com
        // conta, que pode ser o terceiro quando o comprador compra pra outra
        // pessoa, invertendo quem recebe os PDFs e o badge "inscrição feita por".
        const buyerUserIdForPdf = order.userId as string | undefined;

        const ticketPdfData = {
          orderId,
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
            // Sempre usa reg.user como fallback dos dados do participante.
            // Convidado COM conta tem participantEmail/Cpf null mas os dados
            // ficam em reg.user — zerar o user (gate isBuyerReg antigo) escondia
            // a secao "Informacoes do participante" no PDF do terceiro.
            const user = reg.user ?? {};
            const ticket = reg.tickets?.[0]?.ticket;
            const catName = ticket?.category?.name ?? '';
            const ticketName = ticket?.name ?? '';
            const fullTicketName = catName && ticketName && catName !== ticketName
              ? `${catName} - ${ticketName}` : ticketName || catName;
            return {
              index: idx + 1,
              qrCode: reg.qrCode ?? reg.id,
              participantName: (reg.participantName ?? `${(reg.user ?? {}).firstName ?? ''} ${(reg.user ?? {}).lastName ?? ''}`.trim()) || 'Participante',
              ticketName: fullTicketName,
              email: reg.participantEmail ?? user.email,
              cpf: reg.participantCpf ?? user.documentNumber,
              /* Nacionalidade pra decidir label (CPF/Documento) e formatacao
               * do telefone. Prioridade:
               *   1. snapshot.participant.country — escolha por-participante
               *      no checkout (futuro: front mandar no patchParticipants).
               *   2. order.billingCountry — nacionalidade do checkout (pais
               *      escolhido no step de endereco/billing).
               *   3. reg.user.country — perfil base (fallback, NAO billing).
               *
               * billingCountry tem prioridade sobre user.country porque o user
               * pode estar com country desatualizado/default, enquanto a
               * escolha do checkout reflete intencao da compra. */
              country:
                (reg.receiptSnapshot as any)?.participant?.country
                ?? order.billingCountry
                ?? reg.user?.country
                ?? null,
              documentType:
                (reg.receiptSnapshot as any)?.participant?.documentType
                ?? reg.user?.documentType
                ?? null,
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

        const eventName = snapshotEvent.name;
        const eventDate = formatEventDate(snapshotEvent.eventDate ?? (event as any).eventDate);
        const eventBannerUrl = (snapshotEvent as any).logoUrl || (snapshotEvent as any).bannerUrl || '';

        // Comprador = dono do pedido. Pode nao ser participante (comprou so pra
        // terceiros) — nesse caso busca o user direto, ja que nao ha inscricao
        // com esse userId.
        let emailBuyer = regs.find((r: any) => r.user?.id === order.userId)?.user;
        if (!emailBuyer && order.userId) {
          emailBuyer = await r2.user.findUnique({
            where: { id: order.userId },
            select: { id: true, email: true, firstName: true, lastName: true },
          });
        }
        const buyerEmail: string | undefined = emailBuyer?.email;

        // Gerar PDF individual por participante (sequencial — yoga-layout)
        const individualPdfs: Array<{ pdf: Buffer | undefined; participantEmail: string | undefined; participantName: string }> = [];
        for (const [idx, reg] of regs.entries()) {
          const participantEmail: string | undefined = reg.participantEmail ?? reg.user?.email;
          const participantName: string = (reg.participantName
            ?? `${reg.user?.firstName ?? ''} ${reg.user?.lastName ?? ''}`.trim())
            || 'Participante';
          const regEntry = ticketPdfData.registrations[idx];
          if (!regEntry) { individualPdfs.push({ pdf: undefined, participantEmail, participantName }); continue; }
          const singlePdfData = {
            ...ticketPdfData,
            event: { ...ticketPdfData.event, participantCount: 1 },
            registrations: [{ ...regEntry, index: 1 }],
          };
          const pdf = await this.ticketPdfService.generateTicketPdf(singlePdfData)
            .catch((e: any) => { this.logger.warn(`PDF individual falhou para ${participantName}:`, e?.message); return undefined; });
          individualPdfs.push({ pdf, participantEmail, participantName });
        }

        // Comprador recebe todos os PDFs individuais como anexos separados
        if (buyerEmail) {
          const buyerPdfs = individualPdfs
            .filter(p => p.pdf)
            .map(p => ({ buffer: p.pdf as Buffer, participantName: p.participantName }));
          await this.emailService.sendRegistrationConfirmed({
            email: buyerEmail,
            firstName: emailBuyer?.firstName || 'Participante',
            eventName,
            eventLocation: location,
            eventDate,
            eventAddress: location,
            eventBannerUrl,
            ticketPdfs: buyerPdfs,
          }).catch((err: any) => this.logger.warn('Email comprador falhou:', err));
        }

        // Participantes não-compradores recebem apenas seu próprio ingresso
        const invitedByFullName = `${emailBuyer?.firstName ?? ''} ${emailBuyer?.lastName ?? ''}`.trim();
        for (const p of individualPdfs) {
          if (!p.participantEmail || p.participantEmail === buyerEmail) continue;
          await this.emailService.sendRegistrationConfirmed({
            email: p.participantEmail,
            firstName: p.participantName.split(' ')[0] || 'Participante',
            eventName,
            eventLocation: location,
            eventDate,
            eventAddress: location,
            eventBannerUrl,
            invitedByName: invitedByFullName || undefined,
            ticketPdfs: p.pdf ? [{ buffer: p.pdf, participantName: p.participantName }] : [],
          }).catch((err: any) => this.logger.warn(`Email participante ${p.participantEmail} falhou:`, err));
        }
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
    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (order.userId !== userId && !await this.isAdminUser(userId)) {
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

    // Janela de GRAÇA pra pedido com PAGAMENTO EM ANDAMENTO (Payment PENDING = PIX/3DS
    // aguardando confirmação assíncrona): cancelar cedo demais abria a corrida "webhook
    // tardio em pedido CANCELLED" — estoque devolvido (e revendível) com o cliente cobrado.
    // Pedido com Payment PAID NUNCA é cancelado pelo cron (finalize em voo na mesma tx).
    // Confirmações que chegarem DEPOIS da graça caem na compensação automática
    // (PaymentCompensationService → estorno) — a graça só reduz a frequência disso.
    const now = new Date();
    const PAYMENT_IN_FLIGHT_GRACE_MS = 2 * 60 * 60 * 1000; // 2h
    const paymentGraceCutoff = new Date(now.getTime() - PAYMENT_IN_FLIGHT_GRACE_MS);

    const expired = await w.order.findMany({
      where: {
        status: 'PENDING',
        OR: [
          // Nunca tentou pagar → expira no prazo normal.
          { expiresAt: { lte: now }, payment: null },
          // Tentativa falhou/estornada → expira no prazo normal.
          { expiresAt: { lte: now }, payment: { is: { status: { in: ['FAILED', 'REFUNDED'] } } } },
          // Pagamento EM VOO (PIX/3DS pendente) → só expira após a janela de graça.
          { expiresAt: { lte: paymentGraceCutoff }, payment: { is: { status: 'PENDING' } } },
        ],
      },
      select: {
        id: true,
        userId: true,
        eventId: true,
        finalAmount: true,
        billingPostalCode: true,
        reservedTickets: { select: { batchId: true, quantity: true } },
      },
    });

    if (!expired.length) return 0;

    // Telemetria de funil: pedido expirado = carrinho ABANDONADO (a métrica de drop-off
    // mais valiosa). `reachedBilling` distingue quem parou antes vs depois do endereço.
    // Push em buffer, fail-open — nunca quebra o cron.
    const trackExpired = (order: { id: string; userId: string; eventId: string; finalAmount: number | null }, reachedBilling: boolean) => {
      try {
        this.activity.record({
          userId: order.userId,
          source: UserActivitySource.BACKEND,
          category: UserActivityCategory.CHECKOUT,
          action: 'order.expired',
          metadata: {
            orderId: order.id,
            eventId: order.eventId,
            finalAmount: order.finalAmount ?? 0,
            reachedBilling,
          },
        });
      } catch {
        // Telemetria nunca quebra o cron de expiração.
      }
    };

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
            // Libera a reserva de voucher (carrinho abandonado): volta o voucher pra disponível.
            await releaseVoucherByOrder(tx, order.id);
          });
          cancelled++;
          trackExpired(order, reachedBilling);
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
          // `reservedByOrderId` não é FK (sem cascade) → libera ANTES de deletar o pedido,
          // senão o voucher ficaria preso à reserva de um pedido inexistente até `reservedUntil`.
          await releaseVoucherByOrder(tx, order.id);
          await tx.order.delete({ where: { id: order.id } });
        });
        cancelled++;
        trackExpired(order, reachedBilling);
        this.logger.debug(`Deleted incomplete expired order ${order.id}`);
      }
    }

    return cancelled;
  }

  // ── dev helpers (non-production only) ────────────────────────────────────

  async forceExpire(userId: string, orderId: string): Promise<{ message: string }> {
    const w: any = this.prisma.getWriteClient();
    const order = await w.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (order.userId !== userId && !await this.isAdminUser(userId)) {
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
    // PRIMARY (write client) de propósito: todo caller é read-modify-write (patchParticipants,
    // removeReservedSlot, patchCoupon, patchProducts, patchBilling). Ler da RÉPLICA aqui causa
    // decisão sobre dado defasado — ex.: após DELETE de slot (primary = 2 ingressos), o
    // PATCH /participants lia 3 da réplica e re-preenchia pendingParticipants/totalAmount errado.
    // A réplica não é sincronizada em dev e pode ter lag em prod.
    const w: any = this.prisma.getWriteClient();
    const order = await w.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (order.userId !== userId && !await this.isAdminUser(userId)) {
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

  /**
   * Reserva (claim ATÔMICO) o voucher `newVoucherId` para o pedido, liberando antes qualquer
   * reserva anterior que ESTE pedido mantivesse num voucher DIFERENTE (troca/remoção). Garante
   * uso único: enquanto um pedido ativo detém a reserva, o mesmo voucher não pode ser aplicado a
   * outro pedido. Retorna `false` quando o voucher já está reservado por outro pedido ativo —
   * o caller decide a rejeição (suave no patchCoupon; "não aplica" no pay).
   *
   * `newVoucherId` null = sem voucher (só assegura a liberação da reserva anterior → retorna true).
   * `reservedUntil` = `order.expiresAt` (rede de segurança: reserva vencida é tratada como livre).
   */
  private async reserveVoucherForOrder(
    client: any,
    order: any,
    newVoucherId: string | null,
  ): Promise<boolean> {
    const oldVoucherId = (order.voucherId as string | null) ?? null;
    if (oldVoucherId && oldVoucherId !== newVoucherId) {
      await releaseVoucherByOrder(client, order.id);
    }
    if (!newVoucherId) return true;
    const reservedUntil =
      (order.expiresAt as Date | null) ?? new Date(Date.now() + VOUCHER_RESERVATION_FALLBACK_MS);
    return claimVoucher(client, newVoucherId, order.id, reservedUntil);
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
        // Libera a reserva de voucher do pedido cancelado → volta disponível pra outro pedido.
        await releaseVoucherByOrder(tx, orderId);
      });
    }
  }

  async get3dsToken(userId: string, orderId: string): Promise<{ accessToken: string }> {
    const order = await this.prisma.getReadClient().order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true, status: true },
    });

    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new NotFoundException('Order not found');
    if (order.status !== 'PENDING') {
      throw new BadRequestException('3DS token só pode ser obtido para pedidos PENDING');
    }

    try {
      const accessToken = await this.cieloService.get3dsAccessToken();
      return { accessToken };
    } catch (err: any) {
      this.logger.error(`Falha ao obter 3DS token para order ${orderId}: ${err.message}`);
      throw new BadRequestException('Não foi possível obter o token 3DS. Verifique as credenciais CIELO_3DS_CLIENT_ID e CIELO_3DS_CLIENT_SECRET.');
    }
  }
}
