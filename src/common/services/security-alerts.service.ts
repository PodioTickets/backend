import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import * as nodemailer from 'nodemailer';
import axios from 'axios';

interface AlertChannel {
  id: string;
  type: 'email' | 'slack' | 'discord' | 'webhook' | 'sms';
  enabled: boolean;
  config: Record<string, any>;
  rules: AlertRule[];
}

interface AlertRule {
  id: string;
  name: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  enabled: boolean;
  cooldown: number; // milliseconds
  lastTriggered?: number;
}

interface AlertMessage {
  id: string;
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  timestamp: Date;
  metadata: Record<string, any>;
  source: string;
}

@Injectable()
export class SecurityAlertsService implements OnModuleInit {
  private readonly logger = new Logger(SecurityAlertsService.name);
  private readonly channels: AlertChannel[] = [];
  private emailTransporter: nodemailer.Transporter;

  constructor(
    private configService: ConfigService,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    await this.initializeChannels();
    await this.initializeEmailTransporter();
    this.logger.log('✅ Security alerts service initialized');
  }

  private async initializeChannels() {
    // Canal de email
    this.channels.push({
      id: 'email-admin',
      type: 'email',
      enabled: true,
      config: {
        recipients: this.configService.get<string>('ALERT_EMAIL_RECIPIENTS', 'admin@loot4fun.com').split(','),
        subject: '🚨 Loot4Fun Security Alert',
      },
      rules: [
        { id: 'high-severity', name: 'High Severity Alerts', severity: 'high', enabled: true, cooldown: 5 * 60 * 1000 },
        { id: 'critical-severity', name: 'Critical Severity Alerts', severity: 'critical', enabled: true, cooldown: 0 },
      ],
    });

    // Canal Slack (opcional)
    const slackWebhook = this.configService.get<string>('SLACK_WEBHOOK_URL');
    if (slackWebhook) {
      this.channels.push({
        id: 'slack-security',
        type: 'slack',
        enabled: true,
        config: {
          webhookUrl: slackWebhook,
          channel: '#security-alerts',
          username: 'Loot4Fun Security Bot',
        },
        rules: [
          { id: 'all-alerts', name: 'All Security Alerts', severity: 'low', enabled: true, cooldown: 10 * 60 * 1000 },
        ],
      });
    }

    // Canal Discord (opcional)
    const discordWebhook = this.configService.get<string>('DISCORD_WEBHOOK_URL');
    if (discordWebhook) {
      this.channels.push({
        id: 'discord-alerts',
        type: 'discord',
        enabled: true,
        config: {
          webhookUrl: discordWebhook,
        },
        rules: [
          { id: 'high-critical', name: 'High & Critical Alerts', severity: 'high', enabled: true, cooldown: 0 },
        ],
      });
    }

    // Canal webhook genérico (opcional)
    const webhookUrl = this.configService.get<string>('ALERT_WEBHOOK_URL');
    if (webhookUrl) {
      this.channels.push({
        id: 'webhook-external',
        type: 'webhook',
        enabled: true,
        config: {
          url: webhookUrl,
          headers: {
            'Authorization': `Bearer ${this.configService.get<string>('WEBHOOK_TOKEN', '')}`,
            'Content-Type': 'application/json',
          },
        },
        rules: [
          { id: 'all-events', name: 'All Security Events', severity: 'low', enabled: true, cooldown: 30 * 1000 },
        ],
      });
    }

    this.logger.log(`✅ Initialized ${this.channels.length} alert channels`);
  }

  private async initializeEmailTransporter() {
    const smtpConfig = {
      host: this.configService.get<string>('SMTP_HOST', 'smtp.gmail.com'),
      port: this.configService.get<number>('SMTP_PORT', 587),
      secure: this.configService.get<boolean>('SMTP_SECURE', false),
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    };

    // Só inicializar se as credenciais estiverem configuradas
    if (smtpConfig.auth.user && smtpConfig.auth.pass) {
      this.emailTransporter = nodemailer.createTransport(smtpConfig);
      this.logger.log('✅ Email transporter initialized');
    } else {
      this.logger.warn('⚠️ Email transporter not configured - email alerts disabled');
    }
  }

