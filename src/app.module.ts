import { ThrottlerModule } from '@nestjs/throttler';
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { UploadModule } from './app/upload/upload.module';
import { UserModule } from './app/user/user.module';
import { UserService } from './app/user/user.service';
import { HttpCacheInterceptor } from './common/interceptors/http-cache.interceptor';
import { ConcurrencyLimiterMiddleware } from './common/middleware/concurrency-limiter.middleware';
import { AuthModule } from './app/auth/auth.module';
import { ResponseCompressionInterceptor } from './common/interceptors/response-compression.interceptor';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommonModule } from './common/common.module';
import { getCacheConfig } from './config/cache.config';
import { CdnService } from './common/services/cdn.service';
import { EventsModule } from './app/events/events.module';
import { OrganizersModule } from './app/organizers/organizers.module';
import { RegistrationsModule } from './app/registrations/registrations.module';
import { PaymentsModule } from './app/payments/payments.module';
import { KitsModule } from './app/kits/kits.module';
import { ModalitiesModule } from './app/modalities/modalities.module';
import { QuestionsModule } from './app/questions/questions.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    EventEmitterModule.forRoot(),
    getCacheConfig(), // Redis em produção, cache em memória em desenvolvimento
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,
        limit: 10, // Aumentado de 3 para 10 para não bloquear usuários legítimos
      },
      {
        name: 'medium',
        ttl: 10000,
        limit: 50, // Aumentado de 20 para 50
      },
      {
        name: 'long',
        ttl: 60000,
        limit: 200, // Aumentado de 100 para 200
      },
    ]),
    UploadModule,
    UserModule,
    AuthModule,
    ConfigModule,
    CommonModule,
    // PodioGo Modules
    EventsModule,
    OrganizersModule,
    RegistrationsModule,
    PaymentsModule,
    KitsModule,
    ModalitiesModule,
    QuestionsModule,
  ],
  controllers: [],
  providers: [
    UserService,
    ResponseCompressionInterceptor,
    CdnService,
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
  }
}
