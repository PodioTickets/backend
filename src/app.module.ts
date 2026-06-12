import { ThrottlerModule } from '@nestjs/throttler';
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { UploadModule } from './app/upload/upload.module';
import { UserModule } from './app/user/user.module';
import { ConcurrencyLimiterMiddleware } from './common/middleware/concurrency-limiter.middleware';
import { PerformanceMonitoringMiddleware } from './common/middleware/performance-monitoring.middleware';
import { AuthModule } from './app/auth/auth.module';
import { ResponseCompressionInterceptor } from './common/interceptors/response-compression.interceptor';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { IpThrottlerGuard } from './common/guards/ip-throttler.guard';
import { RequestOriginGuard } from './common/guards/request-origin.guard';
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
import { OrdersModule } from './app/orders/orders.module';
import { RepasseModule } from './app/repasse/repasse.module';
import { AdminModule } from './app/admin/admin.module';
import { UserActivityModule } from './app/user-activity/user-activity.module';
import { GeoModule } from './app/geo/geo.module';

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
    OrdersModule,
    RepasseModule,
    AdminModule,
    UserActivityModule,
    GeoModule,
  ],
  controllers: [],
  providers: [
    ConcurrencyLimiterMiddleware,
    PerformanceMonitoringMiddleware,
    ResponseCompressionInterceptor,
    CdnService,
    { provide: APP_GUARD, useClass: IpThrottlerGuard },
    // CSRF stateless: bloqueia mutações com Origin estrangeiro (libera sem Origin
    // = server-to-server/webhook). Global pra cobrir toda rota que muda estado.
    { provide: APP_GUARD, useClass: RequestOriginGuard },
    // HttpCacheInterceptor REMOVIDO (2026-05-31): não cacheamos resposta de NENHUMA rota GET
    // server-side. O cache-manager (CacheModule) continua para auth (rate-limit/MFA/reset) e os
    // caches internos de domínio usam CacheRedisService. Toda resposta sai fresca + `no-store`
    // (SecurityHeadersInterceptor). Para reativar cache de uma rota específica no futuro, re-registrar
    // o interceptor e usar @CacheTTL — preferir cache no service (CacheRedisService) por slot.
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
