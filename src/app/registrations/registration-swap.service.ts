import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrderStatus, RegistrationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrganizationAuditService } from '../../common/services/organization-audit.service';
import { resolveActiveBatch } from '../tickets/batch-active.util';
import {
  acquireVariationHold,
  incrementVariationSold,
  reverseRegistrationProductSale,
} from '../../common/utils/product-stock.util';
import { RegistrationsService } from './registrations.service';
import { swapEligibilityError, swapProductsError, SwapProductSelection } from './registration-swap.util';

export interface SwapRegistrationTicketParams {
  registrationId: string;
  ticketId: string;
  products: SwapProductSelection[];
  adminUserId: string;
  ip?: string | null;
}

/**
 * Troca de ingresso pelo ADMIN. Funciona como "cancelar + criar": a inscrição antiga é
 * ANULADA (status CANCELLED + voidedAt, então vaga/teto/CPF/vendidos a tratam como
 * cancelada) e uma inscrição NOVA é criada no mesmo pedido, com o ingresso escolhido.
 *
 * Nada é cobrado nem estornado (decisão do usuário): Order/Payment não mudam. A unidade
 * do pedido (OrderReservedTicket) passa para o ingresso/lote novo mantendo o preço PAGO,
 * para que estorno futuro devolva o lote certo e os totais do pedido continuem batendo.
 * A diferença de preço é só visual (tela + auditoria).
 *
 * Estoque — mesma lógica do cancelamento/compra:
 * - lote antigo: +1 (LEAST com a capacidade); lote ativo do novo: -1 guardado (esgotado → 409);
 * - produtos antigos: venda revertida (reverseRegistrationProductSale, a mesma do estorno);
 * - produtos novos: hold + soldCount (esgotado → 422), gravados com preço 0 (nada foi pago).
 */
@Injectable()
export class RegistrationSwapService {
  private readonly logger = new Logger(RegistrationSwapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OrganizationAuditService,
    private readonly registrationsService: RegistrationsService,
  ) {}

