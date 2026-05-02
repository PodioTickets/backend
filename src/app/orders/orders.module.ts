import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentsModule } from '../payments/payments.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { OrdersService } from './orders.service';
import { OrdersExpirationService } from './orders-expiration.service';
import { OrdersRedisService } from './orders-redis.service';
import { OrdersController } from './orders.controller';
import { EmailService } from '../../common/services/email.service';
import { TicketPdfService } from '../../common/services/ticket-pdf.service';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    PaymentsModule, // exports CieloService
  ],
  providers: [OrdersService, OrdersExpirationService, OrdersRedisService, EmailService, TicketPdfService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
