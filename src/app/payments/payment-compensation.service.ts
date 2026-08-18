import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentStatus,
  UserActivityCategory,
  UserActivitySource,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from './cielo.service';
import { MercadoPagoService } from './mercadopago.service';
import { UserActivityService } from '../../common/services/user-activity.service';
import { releaseVoucherByOrder } from '../../common/utils/voucher-reservation.util';

/**
 * Razões de compensação de um pagamento CAPTURADO que não pode ser entregue:
 *  - PAID_AFTER_CANCELLATION: webhook/polling confirmou DEPOIS do cron de expiração já ter
 *    cancelado o pedido (estoque devolvido/possivelmente revendido).
 *  - VOUCHER_CONSUMED: finalize abortou — o voucher do pedido foi consumido por outro pedido
 *    entre a captura e a confirmação (reserva vencida "roubada").
 *  - EMPTY_PARTICIPANTS: finalize abortou — pedido sem participantes no momento da confirmação.
 */
export type CompensationReason =
  | 'PAID_AFTER_CANCELLATION'
  | 'VOUCHER_CONSUMED'
  | 'EMPTY_PARTICIPANTS';

/**
 * Compensação automática de pagamentos órfãos (capturados sem entrega possível).
 *
 * Antes deste serviço, os dois cenários ficavam SEM saída:
 *  - pedido cancelado pelo cron + webhook tardio → Payment=PAID preso pra sempre (o cron de
 *    chargeback só rebaixa quando a PRÓPRIA Cielo reporta reversão);
 *  - finalize abortado (voucher double-use) → 500 pro webhook → reentrega infinita da Cielo.
 * Em ambos, o cliente pagou e não recebeu ingresso nem reembolso.
 *
 * Fluxo: estorna na Cielo (fora de tx — chamada externa) → marca Payment REFUNDED + metadata
 * de auditoria → se o pedido ainda está PENDING (caso de aborto, tx deu rollback), cancela com
 * devolução de estoque e liberação da reserva de voucher. Se o estorno na Cielo FALHAR, NADA é
 * perdido: flag `compensationPending` no metadata + log CRITICAL para reconciliação manual —
 * fail-safe, nunca lança (o caller precisa devolver 200 pro gateway pra matar o retry-loop).
 *
 * Separado do OrderFinalizationService de propósito: aquele roda DENTRO de tx e não pode
 * depender da Cielo (chamada externa em tx = lock longo + efeito não-transacional).
 */
@Injectable()
export class PaymentCompensationService {
  private readonly logger = new Logger(PaymentCompensationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cieloService: CieloService,
    private readonly mercadoPagoService: MercadoPagoService,
    private readonly activity: UserActivityService,
  ) {}

  /**
   * Compensa o pagamento do pedido. Idempotente (updateMany com guard de status) e fail-safe
   * (nunca lança — falha vira flag de reconciliação manual + log CRITICAL).
   */
  async compensateOrphanPayment(orderId: string, reason: CompensationReason): Promise<void> {
    try {
      await this.run(orderId, reason);
    } catch (e: any) {
      // Última linha de defesa: a compensação NUNCA propaga (o caller deve responder 200
      // ao gateway). O estado fica recuperável via flag/log.
      this.logger.error(
        `[COMPENSATION] falha inesperada ao compensar order ${orderId} (${reason}): ${e?.message ?? e}`,
      );
    }
  }

