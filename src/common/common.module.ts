import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

// Guards
import { CsrfGuard } from './guards/csrf.guard';
import { RequestOriginGuard } from './guards/request-origin.guard';
import { BypassKeyGuard } from './guards/bypass-key.guard';
import { SecurityService } from './services/security.service';
import { SecurityLoggingInterceptor } from './interceptors/security-logging.interceptor';
import { SecurityMonitoringService } from './services/security-monitoring.service';
import { SecurityAlertsService } from './services/security-alerts.service';
import { SecretRotationService } from './services/secret-rotation.service';
import { PerformanceMonitorService } from './services/performance-monitor.service';
import { PerformanceMonitorController } from './controllers/performance-monitor.controller';
import { ConcurrencyRedisService } from './services/concurrency-redis.service';

@Module({
  imports: [ConfigModule],
  controllers: [PerformanceMonitorController],
  providers: [
    CsrfGuard,
    RequestOriginGuard,
    BypassKeyGuard,
    SecurityService,
    SecurityLoggingInterceptor,
    ConfigService,
    SecurityMonitoringService,
    SecurityAlertsService,
    SecretRotationService,
    PerformanceMonitorService,
    ConcurrencyRedisService,
  ],
  exports: [
    CsrfGuard,
    RequestOriginGuard,
    BypassKeyGuard,
    SecurityService,
    SecurityLoggingInterceptor,
    SecurityMonitoringService,
    SecurityAlertsService,
    SecretRotationService,
    PerformanceMonitorService,
    ConcurrencyRedisService,
  ],
})
export class CommonModule {}
