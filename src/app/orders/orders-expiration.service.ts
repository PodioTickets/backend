import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrdersService } from './orders.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class OrdersExpirationService {
  private readonly logger = new Logger(OrdersExpirationService.name);

  constructor(
    private readonly ordersService: OrdersService,
    private readonly paymentsService: PaymentsService,
  ) {}

  @Cron('*/30 * * * * *') // every 30 seconds
  async handleExpiredOrders(): Promise<void> {
    try {
      const cancelled = await this.ordersService.cancelExpiredOrders((orderId, userId) =>
        this.paymentsService.pollPixStatus(orderId, userId).then(
          (r) => r.paid,
          // Erro ao confirmar (ex.: finalize falhou): NÃO cancela neste tick (tenta de novo
          // em 30s) — cancelar faria um PIX pago virar estorno. Cielo indisponível não cai
          // aqui: `getPayment` devolve null → "não pago" → cancela; pagamento posterior é estornado.
          (e: any) => {
            this.logger.warn(`PIX check failed for order ${orderId}: ${e?.message ?? e}`);
            return true;
          },
        ),
      );
      if (cancelled > 0) {
        this.logger.log(`Expired and cancelled ${cancelled} order(s)`);
      }
    } catch (e: any) {
      this.logger.error(`Expiration cron failed: ${e.message}`);
    }
  }
}