  private async run(orderId: string, reason: CompensationReason): Promise<void> {
    const w: any = this.prisma.getWriteClient();

    const payment = await w.payment.findUnique({ where: { orderId } });
    if (!payment) {
      // Aborto pré-Payment (ex.: PIX cujo upsert deu rollback junto) — nada capturado a
      // estornar localmente; o registro na Cielo segue pago e PRECISA de atenção manual.
      this.logger.error(
        `[COMPENSATION] order ${orderId} (${reason}) sem Payment local — verificar captura na Cielo manualmente`,
      );
      return;
    }

    const meta = (payment.metadata as Record<string, unknown> | null) ?? {};
    const cieloPaymentId =
      (meta.cieloPaymentId as string | undefined) ?? payment.transactionId ?? undefined;

    // 1. Estorno na Cielo (fora de tx). Sem referência Cielo (ex.: pedido R$0) não há o que
    //    estornar no gateway — só o estado local.
    let refundOk = !cieloPaymentId;
    if (cieloPaymentId) {
      try {
        // Dispatch por gateway: débito MP estorna via refund do Mercado Pago
        // (pagamento capturado não tem void no MP); resto segue na Cielo.
        const isMpPayment = (meta as any)?.gateway === 'MERCADOPAGO';
        const res = isMpPayment
          ? await (async () => {
              const mpRes = await this.mercadoPagoService.refundPayment(cieloPaymentId);
              return {
                success: mpRes.mpStatus === 'refunded' || mpRes.success,
                error: mpRes.error,
              };
            })()
          : await this.cieloService.cancelPayment(cieloPaymentId);
        refundOk = !!res?.success;
        if (!refundOk) {
          this.logger.error(
            `[COMPENSATION] Cielo recusou estorno automático do payment ${payment.id} (order ${orderId}, ${reason}): ${res?.error ?? 'sem detalhe'}`,
          );
        }
      } catch (e: any) {
        this.logger.error(
          `[COMPENSATION] erro ao estornar payment ${payment.id} na Cielo (order ${orderId}, ${reason}): ${e?.message ?? e}`,
        );
      }
    }

    // 2. Estado local (transacional). Estorno OK → REFUNDED; falhou → mantém o status e
    //    sinaliza `compensationPending` pra reconciliação manual/admin.
    const now = new Date();
    await w.$transaction(async (tx: any) => {
      await tx.payment.updateMany({
        where: { id: payment.id, status: { not: PaymentStatus.REFUNDED } },
        data: {
          ...(refundOk && { status: PaymentStatus.REFUNDED }),
          metadata: {
            ...(meta as object),
            refundType: refundOk ? 'AUTO_COMPENSATION' : (meta as any).refundType,
            compensationReason: reason,
            compensationAt: now.toISOString(),
            ...(refundOk ? {} : { compensationPending: true }),
          } as any,
          updatedAt: now,
        },
      });

      // Pedido ainda PENDING (caso de aborto do finalize — a tx do caller deu rollback):
      // cancela espelhando o cron de expiração (estoque de volta + placeholders cancelados +
      // reserva de voucher liberada). No caso PAID_AFTER_CANCELLATION o cron já fez tudo isso.
      const cancelled: any[] = await tx.$queryRaw`
        UPDATE "Order"
        SET "status" = 'CANCELLED'::"OrderStatus",
            "cancelledAt" = NOW(),
            "cancelledReason" = ${`AUTO_COMPENSATION: ${reason}`},
            "updatedAt" = NOW()
        WHERE id = ${orderId}::uuid
          AND "status" = 'PENDING'::"OrderStatus"
        RETURNING id
      `;
      if (cancelled?.length > 0) {
        const reserved: any[] = await tx.orderReservedTicket.findMany({
          where: { orderId },
          select: { batchId: true, quantity: true },
        });
        for (const rt of reserved) {
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
        await releaseVoucherByOrder(tx, orderId);
      }
    });

    // 3. Telemetria/auditoria na jornada do comprador (fail-open).
    try {
      this.activity.record({
        userId: payment.userId,
        source: UserActivitySource.BACKEND,
        category: UserActivityCategory.COMPLIANCE,
        action: 'order.auto-refund',
        metadata: {
          orderId,
          paymentId: payment.id,
          method: payment.method,
          amount: payment.amount,
          reason,
          refundOk,
        },
      });
    } catch {
      // telemetria nunca quebra a compensação
    }

    this.logger.warn(
      `[COMPENSATION] order=${orderId} payment=${payment.id} reason=${reason} cielo=${refundOk ? 'REFUNDED' : 'PENDENTE-MANUAL'}`,
    );
  }
}