  @OnEvent('security.alert')
  async handleSecurityAlert(alert: any) {
    try {
      const alertMessage: AlertMessage = {
        id: alert.id,
        title: alert.title,
        description: alert.description,
        severity: alert.severity,
        category: alert.metadata?.event?.category || 'unknown',
        timestamp: alert.timestamp,
        metadata: alert.metadata,
        source: 'security-monitoring',
      };

      await this.sendAlertToChannels(alertMessage);

      this.logger.log(`📤 Alert sent to channels: ${alert.title}`);
    } catch (error) {
      this.logger.error('❌ Failed to handle security alert:', error);
    }
  }

  @OnEvent('security.event')
  async handleSecurityEvent(event: any) {
    try {
      // Só enviar alertas para eventos críticos
      if (event.level === 'critical' || event.level === 'error') {
        const alertMessage: AlertMessage = {
          id: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          title: `Security Event: ${event.category}`,
          description: event.message,
          severity: this.mapEventLevelToSeverity(event.level),
          category: event.category,
          timestamp: event.timestamp,
          metadata: event.metadata,
          source: event.source,
        };

        await this.sendAlertToChannels(alertMessage);
      }
    } catch (error) {
      this.logger.error('❌ Failed to handle security event:', error);
    }
  }

  private mapEventLevelToSeverity(level: string): 'low' | 'medium' | 'high' | 'critical' {
    switch (level) {
      case 'critical': return 'critical';
      case 'error': return 'high';
      case 'warning': return 'medium';
      case 'info': return 'low';
      default: return 'medium';
    }
  }

  private async sendAlertToChannels(alert: AlertMessage) {
    const enabledChannels = this.channels.filter(channel => channel.enabled);

    for (const channel of enabledChannels) {
      // Verificar se o canal deve receber este alerta
      if (this.shouldSendToChannel(channel, alert)) {
        try {
          await this.sendAlertToChannel(channel, alert);
        } catch (error) {
          this.logger.error(`❌ Failed to send alert to ${channel.type} channel ${channel.id}:`, error);
        }
      }
    }
  }

  private shouldSendToChannel(channel: AlertChannel, alert: AlertMessage): boolean {
    return channel.rules.some(rule =>
      rule.enabled &&
      this.isSeverityMatch(rule.severity, alert.severity) &&
      this.isCooldownExpired(rule)
    );
  }

  private isSeverityMatch(ruleSeverity: string, alertSeverity: string): boolean {
    const severityLevels = { 'low': 1, 'medium': 2, 'high': 3, 'critical': 4 };
    return severityLevels[alertSeverity] >= severityLevels[ruleSeverity];
  }

  private isCooldownExpired(rule: AlertRule): boolean {
    if (!rule.lastTriggered) return true;
    return Date.now() - rule.lastTriggered >= rule.cooldown;
  }

  private async sendAlertToChannel(channel: AlertChannel, alert: AlertMessage) {
    switch (channel.type) {
      case 'email':
        await this.sendEmailAlert(channel, alert);
        break;
      case 'slack':
        await this.sendSlackAlert(channel, alert);
        break;
      case 'discord':
        await this.sendDiscordAlert(channel, alert);
        break;
      case 'webhook':
        await this.sendWebhookAlert(channel, alert);
        break;
      default:
        this.logger.warn(`⚠️ Unknown channel type: ${channel.type}`);
    }

    // Atualizar timestamp do último envio
    const rule = channel.rules.find(r => this.shouldSendToChannel(channel, alert));
    if (rule) {
      rule.lastTriggered = Date.now();
    }
  }

