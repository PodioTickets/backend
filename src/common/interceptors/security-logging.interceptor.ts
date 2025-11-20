import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';

export enum SecurityEventType {
  CONTRACT_INTERACTION = 'contract_interaction',
  CSRF_ATTEMPT = 'csrf_attempt',
  INVALID_INPUT = 'invalid_input',
  TRANSACTION_VALIDATION_FAILED = 'transaction_validation_failed',
  REPLAY_ATTACK = 'replay_attack',
}

export enum SecuritySeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

@Injectable()
export class SecurityLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('SecurityLogger');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const startTime = Date.now();

    // Log da requisição inicial
    this.logEvent(
      SecurityEventType.CONTRACT_INTERACTION,
      `Lootbox API chamada: ${request.body?.action || request.method}`,
      { action: request.body?.action },
      SecuritySeverity.LOW,
      request
    );

    return next.handle().pipe(
      tap({
        next: (data) => {
          const duration = Date.now() - startTime;
          this.logger.log(
            `✅ Request completed successfully in ${duration}ms`,
            'SecurityLogger'
          );
        },
        error: (error) => {
          const duration = Date.now() - startTime;
          this.logEvent(
            SecurityEventType.CONTRACT_INTERACTION,
            `Erro na API lootbox: ${error.message || 'Unknown error'}`,
            {
              error: error.message || 'Unknown error',
              statusCode: error.status || 500,
              duration,
            },
            SecuritySeverity.HIGH,
            request
          );
        },
      })
    );
  }

  logEvent(
    eventType: SecurityEventType,
    message: string,
    metadata: any,
    severity: SecuritySeverity,
    request?: Request
  ) {
    const logData = {
      timestamp: new Date().toISOString(),
      eventType,
      message,
      severity,
      metadata,
      requestInfo: request ? {
        ip: request.ip || request.connection?.remoteAddress,
        userAgent: request.headers['user-agent'],
        origin: request.headers.origin,
        referer: request.headers.referer,
        method: request.method,
        url: request.url,
      } : null,
    };

    const emoji = this.getSeverityEmoji(severity);
    const logMessage = `${emoji} [${severity.toUpperCase()}] ${eventType}: ${message}`;

    switch (severity) {
      case SecuritySeverity.LOW:
        this.logger.log(logMessage, 'SecurityLogger');
        break;
      case SecuritySeverity.MEDIUM:
        this.logger.warn(logMessage, 'SecurityLogger');
        break;
      case SecuritySeverity.HIGH:
      case SecuritySeverity.CRITICAL:
        this.logger.error(logMessage, 'SecurityLogger');
        break;
    }

    // Aqui você poderia integrar com um sistema de logging externo
    // como DataDog, LogRocket, etc.
  }

  logInvalidInput(field: string, value: any, request?: Request) {
    this.logEvent(
      SecurityEventType.INVALID_INPUT,
      `Invalid input for field: ${field}`,
      { field, value: typeof value === 'string' ? value.substring(0, 100) : value },
      SecuritySeverity.MEDIUM,
      request
    );
  }

  logReplayAttack(wallet: string, timestamp: number, request?: Request) {
    this.logEvent(
      SecurityEventType.REPLAY_ATTACK,
      `Replay attack detected for wallet: ${wallet}`,
      { wallet, timestamp },
      SecuritySeverity.HIGH,
      request
    );
  }

  logTransactionValidationFailed(
    txHash: string,
    error: string,
    request?: Request
  ) {
    this.logEvent(
      SecurityEventType.TRANSACTION_VALIDATION_FAILED,
      `Transaction validation failed: ${error}`,
      { txHash },
      SecuritySeverity.HIGH,
      request
    );
  }

  private getSeverityEmoji(severity: SecuritySeverity): string {
    switch (severity) {
      case SecuritySeverity.LOW:
        return 'ℹ️';
      case SecuritySeverity.MEDIUM:
        return '⚠️';
      case SecuritySeverity.HIGH:
        return '🚨';
      case SecuritySeverity.CRITICAL:
        return '🔴';
      default:
        return '❓';
    }
  }
}
