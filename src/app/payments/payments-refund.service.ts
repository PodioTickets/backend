import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  RegistrationStatus,
  VoucherStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from './cielo.service';
import { RepasseService } from '../repasse/repasse.service';

/**
 * Estorna pagamentos via Cielo a partir de uma ação administrativa interna.
 *
 * Diferença vs PaymentsChargebackService:
 *   - Chargeback service = reativo. Roda em cron, detecta reversões já feitas no painel
 *     da Cielo / pelo emissor e SOMENTE sincroniza estado local (não toca cupom/voucher).
 *   - Refund service     = proativo. Inicia o estorno na Cielo a partir de um pedido do
 *     admin, valida pré-condições financeiras e libera cupom/voucher para reuso.
 *
 * Idempotência: todas as escritas usam updateMany com filtro por status original — uma
 * segunda chamada para a mesma order vira no-op nos efeitos colaterais (e o chargeback
 * cron, se rodar entre uma chamada e outra, também vira no-op).
 */
@Injectable()
export class PaymentsRefundService {
  private readonly logger = new Logger(PaymentsRefundService.name);

  // Métodos que a Cielo permite estornar pela API. BOLETO e CRYPTO não são suportados.
  private static readonly REFUNDABLE_METHODS = new Set<PaymentMethod>([
    PaymentMethod.PIX,
    PaymentMethod.CREDIT_CARD,
    PaymentMethod.DEBIT_CARD,
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cieloService: CieloService,
    private readonly repasseService: RepasseService,
  ) {}

  /**
   * Estorna um pedido pago. V1 só suporta estorno total — refund parcial fica para uma
   * segunda fase porque interage com a fórmula de breakdown do repasse de forma não trivial.
   *
   * @param orderId        UUID da order a estornar.
   * @param adminUserId    UUID do admin que está executando (para audit log).
   * @param reason         Motivo do estorno (mínimo 3 chars).
   * @param force          Bypass do guard de saldo insuficiente (true = admin assumiu o risco).
   * @param ip             IP do request (opcional, vai pro audit log).
   */
  async refundOrder(params: {
    orderId: string;
    adminUserId: string;
    reason: string;
    force?: boolean;
    ip?: string;
  }) {
    const { orderId, adminUserId, reason, force = false, ip } = params;

    // ── 1. Carrega snapshot completo da order (single round-trip) ─────────────
    const order = await this.prisma.getWriteClient().order.findUnique({
      where: { id: orderId },
      include: {
        payment: true,
        coupon: { select: { id: true, usageCount: true } },
        voucher: { select: { id: true, status: true } },
        event: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            organizerFeePercent: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Pedido não encontrado' });
    }

    // ── 2. Validações de estado ──────────────────────────────────────────────
    if (order.status !== OrderStatus.PAID) {
      throw new ConflictException({
        code: 'ORDER_NOT_PAID',
        message: `Pedido não está em status PAID (status atual: ${order.status})`,
      });
    }

    const payment = order.payment;
    if (!payment) {
      // PAID sem payment associado é estado inconsistente — não deveria acontecer pelo schema (relação 1-1).
      throw new ConflictException({
        code: 'PAYMENT_MISSING',
        message: 'Pedido marcado como pago mas não possui pagamento associado',
      });
    }

    if (payment.status !== PaymentStatus.PAID) {
      throw new ConflictException({
        code: 'PAYMENT_NOT_PAID',
        message: `Pagamento não está em status PAID (status atual: ${payment.status})`,
      });
    }

    if (!PaymentsRefundService.REFUNDABLE_METHODS.has(payment.method)) {
      throw new UnprocessableEntityException({
        code: 'METHOD_NOT_REFUNDABLE',
        message:
          payment.method === PaymentMethod.BOLETO
            ? 'A Cielo não suporta estorno de boleto via API. Realize a devolução manualmente via TED.'
            : `Método de pagamento ${payment.method} não pode ser estornado pela API.`,
      });
    }

    const meta = (payment.metadata as Record<string, unknown> | null) ?? {};
    const cieloPaymentId =
      (meta.cieloPaymentId as string | undefined) ?? payment.transactionId ?? undefined;
    if (!cieloPaymentId) {
      throw new ConflictException({
        code: 'CIELO_PAYMENT_ID_MISSING',
        message: 'Pagamento não possui referência da Cielo (cieloPaymentId / transactionId)',
      });
    }

    // ── 3. Guard de saldo: estorno não pode jogar o saldo do organizador no negativo
    //       sem confirmação explícita (force=true). Calcula via breakdown atualizado.
    const refundOrgNet = this.computeOrganizerNet(
      order.finalAmount,
      order.serviceFee,
      order.event.organizerFeePercent,
    );

    if (!force) {
      const { breakdown } = await this.repasseService.computeBreakdownForEvent(order.event.id);
      if (breakdown.saldoParaSaque < refundOrgNet) {
        throw new ConflictException({
          code: 'INSUFFICIENT_ORGANIZER_BALANCE',
          message:
            `Saldo disponível do organizador (R$ ${(breakdown.saldoParaSaque / 100).toFixed(2)}) ` +
            `não cobre o valor a ser deduzido por este estorno (R$ ${(refundOrgNet / 100).toFixed(2)}). ` +
            `Use force=true para prosseguir mesmo assim.`,
          data: {
            saldoParaSaque: breakdown.saldoParaSaque,
            refundOrgNet,
          },
        });
      }
    }

    // ── 4. Chama a Cielo ─────────────────────────────────────────────────────
    // V1 = estorno total: não passamos amount, a Cielo estorna o valor cheio.
    const cieloResult = await this.cieloService.cancelPayment(cieloPaymentId);

    if (!cieloResult.success) {
      this.logger.error(
        `[REFUND] Cielo recusou estorno do payment ${payment.id} (cieloId=${cieloPaymentId}): ${cieloResult.error}`,
      );
      throw new BadRequestException({
        code: 'CIELO_REFUND_FAILED',
        message: cieloResult.error ?? 'Cielo recusou a operação de estorno',
        data: {
          cieloStatus: cieloResult.cieloStatus,
          returnCode: cieloResult.returnCode,
          returnMessage: cieloResult.returnMessage,
        },
      });
    }

    const cieloStatusStr = cieloResult.cieloStatus ?? 'Unknown';
    // 'Pending' = aceito mas não finalizado pela Cielo — aplicamos efeitos otimisticamente.
    // O cron de chargeback vai re-checar e atualizar o metadata se necessário.
    const isPending = cieloStatusStr === 'Pending';

    // ── 5. Aplica efeitos colaterais transacionalmente ───────────────────────
    const refundedAt = new Date();
    await this.prisma.getWriteClient().$transaction(async (tx: any) => {
      // 5a. Marca o Payment como REFUNDED. updateMany com guard de status garante
      //     idempotência: se outro processo (ex: cron de chargeback) já tiver marcado,
      //     count=0 e o restante da transação vira no-op.
      const paymentUpdate = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PAID },
        data: {
          status: PaymentStatus.REFUNDED,
          metadata: {
            ...(meta as object),
            cieloStatus: cieloStatusStr,
            refundType: 'REFUND', // distinguir de CHARGEBACK (usado pelo fiscal-export e paymentMethodStats)
            refundReason: reason,
            refundedByUserId: adminUserId,
            refundedAt: refundedAt.toISOString(),
            ...(isPending && { refundPendingConfirmation: true }),
          } as any,
          updatedAt: refundedAt,
        },
      });

      if (paymentUpdate.count === 0) {
        // Race: outra requisição já processou. Aborta sem aplicar mais efeitos.
        this.logger.warn(
          `[REFUND] payment ${payment.id} já não está PAID — provável corrida com cron de chargeback. No-op.`,
        );
        return;
      }

      // 5b. Order → CANCELLED
      await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PAID },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: refundedAt,
          cancelledReason: `Estorno via Cielo: ${reason}`,
          updatedAt: refundedAt,
        },
      });

      // 5c. Registrations confirmadas → CANCELLED
      await tx.registration.updateMany({
        where: {
          orderId: order.id,
          status: { in: [RegistrationStatus.CONFIRMED, RegistrationStatus.COMPLETED] },
        },
        data: { status: RegistrationStatus.CANCELLED, updatedAt: refundedAt },
      });

      // 5d. Cupom: decrementa usageCount (clamp em 0 para defender contra inconsistência).
      //     updateMany + filtro garante atomicidade ao nível do registro.
      if (order.coupon?.id) {
        await tx.$executeRaw`
          UPDATE "Coupon"
          SET "usageCount" = GREATEST(0, "usageCount" - 1),
              "updatedAt" = ${refundedAt}
          WHERE id = ${order.coupon.id}::uuid
        `;
      }

      // 5e. Voucher: libera para reuso (USED → ACTIVE) se este pedido foi quem o consumiu.
      //     updateMany com guard de status evita liberar um voucher que já foi reusado por
      //     outra order após uma race condition improvável.
      if (order.voucher?.id && order.voucher.status === VoucherStatus.USED) {
        await tx.voucher.updateMany({
          where: { id: order.voucher.id, status: VoucherStatus.USED },
          data: {
            status: VoucherStatus.ACTIVE,
            usedAt: null,
            usedBy: null,
            updatedAt: refundedAt,
          },
        });
      }

      // 5f. Audit log para a organização do evento. Não bloqueante: rodamos dentro da tx
      //     para garantir que o registro só existe se o estorno também foi commitado.
      await tx.organizationAuditLog.create({
        data: {
          organizationId: order.event.organizationId,
          actorUserId: adminUserId,
          ip: ip ?? null,
          action: 'ORDER_REFUND',
          metadata: {
            orderId: order.id,
            paymentId: payment.id,
            eventId: order.event.id,
            eventName: order.event.name,
            method: payment.method,
            amount: order.finalAmount,
            serviceFee: order.serviceFee,
            organizerNetDeducted: refundOrgNet,
            cieloPaymentId,
            cieloStatus: cieloStatusStr,
            reason,
            forced: force,
            ...(isPending && { pendingConfirmation: true }),
          },
        },
      });
    });

    this.logger.warn(
      `[REFUND] order=${order.id} payment=${payment.id} method=${payment.method} ` +
        `amount=${order.finalAmount} admin=${adminUserId} cieloStatus=${cieloStatusStr} ` +
        `force=${force} pending=${isPending}`,
    );

    return {
      message: isPending
        ? 'Estorno enviado à Cielo e aguardando confirmação assíncrona'
        : 'Estorno realizado com sucesso',
      data: {
        orderId: order.id,
        paymentId: payment.id,
        cieloStatus: cieloStatusStr,
        pendingConfirmation: isPending,
        amount: order.finalAmount,
        method: payment.method,
        refundedAt: refundedAt.toISOString(),
      },
    };
  }

  /**
   * Replica a fórmula do `calcBreakdown` do RepasseService para uma única order:
   *   orgNet = round((finalAmount - serviceFee) * (1 - organizerFeePercent/100))
   *
   * Mantida aqui (duplicação intencional, ~3 linhas) para evitar custo de uma round-trip
   * adicional ao Repasse só para obter este número derivado.
   */
  private computeOrganizerNet(
    finalAmount: number,
    serviceFee: number,
    organizerFeePercent: number,
  ): number {
    const organizerBase = Math.max(0, finalAmount - serviceFee);
    return Math.round(organizerBase * (1 - organizerFeePercent / 100));
  }
}
