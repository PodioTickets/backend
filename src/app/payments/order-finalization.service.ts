/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  DocumentType,
  RegistrationStatus,
  UserActivityCategory,
  UserActivitySource,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UserActivityService } from '../../common/services/user-activity.service';

/**
 * Aborto TIPADO do finalize pós-captura: o pagamento já foi capturado no gateway, mas o
 * pedido NÃO pode ser entregue (voucher consumido por outro pedido, participantes vazios).
 * O throw força o rollback da tx do caller (correto — nada é meio-entregue) e o tipo permite
 * ao caller distinguir de erros genéricos e disparar a COMPENSAÇÃO (estorno automático via
 * `PaymentCompensationService`) em vez de propagar 500 — antes, o webhook devolvia 500 pra
 * Cielo, que reentregava para sempre, deixando o cliente pago sem ingresso e sem estorno.
 */
export class OrderFinalizationAbortError extends Error {
  constructor(
    public readonly code: 'VOUCHER_CONSUMED' | 'EMPTY_PARTICIPANTS',
    public readonly orderId: string,
    public readonly friendlyMessage: string,
  ) {
    super(`${code}: ${friendlyMessage} (order ${orderId})`);
    this.name = 'OrderFinalizationAbortError';
  }
}
import { resolveDocument } from '../../common/utils/document.util';
import { resolveProductUnitPrice } from '../../common/utils/product-price.util';
import {
  incrementVariationSold,
  decrementVariationSold,
  releaseVariationHold,
} from '../../common/utils/product-stock.util';
import { computeCouponCoveredUnits } from '../../common/utils/coupon-eligibility.util';
import { tryConsumeVoucher } from '../../common/utils/voucher-reservation.util';

/**
 * Casa um item de `pendingProducts` com um SLOT (participante↔ingresso) na materialização
 * das inscrições. Slot-aware: quando o item traz `participantIndex` (pedidos novos), casa
 * pelo ÍNDICE do slot — isso resolve o bug de 2 participantes com o MESMO e-mail (mesma
 * pessoa em 2 ingressos), que pelo match por e-mail colapsava TODOS os produtos na 1ª
 * inscrição e deixava a 2ª vazia. Legado (item sem índice): casa por e-mail (case-insensitive).
 *
 * Puro/sem estado — a deduplicação "1 item → no máx. 1 inscrição" é feita pelo chamador
 * (consumedProductIdx), que garante o first-wins por slot no caminho legado por e-mail.
 */
export function productMatchesSlot(
  item: { participantIndex?: number | null; participantEmail?: string | null } | null | undefined,
  slotIndex: number,
  slotEmail: string | null | undefined,
): boolean {
  if (!item) return false;
  if (typeof item.participantIndex === 'number') {
    return item.participantIndex === slotIndex;
  }
  return (
    (item.participantEmail ?? '').toLowerCase() === (slotEmail ?? '').toLowerCase()
  );
}

/**
 * Finalize compartilhado de pedido PAGO — fonte ÚNICA de verdade.
 *
 * Antes, só o pagamento por CARTÃO À VISTA finalizava (inline no `OrdersService.pay`):
 * deletava os placeholders PENDING e criava as inscrições definitivas a partir de
 * `order.pendingParticipants`/`pendingProducts`, com snapshot de ingresso/produto/recibo,
 * qrCode e aplicação de uso de cupom/voucher. PIX e 3DS (débito) retornavam antes e eram
 * "finalizados" no webhook, que apenas marcava `status = CONFIRMED` — deixando as inscrições
 * VAZIAS (sem participante, sem produtos, sem snapshot → PDF caía no comprador para todos).
 *
 * Este serviço extrai esse finalize para ser chamado tanto pelo `pay()` do cartão quanto
 * pelo webhook (PIX + 3DS). Depende apenas do `PrismaService` (sem acoplar a OrdersService),
 * evitando o ciclo OrdersModule → PaymentsModule.
 *
 * CONTRATO:
 * - DEVE rodar dentro de uma transação (`tx`).
 * - O caller já deve ter vencido a transição atômica PENDING→PAID do `Order` (garante
 *   execução única; nunca finaliza o mesmo pedido duas vezes) e já deve ter persistido os
 *   campos financeiros (`discount`/`serviceFee`/`finalAmount`/`totalAmount`/`couponId`/`voucherId`).
 * - Lê tudo do pedido persistido — não depende de variáveis locais do fluxo de pagamento.
 */
