/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DocumentType, RegistrationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveDocument } from '../../common/utils/document.util';
import { resolveProductUnitPrice } from '../../common/utils/product-price.util';

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

  constructor(private readonly prisma: PrismaService) {}

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
      // ocorrer pós-checkout (o front preenche em /participants antes de pagar).
      this.logger.error(
        `finalizePaidOrder: order ${orderId} sem pendingParticipants — inscrições não criadas`,
      );
      return [];
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
      const ticketCount = reservedTickets.reduce((sum: number, rt: any) => sum + (rt.quantity ?? 1), 0);

      if (couponForUsage?.couponType === 'QUANTITY') {
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
        // DISCOUNT/AGE: cap em maxUsage atomicamente — nunca ultrapassa sob concorrência
        const delta = couponForUsage?.maxUsage != null
          ? Math.min(ticketCount, Math.max(0, couponForUsage.maxUsage - couponForUsage.usageCount))
          : ticketCount;
        if (delta > 0) {
          await tx.$queryRaw`
            UPDATE "Coupon"
            SET "usageCount" = LEAST("usageCount" + ${delta}, COALESCE("maxUsage", "usageCount" + ${delta}))
            WHERE id = ${order.couponId}::uuid
          `;
        }
      }
    }

    // ── Marcar voucher como usado — atômico ACTIVE → USED (evita sobrescrita em corrida) ──
    if (order.voucherId) {
      const voucherResult = await tx.voucher.updateMany({
        where: { id: order.voucherId, status: 'ACTIVE' },
        data: { status: 'USED', usedAt: new Date(), usedBy: userId },
      });
      if (voucherResult.count === 0) {
        this.logger.error(
          `[VOUCHER-RACE] finalize: voucher ${order.voucherId} já estava USED para order ${orderId} — requer estorno manual`,
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

        // RegistrationProduct deste participante
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

        // Snapshot do recibo
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
            description: snapshotEvent.description ?? null,
            eventDate: snapshotEvent.eventDate,
            registrationStartDate: snapshotEvent.registrationStartDate ?? null,
            registrationEndDate: snapshotEvent.registrationEndDate ?? null,
            bannerUrl: snapshotEvent.bannerUrl ?? null,
            logoUrl: snapshotEvent.logoUrl ?? null,
            organization: snapshotEvent.organization
              ? {
                  id: snapshotEvent.organization.id,
                  name: snapshotEvent.organization.name,
                  logoUrl: snapshotEvent.organization.logoUrl ?? null,
                  email: snapshotEvent.organization.email ?? null,
                  phone: snapshotEvent.organization.phone ?? null,
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

    this.logger.log(`finalizePaidOrder: ${createdRegs.length} inscrição(ões) criada(s) para order ${orderId}`);
    return createdRegs;
  }
}
