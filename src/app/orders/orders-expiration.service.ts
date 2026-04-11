import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrdersService } from './orders.service';

@Injectable()
export class OrdersExpirationService {
  private readonly logger = new Logger(OrdersExpirationService.name);

  constructor(private readonly ordersService: OrdersService) {}

  @Cron('*/30 * * * * *') // every 30 seconds
  async handleExpiredOrders(): Promise<void> {
    try {
      const cancelled = await this.ordersService.cancelExpiredOrders();
      if (cancelled > 0) {
        this.logger.log(`Expired and cancelled ${cancelled} order(s)`);
      }
    } catch (e: any) {
      this.logger.error(`Expiration cron failed: ${e.message}`);
    }
  }
}
