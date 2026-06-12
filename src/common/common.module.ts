import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

// Guards
import { RequestOriginGuard } from './guards/request-origin.guard';
import { BypassKeyGuard } from './guards/bypass-key.guard';
import { SecurityMonitoringService } from './services/security-monitoring.service';
import { SecurityAlertsService } from './services/security-alerts.service';
import { SecretRotationService } from './services/secret-rotation.service';
import { PerformanceMonitorService } from './services/performance-monitor.service';
import { PerformanceMonitorController } from './controllers/performance-monitor.controller';
import { ConcurrencyRedisService } from './services/concurrency-redis.service';
import { CacheRedisService } from './services/cache-redis.service';
import { UserActivityService } from './services/user-activity.service';
import { UserActivityCleanupService } from './services/user-activity-cleanup.service';
import { TrackActivityInterceptor } from './interceptors/track-activity.interceptor';

@Module({
  imports: [ConfigModule],
  controllers: [PerformanceMonitorController],
  providers: [
    RequestOriginGuard,
    BypassKeyGuard,
    ConfigService,
    SecurityMonitoringService,
    SecurityAlertsService,
    SecretRotationService,
    PerformanceMonitorService,
    ConcurrencyRedisService,
    CacheRedisService,
    UserActivityService,
    UserActivityCleanupService,
    TrackActivityInterceptor,
  ],
  exports: [
    RequestOriginGuard,
    BypassKeyGuard,
    SecurityMonitoringService,
    SecurityAlertsService,
    SecretRotationService,
    PerformanceMonitorService,
    ConcurrencyRedisService,
    CacheRedisService,
    UserActivityService,
    TrackActivityInterceptor,
  ],
})
export class CommonModule {}
