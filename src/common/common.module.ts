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

@Module({
  imports: [ConfigModule],
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
  ],
})
export class CommonModule {}
