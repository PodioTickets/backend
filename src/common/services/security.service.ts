import { Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { SecurityLoggingInterceptor, SecuritySeverity } from '../interceptors/security-logging.interceptor';

@Injectable()
export class SecurityService {
  private readonly logger = new Logger('SecurityService');
  private readonly securityLogger = new SecurityLoggingInterceptor();

  logInvalidInput(field: string, value: any, request?: Request) {
    this.securityLogger.logInvalidInput(field, value, request);
  }

  logReplayAttack(wallet: string, timestamp: number, request?: Request) {
    this.securityLogger.logReplayAttack(wallet, timestamp, request);
  }

  logTransactionValidationFailed(
    txHash: string,
    error: string,
    request?: Request
  ) {
    this.securityLogger.logTransactionValidationFailed(txHash, error, request);
  }

  logEvent(
    eventType: string,
    message: string,
    metadata: any,
    severity: 'low' | 'medium' | 'high' | 'critical',
    request?: Request
  ) {
    const severityMap = {
      low: SecuritySeverity.LOW,
      medium: SecuritySeverity.MEDIUM,
      high: SecuritySeverity.HIGH,
      critical: SecuritySeverity.CRITICAL,
    };

    this.securityLogger.logEvent(
      eventType as any,
      message,
      metadata,
      severityMap[severity],
      request
    );
  }

  // Método para sanitizar dados sensíveis antes do logging
  sanitizeForLogging(data: any): any {
    if (!data || typeof data !== 'object') return data;

    const sensitiveFields = [
      'privateKey',
      'secret',
      'password',
      'token',
      'apiKey',
      'csrfSecret',
    ];

    const sanitized = { ...data };

    for (const field of sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    }

    // Sanitizar valores longos
    Object.keys(sanitized).forEach(key => {
      const value = sanitized[key];
      if (typeof value === 'string' && value.length > 100) {
        sanitized[key] = value.substring(0, 100) + '...[TRUNCATED]';
      }
    });

    return sanitized;
  }

  // Método para validar rate limiting básico (pode ser expandido)
  checkRateLimit(identifier: string, windowMs: number = 60000, maxRequests: number = 10): boolean {
    // Implementação básica de rate limiting
    // Em produção, usar Redis ou similar para persistência
    const key = `ratelimit:${identifier}`;
    const now = Date.now();

    // Esta é uma implementação simplificada
    // Em produção, armazenar em cache/Redis
    if (!global.rateLimitStore) {
      global.rateLimitStore = new Map();
    }

    const store = global.rateLimitStore as Map<string, number[]>;
    const requests = store.get(key) || [];

    // Filtrar requests fora da janela
    const validRequests = requests.filter(time => now - time < windowMs);

    if (validRequests.length >= maxRequests) {
      return false;
    }

    // Adicionar nova request
    validRequests.push(now);
    store.set(key, validRequests);

    return true;
  }

  // Método para gerar hash seguro para identificação
  generateSecureHash(data: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  // Método para validar formato de dados
  validateDataFormat(data: any, schema: any): boolean {
    // Implementação básica de validação de schema
    // Pode ser expandida com bibliotecas como Joi ou Yup
    try {
      if (!data || typeof data !== 'object') return false;

      for (const [key, rules] of Object.entries(schema)) {
        const value = data[key];
        const rule = rules as any;

        if (rule.required && (value === undefined || value === null)) {
          return false;
        }

        if (value !== undefined && rule.type) {
          if (rule.type === 'string' && typeof value !== 'string') return false;
          if (rule.type === 'number' && typeof value !== 'number') return false;
          if (rule.type === 'boolean' && typeof value !== 'boolean') return false;
        }

        if (rule.minLength && typeof value === 'string' && value.length < rule.minLength) {
          return false;
        }

        if (rule.maxLength && typeof value === 'string' && value.length > rule.maxLength) {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }
}