  async swapTicket(params: SwapRegistrationTicketParams) {
    const { registrationId, ticketId, products, adminUserId, ip } = params;
    const prismaWrite = this.prisma.getWriteClient();

    const result = await prismaWrite.$transaction(
      async (tx: any) => {
        // Serializa trocas concorrentes da MESMA inscrição (duplo clique / duas abas).
        await tx.$queryRaw`SELECT id FROM "Registration" WHERE id = ${registrationId}::uuid FOR UPDATE`;

        const reg = await tx.registration.findUnique({
          where: { id: registrationId },
          include: {
            tickets: true,
            products: true,
            questionAnswers: true,
            modalities: true,
            order: { select: { id: true, status: true, reservedTickets: true } },
            event: { select: { id: true, eventDate: true } },
          },
        });
        if (!reg) throw new NotFoundException('Inscrição não encontrada');
        if (reg.voidedAt) throw new ConflictException('Esta inscrição já foi trocada');
        if (reg.status !== RegistrationStatus.CONFIRMED) {
          throw new BadRequestException('Só é possível trocar o ingresso de uma inscrição confirmada');
        }
        if (reg.order?.status !== OrderStatus.PAID) {
          throw new BadRequestException('O pedido desta inscrição não está pago');
        }

        const oldRt = reg.tickets[0];
        if (!oldRt) throw new UnprocessableEntityException('Inscrição sem ingresso vinculado');
        if (oldRt.ticketId === ticketId) {
          throw new BadRequestException('Escolha um ingresso diferente do atual');
        }

        const ticket = await tx.ticket.findUnique({
          where: { id: ticketId },
          include: {
            category: { select: { id: true, name: true } },
            batches: true,
            products: {
              include: { product: { include: { variations: true } } },
            },
          },
        });
        if (!ticket || !ticket.isActive || ticket.eventId !== reg.eventId) {
          throw new NotFoundException('Ingresso não encontrado neste evento');
        }

        // Coluna pode estar vazia em inscrições cujo participante só existe no receiptSnapshot
        // ("YYYY-MM-DD") — o mesmo dado que a tela da troca e o ingresso mostram.
        const snapParticipant = (reg.receiptSnapshot as any)?.participant;
        const snapBirth = snapParticipant?.birthDate ? new Date(snapParticipant.birthDate) : null;
        const participantDateOfBirth =
          reg.participantDateOfBirth ?? (snapBirth && !isNaN(snapBirth.getTime()) ? snapBirth : null);
        const participantGender = reg.participantGender ?? snapParticipant?.gender ?? null;

        const eligibility = swapEligibilityError(
          { dateOfBirth: participantDateOfBirth, gender: participantGender },
          ticket,
          reg.event?.eventDate ?? null,
        );
        if (eligibility) throw new UnprocessableEntityException(eligibility);

        const allowedProducts = (ticket.products ?? [])
          .map((tp: any) => tp.product)
          .filter((p: any) => p && !p.deletedAt);
        const productsError = swapProductsError(
          allowedProducts.map((p: any) => ({
            id: p.id,
            name: p.name,
            isRequired: !!p.isRequired,
            variations: p.variations ?? [],
          })),
          products,
        );
        if (productsError) throw new UnprocessableEntityException(productsError);

        // ── Lote ativo do ingresso novo (regra canônica, a mesma da reserva) ─────────
        const batchIds = ticket.batches.map((b: any) => b.id);
        if (batchIds.length === 0) {
          throw new UnprocessableEntityException(`Nenhum lote encontrado para o ingresso "${ticket.name}"`);
        }
        const soldAgg = await tx.registrationTicket.groupBy({
          by: ['batchId'],
          where: { batchId: { in: batchIds }, registration: { status: { not: 'CANCELLED' } } },
          _count: { id: true },
        });
        const soldMap = new Map(soldAgg.map((s: any) => [s.batchId, s._count.id]));
        const { batch, status } = resolveActiveBatch(
          ticket.batches.map((b: any) => ({ ...b, quantitySold: soldMap.get(b.id) ?? 0 })),
          new Date(),
        );
        if (status === 'SOLD_OUT') {
          throw new ConflictException(`Sem vagas disponíveis para o ingresso "${ticket.name}". Lote esgotado.`);
        }
        // Decremento atômico GUARDADO — mesmo SQL da reserva (OrdersService): contador e
        // vendas reais precisam ter vaga; 0 linhas → esgotado → rollback de tudo.
        const taken: any[] = await tx.$queryRaw`
          UPDATE "TicketBatch" tb
          SET "availableQuantity" = tb."availableQuantity" - 1
          WHERE tb.id = ${batch.id}::uuid
            AND tb."availableQuantity" >= 1
            AND (
              tb."quantity" - (
                SELECT COUNT(*)::int
                FROM "RegistrationTicket" rt
                JOIN "Registration" r ON rt."registrationId" = r.id
                WHERE rt."batchId" = tb.id
                  AND r.status != 'CANCELLED'
              )
            ) >= 1
          RETURNING tb.id
        `;
        if (!taken?.length) {
          throw new ConflictException(`Sem vagas disponíveis para o ingresso "${ticket.name}". Lote esgotado.`);
        }

        // Devolve a vaga do lote antigo — mesmo SQL do cancelamento/estorno.
        if (oldRt.batchId) {
          await tx.$executeRaw`
            UPDATE "TicketBatch"
            SET "availableQuantity" = LEAST("availableQuantity" + 1, "quantity"), "updatedAt" = NOW()
            WHERE id = ${oldRt.batchId}::uuid
          `;
        }

        // ── Unidade do pedido: move 1 do ingresso antigo para o novo, preço PAGO mantido ──
        const reserved: any[] = reg.order.reservedTickets ?? [];
        const oldReserved =
          reserved.find((r) => r.ticketId === oldRt.ticketId && r.batchId === oldRt.batchId) ??
          reserved.find((r) => r.ticketId === oldRt.ticketId);
        const oldSnapshot = (oldRt.ticketSnapshot as any) ?? null;
        const paidUnitPrice: number = oldReserved?.unitPrice ?? oldSnapshot?.batch?.price ?? 0;
        if (oldReserved) {
          if ((oldReserved.quantity ?? 0) > 1) {
            await tx.orderReservedTicket.update({
              where: { id: oldReserved.id },
              data: { quantity: { decrement: 1 } },
            });
          } else {
            await tx.orderReservedTicket.delete({ where: { id: oldReserved.id } });
          }
        }
        const sameNewRow = reserved.find(
          (r) => r.ticketId === ticket.id && r.batchId === batch.id && r.unitPrice === paidUnitPrice,
        );
        if (sameNewRow) {
          await tx.orderReservedTicket.update({
            where: { id: sameNewRow.id },
            data: { quantity: { increment: 1 } },
          });
        } else {
          await tx.orderReservedTicket.create({
            data: {
              orderId: reg.order.id,
              ticketId: ticket.id,
              batchId: batch.id,
              quantity: 1,
              unitPrice: paidUnitPrice,
              ticketName: ticket.name,
            },
          });
        }

        // ── Produtos antigos: desfaz a venda (mesma função do estorno). As linhas ficam na
        // inscrição trocada como histórico; o estorno ignora inscrições trocadas (voidedAt).
        for (const rp of reg.products) {
          await reverseRegistrationProductSale(tx, rp);
        }

        // ── Inscrição nova ─────────────────────────────────────────────────────────
        const newReg = await tx.registration.create({
          data: {
            eventId: reg.eventId,
            orderId: reg.orderId,
            userId: reg.userId,
            invitedById: reg.invitedById,
            status: RegistrationStatus.CONFIRMED,
            termsAccepted: reg.termsAccepted,
            rulesAccepted: reg.rulesAccepted,
            emergencyContactName: reg.emergencyContactName,
            emergencyContactPhone: reg.emergencyContactPhone,
            participantName: reg.participantName,
            participantEmail: reg.participantEmail,
            participantCpf: reg.participantCpf,
            participantCpfClean: reg.participantCpfClean,
            participantDocumentType: reg.participantDocumentType,
            participantDocumentNumber: reg.participantDocumentNumber,
            participantDocumentNumberClean: reg.participantDocumentNumberClean,
            participantPhone: reg.participantPhone,
            participantDateOfBirth,
            participantGender,
          },
        });
        const frontendUrl = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');
        await tx.registration.update({
          where: { id: newReg.id },
          data: { qrCode: `${frontendUrl}/user/tickets/${newReg.id}` },
        });

        const swapInfo = {
          fromRegistrationId: reg.id,
          fromTicketId: oldRt.ticketId,
          fromTicketName: oldSnapshot?.name ?? null,
          paidUnitPrice,
          priceDifference: batch.price - paidUnitPrice,
          swappedAt: new Date().toISOString(),
          swappedBy: adminUserId,
        };
        const ticketSnapshot = {
          id: ticket.id,
          name: ticket.name,
          description: ticket.description ?? null,
          modality: ticket.modality ?? null,
          distance: ticket.distance ?? null,
          distanceUnit: ticket.distanceUnit ?? null,
          gender: ticket.gender ?? null,
          ageLimitMin: ticket.ageLimitMin ?? null,
          ageLimitMax: ticket.ageLimitMax ?? null,
          category: ticket.category ?? null,
          batch: { id: batch.id, price: batch.price },
          swap: swapInfo,
        };
        await tx.registrationTicket.create({
          data: { registrationId: newReg.id, ticketId: ticket.id, batchId: batch.id, ticketSnapshot },
        });

        // Produtos novos: hold de estoque + venda, preço 0 (troca não cobra nada).
        const productById = new Map<string, any>(allowedProducts.map((p: any) => [p.id, p]));
        const receiptProducts: any[] = [];
        for (const item of products) {
          const product = productById.get(item.productId);
          const variation = item.variationId
            ? (product.variations ?? []).find((v: any) => v.id === item.variationId)
            : null;
          if (variation && (variation.stock ?? 0) > 0) {
            const acquired = await acquireVariationHold(tx, variation.id, 1);
            if (acquired === 0) {
              throw new UnprocessableEntityException(`"${product.name}" (${variation.name}) está esgotado`);
            }
          }
          if (variation) await incrementVariationSold(tx, variation.id, 1);
          const productSnapshot = {
            id: product.id,
            name: product.name,
            images: product.images ?? [],
            primaryImageIndex: product.primaryImageIndex ?? 0,
            basePrice: product.basePrice,
            isIncludedInTicket: product.isIncludedInTicket,
            isRequired: product.isRequired,
            variationType: product.variationType ?? null,
            stockHeld: true,
            selectedVariation: variation
              ? { id: variation.id, name: variation.name, price: variation.price }
              : null,
          };
          await tx.registrationProduct.create({
            data: {
              registrationId: newReg.id,
              productId: product.id,
              variationId: variation?.id ?? null,
              quantity: 1,
              unitPrice: 0,
              totalPrice: 0,
              productSnapshot,
            },
          });
          receiptProducts.push({ ...productSnapshot, quantity: 1, unitPrice: 0 });
        }

        // Respostas do formulário e modalidades (legado) seguem com o participante.
        if (reg.questionAnswers.length > 0) {
          await tx.questionAnswer.createMany({
            data: reg.questionAnswers.map((qa: any) => ({
              registrationId: newReg.id,
              questionId: qa.questionId,
              answer: qa.answer,
              questionSnapshot: qa.questionSnapshot ?? undefined,
            })),
          });
        }
        if (reg.modalities.length > 0) {
          await tx.registrationModality.createMany({
            data: reg.modalities.map((m: any) => ({ registrationId: newReg.id, modalityId: m.modalityId })),
          });
        }

        // Recibo: o da inscrição antiga com ingresso/produtos trocados (pricing do pedido não muda).
        const oldReceipt = (reg.receiptSnapshot as any) ?? null;
        if (oldReceipt) {
          await tx.registration.update({
            where: { id: newReg.id },
            data: { receiptSnapshot: { ...oldReceipt, ticket: ticketSnapshot, products: receiptProducts, swap: swapInfo } },
          });
        }

        // Anula a antiga por último (o FOR UPDATE garante que ninguém a trocou no meio).
        await tx.registration.update({
          where: { id: reg.id },
          data: { status: RegistrationStatus.CANCELLED, voidedAt: new Date(), replacedById: newReg.id },
        });

        await this.auditService.recordForEvent(reg.eventId, {
          actorUserId: adminUserId,
          ip,
          kind: 'REGISTRATION_TICKET_SWAP',
          action: (ev) =>
            `Trocou o ingresso de ${reg.participantName || 'participante'} de "${oldSnapshot?.name ?? 'ingresso'}" para "${ticket.name}" no evento "${ev}"`,
          extra: {
            orderId: reg.orderId,
            oldRegistrationId: reg.id,
            newRegistrationId: newReg.id,
            oldTicketId: oldRt.ticketId,
            newTicketId: ticket.id,
            newBatchId: batch.id,
            paidUnitPrice,
            priceDifference: swapInfo.priceDifference,
          },
          tx,
        });

        return {
          newRegistrationId: newReg.id,
          participantEmail: reg.participantEmail as string | null,
        };
      },
      { timeout: 20000 },
    );

    // E-mail com o ingresso novo (fora da tx: falha de envio não desfaz a troca).
    let emailSent = false;
    if (result.participantEmail) {
      try {
        await this.registrationsService.resendOrderConfirmation(
          result.newRegistrationId,
          adminUserId,
          result.participantEmail,
          true,
          ip,
        );
        emailSent = true;
      } catch (err) {
        this.logger.error(
          `Troca ${registrationId} → ${result.newRegistrationId}: falha ao enviar o ingresso novo: ${(err as Error)?.message}`,
        );
      }
    }

    return {
      message: 'Ingresso trocado com sucesso',
      data: { registrationId: result.newRegistrationId, emailSent },
    };
  }
}
