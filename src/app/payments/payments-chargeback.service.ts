import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from './cielo.service';
import { OrderFinalizationService } from './order-finalization.service';
import { CronTimeout } from '../../common/decorators/cron-timeout.decorator';

// Statuses Braspag que indicam reversão de pagamento
const REVERSAL_STATUSES = new Set([10, 11]); // 10 = Voided, 11 = Refunded

// Janela de verificação: pagamentos confirmados nos últimos N dias
const CHECK_WINDOW_DAYS = 180;

// Máximo de pagamentos processados por execução (evita sobrecarga da API Braspag)
const BATCH_SIZE = 50;

// Intervalo entre chamadas à Braspag (ms) para não extrapolar rate limits
const CALL_DELAY_MS = 400;

@Injectable()
export class PaymentsChargebackService {
  private readonly logger = new Logger(PaymentsChargebackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cieloService: CieloService,
    private readonly orderFinalization: OrderFinalizationService,
  ) {}

  @Cron('0 * * * *') // todo início de hora
  @CronTimeout(5 * 60 * 1000) // timeout de 5 minutos
  async checkChargebacks(): Promise<void> {
    // Não executa em sandbox — não há chargebacks reais
    if (this.cieloService.sandboxMode) return;

    // Reconcilia estornos marcados otimisticamente (Cielo retornou 'Pending'). Roda
    // ANTES da varredura de PAID para não ser pulado pelo early-return de "0 pagamentos".
    await this.reconcilePendingRefunds();

    const cutoff = new Date(Date.now() - CHECK_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const payments = await this.prisma.getReadClient().payment.findMany({
      where: {
        status: PaymentStatus.PAID,
        paymentDate: { gte: cutoff },
        transactionId: { not: null },
      },
      select: {
        id: true,
        orderId: true,
        transactionId: true,
        metadata: true,
        method: true,
      },
      take: BATCH_SIZE,
      orderBy: { paymentDate: 'asc' }, // mais antigos primeiro
    });

    if (payments.length === 0) return;

    this.logger.log(`Verificando ${payments.length} pagamento(s) para estorno/chargeback`);

    let detected = 0;

    for (const payment of payments) {
      const meta = payment.metadata as any;
      const cieloPaymentId: string | undefined = meta?.cieloPaymentId ?? payment.transactionId ?? undefined;

      if (!cieloPaymentId) continue;

      try {
        const cieloData = await this.cieloService.getPayment(cieloPaymentId);
        if (!cieloData) continue;

        const cieloStatus = cieloData.Payment.Status;
        if (!REVERSAL_STATUSES.has(cieloStatus)) continue;

        await this.processReversal(payment, cieloStatus, meta);
        detected++;
      } catch (err: any) {
        this.logger.warn(`Erro ao consultar Braspag para payment ${payment.id}: ${err.message}`);
      }

      // Throttle para não extrapolar o rate limit da Braspag
      await new Promise<void>((resolve) => setTimeout(resolve, CALL_DELAY_MS));
    }

    if (detected > 0) {
      this.logger.warn(`${detected} reversão(ões) detectada(s) e registrada(s)`);
    }
  }

  private async processReversal(
    payment: { id: string; orderId: string; metadata: unknown },
    cieloStatus: number,
    existingMeta: any,
  ): Promise<void> {
    const cieloStatusStr = this.cieloService.mapCieloStatusToString(cieloStatus);
    // 10 = Voided (cancelamento/estorno pelo lojista ou emissor), 11 = Refunded (reembolso)
    const reversalType = cieloStatus === 10 ? 'Voided' : 'Refunded';
    const cancelledReason =
      cieloStatus === 10
        ? 'Pagamento cancelado/estornado pelo emissor'
        : 'Pagamento reembolsado (chargeback ou estorno)';

    await this.prisma.getWriteClient().$transaction(async (tx: any) => {
      // Idempotência: só processa se ainda estiver PAID
      const updated = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PAID },
        data: {
          status: PaymentStatus.REFUNDED,
          metadata: {
            ...(existingMeta as object),
            cieloStatus: cieloStatusStr,
            // Classificação ÚNICA consumida por EventsService/RepasseService: SEPARA
            // chargeback (reversão involuntária) de estorno proativo (refundType='REFUND')
            // para exibição/contagem. A taxa de refund de 2% incide igual nos dois (o
            // chargeback é um tipo de estorno). Antes faltava o campo → chargebacks nem
            // apareciam separados no painel.
            refundType: 'CHARGEBACK',
            reversalType,
            reversalDetectedAt: new Date().toISOString(),
          } as any,
        },
      });

      if (updated.count === 0) return; // já processado por execução anterior

      await tx.order.updateMany({
        where: { id: payment.orderId, status: 'PAID' },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledReason,
          updatedAt: new Date(),
        },
      });