@Injectable()
export class OrderFinalizationService {
  private readonly logger = new Logger(OrderFinalizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: UserActivityService,
  ) {}

  /**
   * Promove o Order PENDING→PAID de forma ATÔMICA e, se foi este caller quem venceu a
   * transição, finaliza (cria inscrições + aplica cupom/voucher). FONTE ÚNICA usada por
   * webhook (PIX), 3DS e polling — antes cada caminho duplicava esse trecho (e o polling
   * nem chamava o finalize, deixando inscrições vazias e o Order preso em PENDING).
   *
   * @returns `{ finalized }` — true se ESTE caller promoveu+finalizou; false se o pedido
   *          já não estava PENDING (outro caminho/entrega dupla já finalizou) → idempotente.
   */
  async confirmAndFinalizeOrder(
    tx: any,
    orderId: string,
  ): Promise<{ finalized: boolean; registrations: any[]; orderStatus?: string }> {
    const rows: any[] = await tx.$queryRaw`
      UPDATE "Order"
      SET "status" = 'PAID'::"OrderStatus", "updatedAt" = NOW()
      WHERE id = ${orderId}::uuid AND "status" = 'PENDING'::"OrderStatus"
      RETURNING id
    `;
    if (!rows?.length) {
      // Expõe o status atual pro caller distinguir entrega dupla benigna (já PAID) de
      // pagamento confirmado TARDE DEMAIS (CANCELLED pelo cron de expiração) — este último
      // exige compensação (estorno automático), senão o cliente fica pago sem ingresso.
      const current = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
      this.logger.warn(
        `confirmAndFinalizeOrder: order ${orderId} não estava PENDING (status=${current?.status ?? 'inexistente'}) — finalize ignorado (idempotência)`,
      );
      return { finalized: false, registrations: [], orderStatus: current?.status };
    }
    const registrations = await this.finalizePaidOrder(tx, orderId);
    return { finalized: true, registrations };
  }

