import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from './cielo.service';
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
  ) {}

  @Cron('0 * * * *') // todo início de hora
  @CronTimeout(5 * 60 * 1000) // timeout de 5 minutos
  async checkChargebacks(): Promise<void> {
    // Não executa em sandbox — não há chargebacks reais
    if (this.cieloService.sandboxMode) return;

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
    });

    this.logger.warn(
      `[REVERSAL] payment=${payment.id} order=${payment.orderId} tipo=${reversalType} cieloStatus=${cieloStatusStr}`,
    );
  }
}