  private async sendEmailAlert(channel: AlertChannel, alert: AlertMessage) {
    if (!this.emailTransporter) {
      this.logger.warn('⚠️ Email transporter not configured');
      return;
    }

    const recipients = channel.config.recipients;
    const subject = `${this.getSeverityEmoji(alert.severity)} ${channel.config.subject} - ${alert.title}`;

    const htmlContent = this.generateEmailContent(alert);

    try {
      await this.emailTransporter.sendMail({
        from: this.configService.get<string>('SMTP_FROM', 'alerts@loot4fun.com'),
        to: recipients,
        subject,
        html: htmlContent,
      });

      this.logger.log(`📧 Email alert sent to ${recipients.join(', ')}`);
    } catch (error) {
      this.logger.error('❌ Failed to send email alert:', error);
      throw error;
    }
  }

  private async sendSlackAlert(channel: AlertChannel, alert: AlertMessage) {
    const payload = {
      channel: channel.config.channel,
      username: channel.config.username,
      icon_emoji: this.getSeverityEmoji(alert.severity),
      text: `*${alert.title}*\n${alert.description}`,
      attachments: [
        {
          color: this.getSeverityColor(alert.severity),
          fields: [
            {
              title: 'Severity',
              value: alert.severity.toUpperCase(),
              short: true,
            },
            {
              title: 'Category',
              value: alert.category,
              short: true,
            },
            {
              title: 'Time',
              value: alert.timestamp.toISOString(),
              short: true,
            },
            {
              title: 'Source',
              value: alert.source,
              short: true,
            },
          ],
        },
      ],
    };

    try {
      await axios.post(channel.config.webhookUrl, payload);
      this.logger.log(`📱 Slack alert sent to ${channel.config.channel}`);
    } catch (error) {
      this.logger.error('❌ Failed to send Slack alert:', error);
      throw error;
    }
  }

  private async sendDiscordAlert(channel: AlertChannel, alert: AlertMessage) {
    const embed = {
      title: alert.title,
      description: alert.description,
      color: this.getSeverityColorNumber(alert.severity),
      fields: [
        {
          name: 'Severity',
          value: alert.severity.toUpperCase(),
          inline: true,
        },
        {
          name: 'Category',
          value: alert.category,
          inline: true,
        },
        {
          name: 'Time',
          value: alert.timestamp.toISOString(),
          inline: true,
        },
      ],
      timestamp: alert.timestamp.toISOString(),
    };

    const payload = {
      embeds: [embed],
    };

    try {
      await axios.post(channel.config.webhookUrl, payload);
      this.logger.log('🎮 Discord alert sent');
    } catch (error) {
      this.logger.error('❌ Failed to send Discord alert:', error);
      throw error;
    }
  }

  private async sendWebhookAlert(channel: AlertChannel, alert: AlertMessage) {
    const payload = {
      alert: {
        id: alert.id,
        title: alert.title,
        description: alert.description,
        severity: alert.severity,
        category: alert.category,
        timestamp: alert.timestamp,
        metadata: alert.metadata,
        source: alert.source,
      },
      system: 'Loot4Fun API',
      version: '1.0.0',
    };

    try {
      await axios.post(channel.config.url, payload, {
        headers: channel.config.headers,
      });
      this.logger.log('🔗 Webhook alert sent');
    } catch (error) {
      this.logger.error('❌ Failed to send webhook alert:', error);
      throw error;
    }
  }