  /**
   * Reverte os efeitos colaterais de venda quando um pedido é estornado OU sofre
   * chargeback. FONTE ÚNICA usada por `PaymentsRefundService` (estorno proativo) e
   * `PaymentsChargebackService` (reversão pelo emissor) — antes só o refund revertia,
   * deixando o chargeback com cupom/voucher consumidos indevidamente.
   *
   * - Cupom: decrementa o MESMO que o finalize incrementou — QUANTITY: −1; demais
   *   (DISCOUNT/AGE): −nº de ingressos cobertos (`computeCouponCoveredUnits`, fonte única
   *   com o finalize; o `GREATEST(0,...)` protege o raro caso de cupom capado na compra).
   * - Voucher: libera USED→ACTIVE somente se foi ESTE usuário quem o consumiu
   *   (`usedBy`) — evita "roubar" de volta um voucher consumido por outra order.
   *
   * Deve rodar dentro de uma transação (`tx`). Idempotente o suficiente: chamado após o
   * caller vencer a transição de status do payment (guard de count==0 no caller).
   */
  async reverseSaleSideEffects(tx: any, orderId: string): Promise<void> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        userId: true,
        couponId: true,
        couponReservedUnits: true,
        voucherId: true,
        reservedTickets: true,
        pendingParticipants: true,
        coupon: {
          select: {
            couponType: true,
            appliesTo: true,
            cpfListStatus: true,
            documentList: true,
            cpfList: true,
            minAge: true,
            maxAge: true,
          },
        },
        event: { select: { eventDate: true } },
        voucher: { select: { status: true } },
      },
    });
    if (!order) return;

    if (order.couponId) {
      // Decrementa EXATAMENTE o que o finalize incrementou. Autoridade = as unidades
      // RESERVADAS no pay (couponReservedUnits) — o mesmo valor que o finalize somou ao
      // usageCount. Fallback p/ pedidos LEGADOS (sem reserva, couponReservedUnits null):
      // recomputa via fonte única computeCouponCoveredUnits (QUANTITY: 1; DISCOUNT/AGE: nº de
      // ingressos cobertos), com piso 1. GREATEST(0,...) no SQL protege contra under/over-flow.
      const reserved = (order as any).couponReservedUnits as number | null;
      const ageRefDate = order.event?.eventDate ? new Date(order.event.eventDate) : new Date();
      const decrement = reserved != null
        ? reserved
        : Math.max(
            1,
            computeCouponCoveredUnits(
              order.coupon,
              (order.reservedTickets as any[]) ?? [],
              (order.pendingParticipants as any[]) ?? [],
              ageRefDate,
            ),
          );
      if (decrement > 0) {
        await tx.$executeRaw`
          UPDATE "Coupon"
          SET "usageCount" = GREATEST(0, "usageCount" - ${decrement}),
              "updatedAt" = NOW()
          WHERE id = ${order.couponId}::uuid
        `;
      }
    }

    if (order.voucherId) {
      // Libera USED→ACTIVE e zera a reserva — o voucher volta totalmente disponível.
      await tx.voucher.updateMany({
        where: { id: order.voucherId, status: 'USED', usedBy: order.userId },
        data: {
          status: 'ACTIVE',
          usedAt: null,
          usedBy: null,
          reservedByOrderId: null,
          reservedUntil: null,
          updatedAt: new Date(),
        },
      });
    }

    // Reverte estoque/venda das variações de produto (estorno + chargeback usam este ponto).
    // soldCount-- SEMPRE; availableStock++ só para itens que seguraram estoque (verdade
    // congelada em productSnapshot.stockHeld; fallback p/ regra LEGADA em pedidos antigos).
    const regProducts = await tx.registrationProduct.findMany({
      where: { registration: { orderId } },
      select: { variationId: true, quantity: true, productSnapshot: true },
    });
    for (const rp of regProducts) {
      if (!rp.variationId) continue;
      const qty = rp.quantity ?? 1;
      await decrementVariationSold(tx, rp.variationId, qty);
      const snap = (rp.productSnapshot as any) ?? {};
      const held =
        typeof snap.stockHeld === 'boolean'
          ? snap.stockHeld
          // Fallback p/ snapshots ANTIGOS (pré-feature de estoque em incluso+obrigatório):
          // aplica a regra LEGADA — naquela época incluso+obrigatório NÃO segurava
          // estoque, então NÃO restaura availableStock (evita vazar estoque que o
          // pedido nunca reservou). Pedidos novos sempre têm `stockHeld` congelado.
          : !(snap.isIncludedInTicket === true && snap.isRequired === true);
      // releaseVariationHold tem guard `stock > 0` → no-op seguro p/ variação ilimitada.
      if (held) {
        await releaseVariationHold(tx, rp.variationId, qty);
      }
    }
  }

  /**
   * Cria as inscrições definitivas do pedido e aplica o uso de cupom/voucher.
   * @param tx client da transação ativa (write).
   * @param orderId pedido já promovido a PAID pelo caller.
   * @returns inscrições criadas (`{ id, qrCode, status }`).
   */
  async finalizePaidOrder(tx: any, orderId: string): Promise<any[]> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        reservedTickets: true,
        coupon: true,
        voucher: true,
        event: { include: { organization: true } },
      },
    });
    if (!order) {
      this.logger.warn(`finalizePaidOrder: order ${orderId} não encontrado — nada a fazer`);
      return [];
    }

    const userId: string = order.userId;
    const reservedTickets: any[] = order.reservedTickets ?? [];
    const participants: any[] = (order.pendingParticipants as any[] | null) ?? [];
    const pendingProducts: any[] = (order.pendingProducts as any[] | null) ?? [];
    const snapshotEvent: any = order.event ?? null;

    if (participants.length === 0) {
      // Sem participantes preenchidos não há como criar inscrições reais. Não deveria
      // ocorrer pós-checkout (o pay exige participantes), mas é alcançável por corrida:
      // patch esvazia participantes enquanto um PIX está pendente e o webhook confirma
      // depois. ABORTA (rollback) em vez de deixar Order/Payment PAID sem inscrição —
      // o caller compensa com estorno automático. (O script reconcile-orphan-orders
      // pula pedidos sem participantes ANTES de chamar este finalize — não é afetado.)
      this.logger.error(
        `finalizePaidOrder: order ${orderId} sem pendingParticipants — finalize abortado (requer estorno)`,
      );
      throw new OrderFinalizationAbortError(
        'EMPTY_PARTICIPANTS',
        orderId,
        'Pedido sem participantes preenchidos no momento da confirmação do pagamento.',
      );
    }

    // Valores financeiros do snapshot vêm do pedido já persistido (congelados no pay).
    // productsSubtotal é derivado do invariante totalAmount = ticketsSubtotal +
    // productsSubtotal (mesma conta de getOrderDetails) — garante que o snapshot
    // reflete EXATAMENTE o que foi cobrado, sem depender de drift de preço no
    // pendingProducts.unitPrice entre o checkout e o pagamento.
    const ticketsSubtotal = reservedTickets.reduce(
      (s: number, rt: any) => s + (rt.unitPrice ?? 0) * (rt.quantity ?? 0),
      0,
    );
    const productsSubtotal = Math.max(0, (order.totalAmount ?? 0) - ticketsSubtotal);
    const discount = order.discount ?? 0;
    const pixDiscount = 0;
    const finalTotal = order.finalAmount ?? 0;
    // Flags efetivamente aplicadas = do cupom/voucher gravados no pedido (applyToProducts).
    const couponAppliedToProducts = order.coupon?.applyToProducts ?? false;
    const voucherAppliedToProducts = order.voucher?.applyToProducts ?? false;

    // Dados de referência para o snapshot (read-only; não mutados nesta tx).
    const r: any = this.prisma.getReadClient();
    const ticketIds = [...new Set(reservedTickets.map((rt: any) => rt.ticketId as string))];
    const [snapshotTickets, snapshotQuestions] = await Promise.all([
      r.ticket.findMany({
        where: { id: { in: ticketIds } },
        include: {
          category: { select: { id: true, name: true } },
          // TicketBatch não tem coluna `name` — não selecionar. O snapshot abaixo
          // referencia `batchData.name` (sempre undefined → dropado pelo JSON.stringify);
          // mantido por fidelidade com o finalize original do cartão.
          batches: { select: { id: true, price: true, sortOrder: true } },
        },
      }),
      r.question.findMany({
        where: { eventId: order.eventId, isActive: true },
        select: { id: true, question: true, description: true, type: true, options: true, isRequired: true },
      }),
    ]);
    const snapshotTicketById = new Map<string, any>(snapshotTickets.map((t: any) => [t.id, t]));
    const snapshotQuestionById = new Map<any, any>(snapshotQuestions.map((q: any) => [q.id, q]));

    // ── Aplicar uso de cupom (atômico — evita corrida entre pedidos concorrentes) ──
    if (order.couponId) {
      const couponForUsage = await tx.coupon.findUnique({
        where: { id: order.couponId },
        select: { couponType: true, maxUsage: true, usageCount: true },
      });

      // CAMINHO RESERVADO (pedidos novos): o pay já RESERVOU `couponReservedUnits` sob row-lock,
      // garantindo sala dentro do maxUsage. Aqui apenas convertemos reserva → uso: incrementa
      // o usageCount no MESMO valor reservado. Ao virar PAID nesta tx, o pedido sai da SUM de
      // reservas e o usageCount sobe o equivalente → invariante (committed + reservado ≤ maxUsage)
      // preservado, SEM risco de ultrapassar. Não precisa de cap LEAST: a sala já está garantida.
      const reservedUnits = (order as any).couponReservedUnits as number | null;
      if (reservedUnits != null) {
        if (reservedUnits > 0) {
          await tx.$executeRaw`
            UPDATE "Coupon"
            SET "usageCount" = "usageCount" + ${reservedUnits}, "updatedAt" = NOW()
            WHERE id = ${order.couponId}::uuid
          `;
        }
        // reservedUnits === 0 → cupom não concedeu unidades (esgotado no pay); nada a contabilizar.
      } else if (couponForUsage?.couponType === 'QUANTITY') {
        // QUANTITY: all-or-nothing — check-and-increment atômico
        const rows: any[] = await tx.$queryRaw`
          UPDATE "Coupon"
          SET "usageCount" = "usageCount" + 1
          WHERE id = ${order.couponId}::uuid
            AND ("maxUsage" IS NULL OR "usageCount" + 1 <= "maxUsage")
          RETURNING id
        `;
        if (rows.length === 0) {
          throw new BadRequestException('Cupom esgotado. Prossiga sem desconto ou escolha outro cupom.');
        }
      } else {
        // Fix #13: DISCOUNT/AGE — UPDATE atômico com LEAST para evitar race condition.
        // O delta é calculado a partir dos slots cobertos (fonte única computeCouponCoveredUnits),
        // mas o cap em maxUsage é feito DENTRO do UPDATE via LEAST, eliminando a race condition
        // entre a leitura de usageCount e o UPDATE que existia antes.
        const ageRefDate = order.event?.eventDate ? new Date(order.event.eventDate) : new Date();
        const delta = computeCouponCoveredUnits(order.coupon, reservedTickets, participants, ageRefDate);
        if (delta > 0) {
          await tx.$executeRaw`
            UPDATE "Coupon"
            SET "usageCount" = LEAST("usageCount" + ${delta}, COALESCE("maxUsage", "usageCount" + ${delta})),
                "updatedAt" = NOW()
            WHERE id = ${order.couponId}::uuid
          `;
        }
      }
    }

    // ── Consumir voucher — atômico ACTIVE → USED, ESCOPADO à reserva deste pedido ──
    // Uso único de verdade: o voucher só é consumido se ESTE pedido detinha a reserva (ou se
    // estava livre — caso de pedido legado anterior à reserva). Se outro pedido já o consumiu,
    // `tryConsumeVoucher` retorna false e ABORTAMOS o finalize (throw → rollback da tx), em vez
    // de conceder o ingresso grátis duas vezes (o comportamento antigo apenas logava e seguia).
    // Para PIX/webhook/R$0 concorrentes, isso fecha o furo de double-use no momento decisivo.
    if (order.voucherId) {
      const consumed = await tryConsumeVoucher(tx, order.voucherId, orderId, userId);
      if (!consumed) {
        // Pagamento já capturado mas voucher indisponível → erro TIPADO pro caller
        // compensar (estorno automático). Antes era BadRequestException genérica: o
        // webhook propagava 500 pra Cielo → reentrega infinita, cliente pago sem
        // ingresso e sem estorno.
        this.logger.error(
          `[VOUCHER-DOUBLE-USE] finalize abortado: voucher ${order.voucherId} já consumido por outro pedido (order ${orderId}) — pagamento requer estorno`,
        );
        throw new OrderFinalizationAbortError(
          'VOUCHER_CONSUMED',
          orderId,
          'Este voucher já foi utilizado em outro pedido e não pode ser aplicado novamente.',
        );
      }
    }

    // Remove placeholders PENDING criados na reserva
    await tx.registration.deleteMany({
      where: { orderId, status: RegistrationStatus.PENDING },
    });

    // Cria Registrations a partir de pendingParticipants
    const createdRegs: any[] = [];
    const buyerUser = await tx.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const frontendUrl = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');

    // Cada item de pendingProducts materializa NO MÁXIMO um RegistrationProduct. Sem este
    // controle, comprador com o MESMO e-mail em 2 slots (2 ingressos pra si) fazia o filtro
    // por participantEmail casar o mesmo item em AMBAS as inscrições → produto cobrado 1x e
    // entregue 2x. First-wins na ordem dos slots (consistente com buildParticipantTicketMap).
    const consumedProductIdx = new Set<number>();

    let pIdx = 0;
    for (const rt of reservedTickets) {
      for (let i = 0; i < (rt.quantity ?? 0); i++) {
        const pData = participants[pIdx];
        if (!pData) break;

        // Resolve participante — nunca cria User fantasma
        let participantUserId: string | null = userId;
        let guestSnapshot:
          | {
              name: string;
              email: string;
              documentType: DocumentType | null;
              documentNumber: string;
              documentNumberClean: string;
              phone: string;
              dateOfBirth: Date | null;
              gender: string | null;
            }
          | null = null;

        if (pData.email?.toLowerCase() !== buyerUser?.email?.toLowerCase()) {
          const existingUser = await tx.user.findFirst({ where: { email: pData.email } });
          if (existingUser) {
            participantUserId = existingUser.id;
          } else {
            const doc = resolveDocument(pData);
            participantUserId = null;
            guestSnapshot = {
              name: pData.name ?? '',
              email: pData.email ?? '',
              documentType: doc.type,
              documentNumber: doc.number,
              documentNumberClean: doc.clean,
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
              // Legacy: mantido em paralelo durante a transição. Fase E remove.
              participantCpf: guestSnapshot.documentNumber,
              participantCpfClean:
                guestSnapshot.documentType === DocumentType.CPF
                  ? guestSnapshot.documentNumberClean
                  : '',
              // Fonte de verdade nova
              participantDocumentType: guestSnapshot.documentType,
              participantDocumentNumber: guestSnapshot.documentNumber,
              participantDocumentNumberClean: guestSnapshot.documentNumberClean,
              participantPhone: guestSnapshot.phone,
              participantDateOfBirth: guestSnapshot.dateOfBirth,
              participantGender: guestSnapshot.gender,
            }),
          },
        });

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

        // RegistrationProduct deste participante — consome cada item UMA única vez
        // (e-mail duplicado em 2 slots não duplica a entrega do produto).
        const participantProducts = (pendingProducts ?? []).filter(
          (item: any, itemIdx: number) => {
            if (consumedProductIdx.has(itemIdx)) return false;
            // Slot-aware com fallback por e-mail (ver `productMatchesSlot`). O
            // consumedProductIdx mantém o first-wins por slot no caminho legado.
            if (!productMatchesSlot(item, pIdx, pData.email)) return false;
            consumedProductIdx.add(itemIdx);
            return true;
          },
        );
        const participantProductMap = new Map<string, any>();
        if (participantProducts.length > 0) {
          for (const item of participantProducts) {
            const product = await r.product.findUnique({
              where: { id: item.productId },
              include: { variations: true },
            });
            if (!product) continue;
            participantProductMap.set(product.id, product);
            const selectedVariation = item.variationId
              ? (product.variations ?? []).find((v: any) => v.id === item.variationId)
              : null;
            const unitPrice = resolveProductUnitPrice(product, selectedVariation);
            const productSnapshot = {
              id: product.id,
              name: product.name,
              images: (product as any).images ?? [],
              primaryImageIndex: (product as any).primaryImageIndex ?? 0,
              basePrice: product.basePrice,
              isIncludedInTicket: (product as any).isIncludedInTicket,
              isRequired: (product as any).isRequired,
              variationType: (product as any).variationType ?? null,
              // Congela se este item segurou estoque (decidido no patchProducts) — usado pelo
              // estorno para saber se deve devolver availableStock.
              stockHeld: item.stockHeld === true,
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
            // Contabiliza a venda da variação. O availableStock NÃO é tocado aqui — o hold
            // (decremento) já foi feito no patchProducts (reserva) p/ TODO produto que segura
            // estoque, inclusive incluso+obrigatório; aqui só soldCount++ converte reserva→venda.
            if (item.variationId) {
              await incrementVariationSold(tx, item.variationId, item.quantity ?? 1);
            }
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

        // Snapshot do recibo
        const participantProductSnapshots = (participantProducts ?? []).map((item: any) => {
          const prod = participantProductMap?.get(item.productId) as any;
          return prod ? {
            id: prod.id,
            name: prod.name,
            images: prod.images ?? [],
            primaryImageIndex: prod.primaryImageIndex ?? 0,
            basePrice: prod.basePrice,
            // Flags do produto p/ o read do recibo (snapshot-only) saber se é incluso
            // no ingresso — antes só existia no productSnapshot por-produto.
            isIncludedInTicket: prod.isIncludedInTicket ?? false,
            isRequired: prod.isRequired ?? false,
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
            description: snapshotEvent.description ?? null,
            eventDate: snapshotEvent.eventDate,
            registrationStartDate: snapshotEvent.registrationStartDate ?? null,
            registrationEndDate: snapshotEvent.registrationEndDate ?? null,
            bannerUrl: snapshotEvent.bannerUrl ?? null,
            logoUrl: snapshotEvent.logoUrl ?? null,
            // Contato (email/phone) NÃO entra mais no snapshot (2026-06-04): o recibo é
            // devolvido em rotas de USUÁRIO e o contato do organizador está fora desse
            // contrato. Snapshots antigos que já têm os campos são limpos no READ
            // (stripOrganizationContact em orders/registrations).
            organization: snapshotEvent.organization
              ? {
                  id: snapshotEvent.organization.id,
                  name: snapshotEvent.organization.name,
                  logoUrl: snapshotEvent.organization.logoUrl ?? null,
                }
              : null,
            location: {
              name: snapshotEvent.location ?? null,
              neighborhood: snapshotEvent.neighborhood ?? null,
              city: snapshotEvent.city ?? null,
              state: snapshotEvent.state ?? null,
              country: snapshotEvent.country ?? null,
              zipCode: snapshotEvent.zipCode ?? null,
              googleMapsLink: snapshotEvent.googleMapsLink ?? null,
            },
          } : null,
          ticket: ticketSnapshot,
          products: participantProductSnapshots,
          questionAnswers: snapshotedAnswers,
          participant: (() => {
            // Snapshot completo do participante (doc resolvido p/ CPF legacy + novo;
            // country preservado pra PDF/email formatarem telefone/label do documento).
            const participantDoc = resolveDocument(pData);
            return {
              name: pData.name ?? null,
              email: pData.email ?? null,
              cpf: pData.cpf ?? null,
              documentType: participantDoc.type ?? null,
              documentNumber: participantDoc.number || null,
              phone: pData.phone ?? null,
              birthDate: pData.birthDate ?? null,
              gender: pData.gender ?? null,
              country: (pData as any).country ?? (pData as any).nationality ?? null,
            };
          })(),
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
            discount,
            pixDiscount,
            finalTotal,
            coupon: order.coupon ? {
              id: order.coupon.id,
              code: order.coupon.code,
              type: order.coupon.type,
              value: order.coupon.value,
              applyToProducts: couponAppliedToProducts,
            } : null,
            voucher: order.voucher ? {
              id: order.voucher.id,
              code: order.voucher.code,
              name: order.voucher.name,
              applyToProducts: voucherAppliedToProducts,
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

    // Rede de segurança: holds de itens que NENHUM participante consumiu (ex.: slot removido sem
    // re-patch dos produtos, e-mail órfão) nunca viram venda → devolve o availableStock pra não
    // vazar estoque. Mantém a invariante availableStock + soldCount == stock.
    for (let i = 0; i < pendingProducts.length; i++) {
      const item = pendingProducts[i];
      if (consumedProductIdx.has(i) || !item?.stockHeld || !item.variationId) continue;
      await releaseVariationHold(tx, item.variationId, item.quantity ?? 1);
    }

    this.logger.log(`finalizePaidOrder: ${createdRegs.length} inscrição(ões) criada(s) para order ${orderId}`);

    // ── Telemetria de funil: CONVERSÃO efetiva (`order.paid`) ──────────────────────────
    // Fonte ÚNICA — cobre todos os caminhos de confirmação: cartão à vista (pay inline),
    // PIX (webhook), 3DS, polling e pedido R$0. Push em buffer (sem I/O no hot path).
    // Se a tx do caller sofrer rollback DEPOIS daqui, fica 1 evento fantasma — aceitável:
    // o log é evidência de jornada, não fonte fiscal (a verdade é Order/Payment).
    try {
      const payment = await tx.payment.findUnique({
        where: { orderId },
        select: { method: true },
      });
      this.activity.record({
        userId,
        source: UserActivitySource.BACKEND,
        category: UserActivityCategory.CHECKOUT,
        action: 'order.paid',
        metadata: {
          orderId,
          eventId: order.eventId,
          method: payment?.method ?? null,
          finalAmount: order.finalAmount ?? 0,
          discount,
          registrations: createdRegs.length,
        },
      });
    } catch {
      // Telemetria nunca quebra o finalize.
    }

    return createdRegs;
  }
}
