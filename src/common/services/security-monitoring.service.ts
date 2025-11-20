import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

interface SecurityEvent {
  timestamp: Date;
  level: 'info' | 'warning' | 'error' | 'critical';
  category: string;
  message: string;
  metadata: Record<string, any>;
  source: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
}

interface AlertRule {
  id: string;
  name: string;
  condition: (event: SecurityEvent) => boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
  cooldown: number; // milliseconds
  lastTriggered?: number;
  enabled: boolean;
}

interface Alert {
  id: string;
  ruleId: string;
  timestamp: Date;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  metadata: Record<string, any>;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
}

@Injectable()
export class SecurityMonitoringService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SecurityMonitoringService.name);
  private readonly events: SecurityEvent[] = [];
  private readonly alerts: Alert[] = [];
  private readonly alertRules: AlertRule[] = [];
  private monitoringInterval: NodeJS.Timeout;
  private cleanupInterval: NodeJS.Timeout;

  // Configurações
  private readonly maxEvents = 10000; // Máximo de eventos em memória
  private readonly maxAlerts = 1000; // Máximo de alertas em memória
  private readonly retentionPeriod = 24 * 60 * 60 * 1000; // 24 horas

  constructor(
    private configService: ConfigService,
    private eventEmitter: EventEmitter2,
  ) {}

  onModuleInit() {
    this.initializeAlertRules();
    this.startMonitoring();
    this.startCleanup();
    this.logger.log('✅ Security monitoring service initialized');
  }

  onModuleDestroy() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  private initializeAlertRules() {
    // Regra para tentativas de login falhadas
    this.addAlertRule({
      id: 'failed-login-attempts',
      name: 'Multiple Failed Login Attempts',
      condition: (event) =>
        event.category === 'authentication' &&
        event.level === 'warning' &&
        event.message.includes('failed login'),
      severity: 'medium',
      cooldown: 15 * 60 * 1000, // 15 minutos
      enabled: true,
    });

    // Regra para tentativas de acesso não autorizado
    this.addAlertRule({
      id: 'unauthorized-access',
      name: 'Unauthorized Access Attempt',
      condition: (event) =>
        event.category === 'authorization' &&
        event.level === 'error' &&
        event.message.includes('unauthorized'),
      severity: 'high',
      cooldown: 5 * 60 * 1000, // 5 minutos
      enabled: true,
    });

    // Regra para ataques de força bruta
    this.addAlertRule({
      id: 'brute-force-attack',
      name: 'Potential Brute Force Attack',
      condition: (event) =>
        event.category === 'authentication' && event.metadata?.attempts > 5,
      severity: 'high',
      cooldown: 10 * 60 * 1000, // 10 minutos
      enabled: true,
    });

    // Regra para uploads suspeitos
    this.addAlertRule({
      id: 'suspicious-upload',
      name: 'Suspicious File Upload',
      condition: (event) =>
        event.category === 'upload' && event.level === 'warning',
      severity: 'medium',
      cooldown: 30 * 60 * 1000, // 30 minutos
      enabled: true,
    });

    // Regra para malware detectado
    this.addAlertRule({
      id: 'malware-detected',
      name: 'Malware Detected in Upload',
      condition: (event) =>
        event.category === 'upload' && event.message.includes('malware'),
      severity: 'critical',
      cooldown: 0, // Sempre alertar
      enabled: true,
    });

    // Regra para ataques SSRF
    this.addAlertRule({
      id: 'ssrf-attack',
      name: 'SSRF Attack Attempt',
      condition: (event) =>
        event.category === 'ssrf' && event.level === 'error',
      severity: 'critical',
      cooldown: 0, // Sempre alertar
      enabled: true,
    });

    // Regra para rate limiting atingido
    this.addAlertRule({
      id: 'rate-limit-exceeded',
      name: 'Rate Limit Exceeded',
      condition: (event) =>
        event.category === 'rate-limit' && event.level === 'warning',
      severity: 'medium',
      cooldown: 60 * 60 * 1000, // 1 hora
      enabled: true,
    });

    // Regra para tentativas de SQL injection
    this.addAlertRule({
      id: 'sql-injection-attempt',
      name: 'SQL Injection Attempt Detected',
      condition: (event) =>
        event.category === 'injection' && event.message.includes('sql'),
      severity: 'high',
      cooldown: 30 * 60 * 1000, // 30 minutos
      enabled: true,
    });

    this.logger.log(`✅ Initialized ${this.alertRules.length} alert rules`);
  }

  private startMonitoring() {
    // Verificar alertas a cada 30 segundos
    this.monitoringInterval = setInterval(() => {
      this.checkForAlerts();
      this.analyzeSecurityPatterns();
    }, 30000);
  }

  private startCleanup() {
    // Limpar eventos antigos a cada hora
    this.cleanupInterval = setInterval(
      () => {
        this.cleanupOldEvents();
      },
      60 * 60 * 1000,
    );
  }

  // Método principal para registrar eventos de segurança
  logSecurityEvent(
    level: 'info' | 'warning' | 'error' | 'critical',
    category: string,
    message: string,
    metadata: Record<string, any> = {},
    source: string = 'system',
    userId?: string,
    ip?: string,
    userAgent?: string,
  ) {
    const event: SecurityEvent = {
      timestamp: new Date(),
      level,
      category,
      message,
      metadata,
      source,
      userId,
      ip,
      userAgent,
    };

    // Adicionar à lista de eventos
    this.events.push(event);

    // Limitar tamanho da lista
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    // Emitir evento para outros serviços
    this.eventEmitter.emit('security.event', event);

    // Log no console com emoji apropriado
    const emoji = this.getLevelEmoji(level);
    this.logger.log(
      `${emoji} [${level.toUpperCase()}] ${category}: ${message}`,
    );

    // Verificar se deve gerar alerta imediatamente
    this.checkAlertRules(event);
  }

  private checkAlertRules(event: SecurityEvent) {
    for (const rule of this.alertRules) {
      if (!rule.enabled) continue;

      // Verificar cooldown
      if (
        rule.lastTriggered &&
        Date.now() - rule.lastTriggered < rule.cooldown
      ) {
        continue;
      }

      // Verificar condição
      if (rule.condition(event)) {
        this.generateAlert(rule, event);
        rule.lastTriggered = Date.now();
      }
    }
  }

  private generateAlert(rule: AlertRule, event: SecurityEvent) {
    const alert: Alert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      ruleId: rule.id,
      timestamp: new Date(),
      severity: rule.severity,
      title: rule.name,
      description: `Security alert triggered: ${event.message}`,
      metadata: {
        event,
        rule: rule.name,
      },
      acknowledged: false,
    };

    this.alerts.push(alert);

    // Limitar tamanho da lista
    if (this.alerts.length > this.maxAlerts) {
      this.alerts.shift();
    }

    // Emitir alerta
    this.eventEmitter.emit('security.alert', alert);

    // Log do alerta
    const emoji = this.getSeverityEmoji(rule.severity);
    this.logger.error(
      `${emoji} ALERT [${rule.severity.toUpperCase()}] ${rule.name}: ${event.message}`,
    );
  }

  private checkForAlerts() {
    // Verificar padrões de segurança
    this.checkForAnomalies();
    this.checkRateLimitViolations();
    this.checkFailedAuthentications();
  }

  private checkForAnomalies() {
    const now = Date.now();
    const lastHour = now - 60 * 60 * 1000;

    // Contar eventos por categoria na última hora
    const eventsByCategory = new Map<string, number>();
    const eventsByIP = new Map<string, number>();

    for (const event of this.events) {
      if (event.timestamp.getTime() > lastHour) {
        // Contar por categoria
        eventsByCategory.set(
          event.category,
          (eventsByCategory.get(event.category) || 0) + 1,
        );

        // Contar por IP
        if (event.ip) {
          eventsByIP.set(event.ip, (eventsByIP.get(event.ip) || 0) + 1);
        }
      }
    }

    // Verificar thresholds
    for (const [category, count] of eventsByCategory.entries()) {
      if (count > this.getThresholdForCategory(category)) {
        this.logSecurityEvent(
          'warning',
          'anomaly',
          `High frequency of ${category} events: ${count} in last hour`,
          {
            category,
            count,
            threshold: this.getThresholdForCategory(category),
          },
          'monitoring',
        );
      }
    }

    // Verificar IPs suspeitos
    for (const [ip, count] of eventsByIP.entries()) {
      if (count > 10) {
        this.logSecurityEvent(
          'warning',
          'anomaly',
          `Suspicious activity from IP ${ip}: ${count} events in last hour`,
          { ip, count },
          'monitoring',
        );
      }
    }
  }

  private getThresholdForCategory(category: string): number {
    const thresholds = {
      authentication: 50,
      authorization: 20,
      upload: 30,
      'rate-limit': 10,
      injection: 5,
      ssrf: 3,
    };

    return thresholds[category] || 25;
  }

  private checkRateLimitViolations() {
    // Implementar verificação de violações de rate limit
  }

  private checkFailedAuthentications() {
    // Implementar verificação de falhas de autenticação
  }

  private analyzeSecurityPatterns() {
    // Análise de padrões de segurança avançada
    const patterns = this.identifyPatterns();

    for (const pattern of patterns) {
      this.logSecurityEvent(
        pattern.severity,
        'pattern-analysis',
        pattern.description,
        pattern.metadata,
        'ai-analysis',
      );
    }
  }

  private identifyPatterns(): Array<{
    severity: 'info' | 'warning' | 'error' | 'critical';
    description: string;
    metadata: Record<string, any>;
  }> {
    const patterns = [];
    const now = Date.now();
    const lastHour = now - 60 * 60 * 1000;

    // Padrão: Ataque de força bruta
    const recentAuthFailures = this.events.filter(
      (event) =>
        event.timestamp.getTime() > lastHour &&
        event.category === 'authentication' &&
        event.level === 'warning',
    );

    if (recentAuthFailures.length > 20) {
      patterns.push({
        severity: 'error',
        description: 'Potential brute force attack detected',
        metadata: {
          failures: recentAuthFailures.length,
          timeWindow: '1 hour',
          recommendation: 'Implement account lockout and CAPTCHA',
        },
      });
    }

    // Padrão: Scan de vulnerabilidades
    const recentScans = this.events.filter(
      (event) =>
        event.timestamp.getTime() > lastHour &&
        (event.message.includes('404') || event.message.includes('forbidden')),
    );

    if (recentScans.length > 50) {
      patterns.push({
        severity: 'warning',
        description: 'Potential vulnerability scanning detected',
        metadata: {
          scans: recentScans.length,
          timeWindow: '1 hour',
          recommendation: 'Monitor for automated scanning tools',
        },
      });
    }

    return patterns;
  }

  private cleanupOldEvents() {
    const cutoffTime = Date.now() - this.retentionPeriod;

    // Limpar eventos antigos
    const oldEventsCount = this.events.length;
    this.events.splice(
      0,
      this.events.findIndex((event) => event.timestamp.getTime() > cutoffTime),
    );

    // Limpar alertas antigos
    const oldAlertsCount = this.alerts.length;
    this.alerts.splice(
      0,
      this.alerts.findIndex((alert) => alert.timestamp.getTime() > cutoffTime),
    );

    if (
      oldEventsCount > this.events.length ||
      oldAlertsCount > this.alerts.length
    ) {
      this.logger.log(
        `🧹 Cleaned up old security data: ${oldEventsCount - this.events.length} events, ${oldAlertsCount - this.alerts.length} alerts`,
      );
    }
  }

  // Métodos públicos para consulta
  getRecentEvents(limit: number = 100): SecurityEvent[] {
    return this.events.slice(-limit);
  }

  getActiveAlerts(): Alert[] {
    return this.alerts.filter((alert) => !alert.acknowledged);
  }

  getAllAlerts(limit: number = 50): Alert[] {
    return this.alerts.slice(-limit);
  }

  acknowledgeAlert(alertId: string, userId: string): boolean {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (alert && !alert.acknowledged) {
      alert.acknowledged = true;
      alert.acknowledgedBy = userId;
      alert.acknowledgedAt = new Date();

      this.logger.log(`✅ Alert ${alertId} acknowledged by ${userId}`);
      return true;
    }
    return false;
  }

  // Método para obter estatísticas de segurança
  getSecurityStats(): Record<string, any> {
    const now = Date.now();
    const lastHour = now - 60 * 60 * 1000;
    const last24Hours = now - 24 * 60 * 60 * 1000;

    const recentEvents = this.events.filter(
      (event) => event.timestamp.getTime() > lastHour,
    );
    const recentAlerts = this.alerts.filter(
      (alert) => alert.timestamp.getTime() > last24Hours,
    );

    // Estatísticas por categoria
    const eventsByCategory = {};
    const eventsByLevel = {};

    for (const event of recentEvents) {
      eventsByCategory[event.category] =
        (eventsByCategory[event.category] || 0) + 1;
      eventsByLevel[event.level] = (eventsByLevel[event.level] || 0) + 1;
    }

    // Estatísticas de alertas
    const alertsBySeverity = {};
    for (const alert of recentAlerts) {
      alertsBySeverity[alert.severity] =
        (alertsBySeverity[alert.severity] || 0) + 1;
    }

    return {
      summary: {
        totalEvents: this.events.length,
        totalAlerts: this.alerts.length,
        activeAlerts: this.getActiveAlerts().length,
        recentEventsLastHour: recentEvents.length,
        recentAlertsLast24Hours: recentAlerts.length,
      },
      eventsByCategory,
      eventsByLevel,
      alertsBySeverity,
      topIPs: this.getTopIPs(10),
      timestamp: new Date().toISOString(),
    };
  }

  private getTopIPs(limit: number = 10): Array<{ ip: string; count: number }> {
    const ipCounts = new Map<string, number>();

    for (const event of this.events) {
      if (event.ip) {
        ipCounts.set(event.ip, (ipCounts.get(event.ip) || 0) + 1);
      }
    }

    return Array.from(ipCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([ip, count]) => ({ ip, count }));
  }

  // Método para adicionar regras de alerta dinamicamente
  addAlertRule(rule: Omit<AlertRule, 'lastTriggered'>) {
    const existingRule = this.alertRules.find((r) => r.id === rule.id);
    if (existingRule) {
      Object.assign(existingRule, rule);
    } else {
      this.alertRules.push({
        ...rule,
        lastTriggered: undefined,
      });
    }
  }

  // Método para remover regras de alerta
  removeAlertRule(ruleId: string): boolean {
    const index = this.alertRules.findIndex((rule) => rule.id === ruleId);
    if (index !== -1) {
      this.alertRules.splice(index, 1);
      return true;
    }
    return false;
  }

  // Método para habilitar/desabilitar regras
  toggleAlertRule(ruleId: string, enabled: boolean): boolean {
    const rule = this.alertRules.find((r) => r.id === ruleId);
    if (rule) {
      rule.enabled = enabled;
      return true;
    }
    return false;
  }

  private getLevelEmoji(level: string): string {
    switch (level) {
      case 'info':
        return 'ℹ️';
      case 'warning':
        return '⚠️';
      case 'error':
        return '❌';
      case 'critical':
        return '🔴';
      default:
        return '❓';
    }
  }

  private getSeverityEmoji(severity: string): string {
    switch (severity) {
      case 'low':
        return '🟢';
      case 'medium':
        return '🟡';
      case 'high':
        return '🟠';
      case 'critical':
        return '🔴';
      default:
        return '❓';
    }
  }
}
