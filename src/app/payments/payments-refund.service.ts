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
  UserActivityCategory,
  UserActivitySource,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from './cielo.service';
import { MercadoPagoService } from './mercadopago.service';
import { OrderFinalizationService } from './order-finalization.service';
import { UserActivityService } from '../../common/services/user-activity.service';
import { REFUND_FEE_RATE, resolveOrderOrganizerFeePercent } from '../../common/utils/refund.util';

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
    private readonly mercadoPagoService: MercadoPagoService,
    private readonly orderFinalization: OrderFinalizationService,
    private readonly activity: UserActivityService,
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
            refundFeeRate: true,
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

    // ── 3. Valores do estorno (informativos para o audit log) ────────────────
    // Guard de saldo REMOVIDO de propósito: a dedução real do estorno não é mais o
    // orgNet (ele é revertido implicitamente no breakdown ao sair de `paidOrders`),
    // então bloquear por "saldoParaSaque < orgNet" barrava estornos legítimos — ex.:
    // pedido ainda em aguardando liberação, que sequer mexe no saldo disponível. O
    // saldo pode ficar negativo quando o organizador já sacou o valor, e isso é o
    // comportamento esperado. `force` segue aceito por compatibilidade de contrato,
    // mas não há mais gate de saldo a sobrescrever.
    // Alíquota EFETIVA: snapshot congelado no pagamento (order.organizerFeePercent) com
    // fallback ao vivo. Congelado abaixo em payment.metadata.organizerNetReversed → o
    // repasse reverte EXATAMENTE o que foi creditado na venda (simetria venda↔estorno).
    const refundOrgNet = this.computeOrganizerNet(
      order.finalAmount,
      order.serviceFee,
      resolveOrderOrganizerFeePercent(order, order.event.organizerFeePercent),
    );
    const refundSubtotal = Math.max(0, order.finalAmount - order.serviceFee);
    // Taxa de estorno POR EVENTO (snapshot do evento); fallback à constante p/ legado.
    const refundFeeRate = order.event.refundFeeRate ?? REFUND_FEE_RATE;
    const refundFee = Math.round(refundSubtotal * refundFeeRate);

    // ── 4. Aplica efeitos colaterais transacionalmente (ANTES de chamar a Cielo) ───
    // Fix #38: transação Prisma é executada PRIMEIRO. Se ela falhar, a Cielo nunca é
    // chamada. Se a Cielo falhar DEPOIS do commit, gravamos compensação e re-lançamos.
    // Usa 'PENDING_CIELO_CALL' como placeholder de cieloStatus — atualizado pós-Cielo.
    const refundedAt = new Date();
    const applied = await this.prisma.getWriteClient().$transaction(async (tx: any): Promise<boolean> => {
      // 4a. Marca o Payment como REFUNDED. updateMany com guard de status garante
      //     idempotência: se outro processo (ex: cron de chargeback) já tiver marcado,
      //     count=0 e o restante da transação vira no-op.
      const paymentUpdate = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PAID },
        data: {
          status: PaymentStatus.REFUNDED,
          metadata: {
            ...(meta as object),
            cieloStatus: 'PENDING_CIELO_CALL',
            refundType: 'REFUND', // distinguir de CHARGEBACK (usado pelo fiscal-export e paymentMethodStats)
            refundReason: reason,
            refundedByUserId: adminUserId,
            refundedAt: refundedAt.toISOString(),
            // Congela o impacto p/ o organizador no momento do estorno (verdade
            // histórica — organizerFeePercent pode mudar depois). Lido por
            // RepasseService.getRefunded/getSummary.
            organizerNetReversed: refundOrgNet,
            refundFee,
          } as any,
          updatedAt: refundedAt,
        },
      });

      if (paymentUpdate.count === 0) {
        // Race: outra requisição já processou. Aborta sem aplicar mais efeitos.
        this.logger.warn(
          `[REFUND] payment ${payment.id} já não está PAID — provável corrida com cron de chargeback. No-op.`,
        );
        return false;
      }

      // 4b. Order → CANCELLED
      await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PAID },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: refundedAt,
          cancelledReason: `Estorno via Cielo: ${reason}`,
          updatedAt: refundedAt,
        },
      });

      // 4c. Registrations confirmadas → CANCELLED
      await tx.registration.updateMany({
        where: {
          orderId: order.id,
          status: { in: [RegistrationStatus.CONFIRMED, RegistrationStatus.COMPLETED] },
        },
        data: { status: RegistrationStatus.CANCELLED, updatedAt: refundedAt },
      });

      // 4d+4e. Reverte efeitos de venda (cupom/voucher) — FONTE ÚNICA compartilhada com
      //        o chargeback (`OrderFinalizationService.reverseSaleSideEffects`):
      //        decrementa o cupom espelhando o incremento do finalize (não −1 fixo) e
      //        libera o voucher SOMENTE se foi este usuário quem o consumiu (guard usedBy).
      await this.orderFinalization.reverseSaleSideEffects(tx, order.id);

      // 4f. Audit log para a organização do evento. Não bloqueante: rodamos dentro da tx
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
            organizerNetReversed: refundOrgNet,
            refundFee,
            cieloPaymentId,
            cieloStatus: 'PENDING_CIELO_CALL',
            reason,
            forced: force,
          },
        },
      });

      return true;
    });

    // ── 5. Chama a Cielo APÓS o commit da transação Prisma ────────────────────
    // Fix #38: chamada Cielo depois da tx para garantir que os efeitos locais só
    // existem quando a tx foi commitada. Se a Cielo falhar aqui, gravamos compensação.
    let cieloStatusStr = 'Unknown';
    let isPending = false;

    if (applied) {
      // Dispatch por gateway: débito processado no Mercado Pago estorna via
      // POST /refunds do MP; todo o resto segue no void/refund da Cielo. O
      // resultado é normalizado pro shape {success, cieloStatus, error} usado abaixo.
      const isMpPayment = (meta as any)?.gateway === 'MERCADOPAGO';
      const gatewayCancel = async () => {
        if (isMpPayment) {
          const mpResult = await this.mercadoPagoService.refundPayment(cieloPaymentId);
          return {
            success: mpResult.mpStatus === 'refunded' || mpResult.success,
            cieloStatus: mpResult.mpStatus ?? 'MP_REFUND_FAILED',
            error: mpResult.error,
          };
        }
        return this.cieloService.cancelPayment(cieloPaymentId);
      };
      const cieloResult = await gatewayCancel().catch(async (cieloError) => {
        this.logger.error('COMPENSAÇÃO NECESSÁRIA: tx Prisma OK mas Cielo falhou', {
          orderId: order.id,
          cieloPaymentId,
          error: cieloError?.message ?? String(cieloError),
        });
        await this.prisma.getWriteClient().payment.update({
          where: { id: payment.id },
          data: {
            metadata: {
              ...(meta as object),
              cieloStatus: 'COMPENSATION_NEEDED',
              refundCompensationPending: true,
              cieloError: cieloError?.message ?? String(cieloError),
              refundType: 'REFUND',
              refundReason: reason,
              refundedByUserId: adminUserId,
              refundedAt: refundedAt.toISOString(),
              organizerNetReversed: refundOrgNet,
              refundFee,
            } as any,
          },
        });
        throw cieloError;
      });

      if (!cieloResult.success) {
        this.logger.error(
          `[REFUND] Cielo recusou estorno do payment ${payment.id} (cieloId=${cieloPaymentId}): ${cieloResult.error}`,
        );
        // Atualiza metadata com status de falha da Cielo
        await this.prisma.getWriteClient().payment.update({
          where: { id: payment.id },
          data: {
            metadata: {
              ...(meta as object),
              cieloStatus: cieloResult.cieloStatus ?? 'CIELO_REFUND_FAILED',
              refundCompensationPending: true,
              refundType: 'REFUND',
              refundReason: reason,
              refundedByUserId: adminUserId,
              refundedAt: refundedAt.toISOString(),
              organizerNetReversed: refundOrgNet,
              refundFee,
            } as any,
          },
        });
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

      cieloStatusStr = cieloResult.cieloStatus ?? 'Unknown';
      // 'Pending' = aceito mas não finalizado pela Cielo — aplicamos efeitos otimisticamente.
      // O cron de chargeback vai re-checar e atualizar o metadata se necessário.
      isPending = cieloStatusStr === 'Pending';

      // Atualiza metadata com o cieloStatus real pós-chamada bem-sucedida
      await this.prisma.getWriteClient().payment.update({
        where: { id: payment.id },
        data: {
          metadata: {
            ...(meta as object),
            cieloStatus: cieloStatusStr,
            refundType: 'REFUND',
            refundReason: reason,
            refundedByUserId: adminUserId,
            refundedAt: refundedAt.toISOString(),
            organizerNetReversed: refundOrgNet,
            refundFee,
            ...(isPending && { refundPendingConfirmation: true }),
          } as any,
        },
      });
    }

    // ── 6. Telemetria: evento na jornada do COMPRADOR ─────────────────────────
    // Complementa o `order.refund` (COMPLIANCE) gravado pelo controller admin, que fica
    // na jornada do ADMIN. Este aqui aparece no histórico do usuário estornado.
    if (applied) {
      try {
        this.activity.record({
          userId: order.userId,
          source: UserActivitySource.BACKEND,
          category: UserActivityCategory.COMPLIANCE,
          action: 'order.refunded',
          metadata: {
            orderId: order.id,
            eventId: order.event.id,
            paymentId: payment.id,
            method: payment.method,
            amount: order.finalAmount,
            refundFee,
            refundType: 'REFUND',
            ...(isPending && { pendingConfirmation: true }),
          },
        });
      } catch {
        // Telemetria nunca quebra o estorno.
      }
    }

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
   * Cancela um pedido GRATUITO (finalAmount <= 0) — SEM estorno. Como nada foi
   * pago, NÃO chama a Cielo e NÃO cobra a taxa de 2% (diferença central vs
   * `refundOrder`). Marca o pedido CANCELLED, cancela as inscrições, reverte
   * cupom/voucher (libera o estoque de forma indireta, igual ao estorno) e grava
   * audit log `ORDER_CANCEL`.
   *
   * Guard de escopo: REJEITA pedido com valor pago (`finalAmount > 0`) com
   * `ORDER_HAS_PAYMENT` — esse caso é estorno (void na Cielo + taxa).
   * Idempotência: `updateMany` com guard de status (PAID) — 2ª chamada vira no-op.
   */
  async cancelFreeOrder(params: {
    orderId: string;
    actorUserId: string;
    reason: string;
    ip?: string;
  }) {
    const { orderId, actorUserId, reason, ip } = params;

    const order = await this.prisma.getWriteClient().order.findUnique({
      where: { id: orderId },
      include: {
        payment: true,
        event: { select: { id: true, name: true, organizationId: true } },
      },
    });

    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Pedido não encontrado' });
    }

    // Só pedidos GRATUITOS. Free order é gravado como PAID com finalAmount 0 e sem
    // referência Cielo; pedido com valor real deve ir pelo estorno (void + taxa).
    if (order.finalAmount > 0) {
      throw new ConflictException({
        code: 'ORDER_HAS_PAYMENT',
        message: 'Pedido possui valor pago — use o estorno (refund), não o cancelamento.',
      });
    }

    if (order.status === OrderStatus.CANCELLED) {
      throw new ConflictException({
        code: 'ORDER_ALREADY_CANCELLED',
        message: 'Pedido já está cancelado.',
      });
    }

    // Free order confirmado é PAID. PENDING (reserva) expira sozinho — fora do escopo.
    if (order.status !== OrderStatus.PAID) {
      throw new ConflictException({
        code: 'ORDER_NOT_CANCELLABLE',
        message: `Pedido não pode ser cancelado (status atual: ${order.status}).`,
      });
    }

    const cancelledAt = new Date();
    const cancelledReason = `Cancelamento pelo organizador: ${reason}`;
    const payment = order.payment;

    const applied = await this.prisma
      .getWriteClient()
      .$transaction(async (tx: any): Promise<boolean> => {
        // Order → CANCELLED (guard de status garante idempotência).
        const orderUpdate = await tx.order.updateMany({
          where: { id: order.id, status: OrderStatus.PAID },
          data: {
            status: OrderStatus.CANCELLED,
            cancelledAt,
            cancelledReason,
            updatedAt: cancelledAt,
          },
        });
        if (orderUpdate.count === 0) {
          this.logger.warn(`[CANCEL] order ${order.id} já não está PAID — no-op (corrida).`);
          return false;
        }

        // Inscrições confirmadas → CANCELLED (libera a vaga, igual ao estorno).
        await tx.registration.updateMany({
          where: {
            orderId: order.id,
            status: { in: [RegistrationStatus.CONFIRMED, RegistrationStatus.COMPLETED] },
          },
          data: { status: RegistrationStatus.CANCELLED, updatedAt: cancelledAt },
        });

        // Reverte efeitos de venda (cupom/voucher) — mesma fonte única do estorno.
        await this.orderFinalization.reverseSaleSideEffects(tx, order.id);

        // Carimba o pagamento (free, R$0): mantém o status — PaymentStatus NÃO tem
        // CANCELLED e NÃO houve estorno de valor (não marcar REFUNDED). A verdade do
        // cancelamento é o `order.status`; a metadata registra a ação para auditoria.
        if (payment) {
          const meta = (payment.metadata as Record<string, unknown> | null) ?? {};
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              metadata: {
                ...(meta as object),
                cancelType: 'FREE_ORDER_CANCEL',
                cancelReason: reason,
                cancelledByUserId: actorUserId,
                cancelledAt: cancelledAt.toISOString(),
              } as any,
              updatedAt: cancelledAt,
            },
          });
        }

        await tx.organizationAuditLog.create({
          data: {
            organizationId: order.event.organizationId,
            actorUserId,
            ip: ip ?? null,
            action: 'ORDER_CANCEL',
            metadata: {
              orderId: order.id,
              paymentId: payment?.id ?? null,
              eventId: order.event.id,
              eventName: order.event.name,
              amount: order.finalAmount,
              reason,
            },
          },
        });

        return true;
      });

    // Telemetria (não bloqueante) na jornada do comprador.
    if (applied) {
      try {
        this.activity.record({
          userId: order.userId,
          source: UserActivitySource.BACKEND,
          category: UserActivityCategory.COMPLIANCE,
          action: 'order.cancelled',
          metadata: {
            orderId: order.id,
            eventId: order.event.id,
            paymentId: payment?.id ?? null,
            amount: order.finalAmount,
            cancelType: 'FREE_ORDER_CANCEL',
          },
        });
      } catch {
        // Telemetria nunca quebra o cancelamento.
      }
    }

    this.logger.warn(
      `[CANCEL] order=${order.id} payment=${payment?.id ?? '—'} amount=${order.finalAmount} ` +
        `actor=${actorUserId} applied=${applied}`,
    );

    return {
      message: 'Pedido cancelado com sucesso',
      data: {
        orderId: order.id,
        paymentId: payment?.id ?? null,
        cancelledAt: cancelledAt.toISOString(),
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