      await tx.registration.updateMany({
        where: { orderId: payment.orderId, status: { in: ['CONFIRMED', 'COMPLETED'] } },
        data: { status: 'CANCELLED' },
      });

      // Reverte cupom/voucher — MESMA fonte do estorno proativo. Antes o chargeback NÃO
      // revertia, deixando o cupom com usageCount inflado e o voucher preso em USED.
      await this.orderFinalization.reverseSaleSideEffects(tx, payment.orderId);
    });

    this.logger.warn(
      `[REVERSAL] payment=${payment.id} order=${payment.orderId} tipo=${reversalType} cieloStatus=${cieloStatusStr}`,
    );
  }

  /**
   * Reconcilia estornos aplicados OTIMISTICAMENTE quando a Cielo retornou 'Pending'
   * (PaymentsRefundService grava `refundPendingConfirmation: true`). Re-checa o status
   * final na Cielo:
   *   - Reversão confirmada (Voided/Refunded) → limpa a flag (estorno OK).
   *   - Voltou a Authorized/Confirmed → o estorno NÃO ocorreu: sinaliza `refundReconcileFailed`
   *     para intervenção manual (reverter o estado financeiro automaticamente é arriscado).
   *   - Ainda Pending → mantém a flag; tenta de novo na próxima execução.
   *
   * Fecha o gap em que um estorno recusado depois pela Cielo ficava preso para sempre
   * (o cron de chargeback só varria PAID, nunca re-olhava os REFUNDED).
   */
  private async reconcilePendingRefunds(): Promise<void> {
    const pending = await this.prisma.getReadClient().payment.findMany({
      where: {
        status: PaymentStatus.REFUNDED,
        transactionId: { not: null },
        metadata: { path: ['refundPendingConfirmation'], equals: true },
      },
      select: { id: true, transactionId: true, metadata: true },
      take: BATCH_SIZE,
    });

    if (pending.length === 0) return;

    this.logger.log(`Reconciliando ${pending.length} estorno(s) pendente(s) de confirmação`);

    for (const p of pending) {
      const meta = (p.metadata ?? {}) as any;
      const cieloPaymentId: string | undefined = meta?.cieloPaymentId ?? p.transactionId ?? undefined;
      if (!cieloPaymentId) continue;

      try {
        const cieloData = await this.cieloService.getPayment(cieloPaymentId);
        if (!cieloData) continue;
        const status = cieloData.Payment.Status;

        if (REVERSAL_STATUSES.has(status)) {
          // Estorno confirmado de fato — remove a flag de pendência.
          const { refundPendingConfirmation: _drop, ...rest } = meta;
          await this.prisma.getWriteClient().payment.update({
            where: { id: p.id },
            data: { metadata: { ...rest, refundConfirmedAt: new Date().toISOString() } as any },
          });
        } else if (status === 1 || status === 2) {
          // Authorized(1)/PaymentConfirmed(2): o estorno NÃO se concretizou na Cielo,
          // mas localmente o pedido já foi cancelado/debitado. Requer ação manual.
          this.logger.error(
            `[REFUND-RECONCILE] payment ${p.id} segue status ${status} na Cielo — estorno NÃO confirmado. Requer intervenção manual.`,
          );
          await this.prisma.getWriteClient().payment.update({
            where: { id: p.id },
            data: {
              metadata: {
                ...meta,
                refundReconcileFailed: true,
                refundReconcileCheckedAt: new Date().toISOString(),
              } as any,
            },
          });
        }
        // status 12 (Pending): mantém a flag e tenta na próxima execução.
      } catch (err: any) {
        this.logger.warn(`Erro ao reconciliar estorno ${p.id}: ${err.message}`);
      }

      await new Promise<void>((resolve) => setTimeout(resolve, CALL_DELAY_MS));
    }
  }
}