  private generateEmailContent(alert: AlertMessage): string {
    const severityColor = this.getSeverityColor(alert.severity);

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Security Alert - Loot4Fun</title>
        </head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: ${severityColor}; padding: 20px; border-radius: 5px; margin-bottom: 20px;">
            <h1 style="color: white; margin: 0;">${this.getSeverityEmoji(alert.severity)} Security Alert</h1>
          </div>

          <div style="background-color: #f9f9f9; padding: 20px; border-radius: 5px;">
            <h2>${alert.title}</h2>
            <p><strong>Description:</strong> ${alert.description}</p>
            <p><strong>Severity:</strong> ${alert.severity.toUpperCase()}</p>
            <p><strong>Category:</strong> ${alert.category}</p>
            <p><strong>Time:</strong> ${alert.timestamp.toLocaleString()}</p>
            <p><strong>Source:</strong> ${alert.source}</p>

            ${alert.metadata ? `
              <h3>Additional Information:</h3>
              <pre style="background-color: #f0f0f0; padding: 10px; border-radius: 3px; overflow-x: auto;">
                ${JSON.stringify(alert.metadata, null, 2)}
              </pre>
            ` : ''}
          </div>

          <div style="margin-top: 20px; padding: 20px; background-color: #e8f4fd; border-radius: 5px;">
            <p><strong>Action Required:</strong> Please review this security alert and take appropriate action.</p>
            <p style="color: #666; font-size: 12px;">
              This alert was generated by the Loot4Fun Security Monitoring System.
            </p>
          </div>
        </body>
      </html>
    `;
  }

  private getSeverityEmoji(severity: string): string {
    switch (severity) {
      case 'critical': return '🔴';
      case 'high': return '🟠';
      case 'medium': return '🟡';
      case 'low': return '🟢';
      default: return '⚪';
    }
  }

  private getSeverityColor(severity: string): string {
    switch (severity) {
      case 'critical': return '#dc3545';
      case 'high': return '#fd7e14';
      case 'medium': return '#ffc107';
      case 'low': return '#28a745';
      default: return '#6c757d';
    }
  }

  private getSeverityColorNumber(severity: string): number {
    switch (severity) {
      case 'critical': return 0xff0000; // Red
      case 'high': return 0xffa500; // Orange
      case 'medium': return 0xffff00; // Yellow
      case 'low': return 0x00ff00; // Green
      default: return 0x808080; // Gray
    }
  }

  // Métodos públicos para gerenciamento de canais
  getChannels(): AlertChannel[] {
    return this.channels;
  }

  addChannel(channel: AlertChannel): boolean {
    if (this.channels.find(c => c.id === channel.id)) {
      return false; // Já existe
    }

    this.channels.push(channel);
    this.logger.log(`✅ Added alert channel: ${channel.id} (${channel.type})`);
    return true;
  }

  removeChannel(channelId: string): boolean {
    const index = this.channels.findIndex(c => c.id === channelId);
    if (index !== -1) {
      this.channels.splice(index, 1);
      this.logger.log(`✅ Removed alert channel: ${channelId}`);
      return true;
    }
    return false;
  }

  toggleChannel(channelId: string, enabled: boolean): boolean {
    const channel = this.channels.find(c => c.id === channelId);
    if (channel) {
      channel.enabled = enabled;
      this.logger.log(`${enabled ? '✅' : '❌'} ${enabled ? 'Enabled' : 'Disabled'} alert channel: ${channelId}`);
      return true;
    }
    return false;
  }

  // Método para testar canais
  async testChannel(channelId: string): Promise<boolean> {
    const channel = this.channels.find(c => c.id === channelId);
    if (!channel) return false;

    const testAlert: AlertMessage = {
      id: 'test-alert',
      title: 'Test Alert - Please Ignore',
      description: 'This is a test alert to verify the channel configuration.',
      severity: 'low',
      category: 'test',
      timestamp: new Date(),
      metadata: { test: true },
      source: 'system',
    };

    try {
      await this.sendAlertToChannel(channel, testAlert);
      return true;
    } catch (error) {
      this.logger.error(`❌ Channel test failed for ${channelId}:`, error);
      return false;
    }
  }

  // Método para obter estatísticas de alertas
  getAlertStats(): Record<string, any> {
    const stats = {
      totalChannels: this.channels.length,
      enabledChannels: this.channels.filter(c => c.enabled).length,
      channelsByType: {} as Record<string, number>,
      rulesBySeverity: {} as Record<string, number>,
    };

    for (const channel of this.channels) {
      stats.channelsByType[channel.type] = (stats.channelsByType[channel.type] || 0) + 1;

      for (const rule of channel.rules) {
        if (rule.enabled) {
          stats.rulesBySeverity[rule.severity] = (stats.rulesBySeverity[rule.severity] || 0) + 1;
        }
      }
    }

    return stats;
  }
}
