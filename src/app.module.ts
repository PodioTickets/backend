import { ThrottlerModule } from '@nestjs/throttler';
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { UploadModule } from './app/upload/upload.module';
import { UserModule } from './app/user/user.module';
import { UserService } from './app/user/user.service';
import { HttpCacheInterceptor } from './common/interceptors/http-cache.interceptor';
import { ConcurrencyLimiterMiddleware } from './common/middleware/concurrency-limiter.middleware';
import { PerformanceMonitoringMiddleware } from './common/middleware/performance-monitoring.middleware';
import { AuthModule } from './app/auth/auth.module';
import { ResponseCompressionInterceptor } from './common/interceptors/response-compression.interceptor';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommonModule } from './common/common.module';
import { getCacheConfig } from './config/cache.config';
import { CdnService } from './common/services/cdn.service';
import { EventsModule } from './app/events/events.module';
import { OrganizersModule } from './app/organizers/organizers.module';
import { OrganizationsModule } from './app/organizations/organizations.module';
import { RegistrationsModule } from './app/registrations/registrations.module';
import { PaymentsModule } from './app/payments/payments.module';
import { KitsModule } from './app/kits/kits.module';
import { ModalitiesModule } from './app/modalities/modalities.module';
import { QuestionsModule } from './app/questions/questions.module';
import { CouponsModule } from './app/coupons/coupons.module';
import { VouchersModule } from './app/vouchers/vouchers.module';
import { TicketCategoriesModule } from './app/ticket-categories/ticket-categories.module';
import { TicketsModule } from './app/tickets/tickets.module';
import { ProductsModule } from './app/products/products.module';
import { CheckoutModule } from './app/checkout/checkout.module';
import { OrdersModule } from './app/orders/orders.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    EventEmitterModule.forRoot(),
    getCacheConfig(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1000, limit: 10 },
      { name: 'medium', ttl: 10000, limit: 50 },
      { name: 'long', ttl: 60000, limit: 200 },
    ]),
    UploadModule,
    UserModule,
    AuthModule,
    ConfigModule,
    CommonModule,
    EventsModule,
    OrganizersModule,
    OrganizationsModule,
    RegistrationsModule,
    PaymentsModule,
    KitsModule,
    ModalitiesModule,
    QuestionsModule,
    CouponsModule,
    VouchersModule,
    TicketCategoriesModule,
    TicketsModule,
    ProductsModule,
    CheckoutModule,
    OrdersModule,
  ],
  controllers: [],
  providers: [
    UserService,
    ConcurrencyLimiterMiddleware,
    PerformanceMonitoringMiddleware,
    ResponseCompressionInterceptor,
    CdnService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: HttpCacheInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseCompressionInterceptor },
  ],
  exports: [],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(ConcurrencyLimiterMiddleware)
      .exclude('/api/v1/upload', '/api/v1/upload/*')
      .forRoutes('*');

    consumer.apply(PerformanceMonitoringMiddleware).forRoutes('*');
  }
}
