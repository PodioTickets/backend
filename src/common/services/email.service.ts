import * as fs from 'fs';
import * as path from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MailDataRequired } from '@sendgrid/mail';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sgMail = require('@sendgrid/mail');

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly from: string;
  private readonly enabled: boolean;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('SEND_GRID');
    this.from = this.configService.get<string>('SMTP_FROM', 'no-reply@podioticket.com.br');

    if (!apiKey) {
      this.logger.warn('SEND_GRID API key not configured. Email service will be disabled.');
      this.enabled = false;
      return;
    }

    sgMail.setApiKey(apiKey);
    this.enabled = true;
    this.logger.log('SendGrid email service initialized');
  }

  private async send(msg: MailDataRequired): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('Email service disabled. Skipping send.');
      return;
    }
    try {
      const [response] = await sgMail.send(msg);
      this.logger.log(`SendGrid response: ${response.statusCode} to=${Array.isArray(msg.to) ? msg.to.join(',') : msg.to}`);
    } catch (error: any) {
      const detail = error?.response?.body ?? error?.message ?? error;
      this.logger.error('Failed to send email via SendGrid:', JSON.stringify(detail));
      throw error;
    }
  }

  private loadTemplate(templateName: string, vars: Record<string, string>): string {
    const filePath = path.join(__dirname, '..', 'templates', 'emails', templateName);
    let html = fs.readFileSync(filePath, 'utf8');
    for (const [key, value] of Object.entries(vars)) {
      html = html.replaceAll(`{{${key}}}`, value);
    }
    return html;
  }

  async sendContactMessageToOrganizer(data: {
    organizerEmail: string;
    organizerName: string;
    userName: string;
    userEmail: string;
    userPhone?: string;
    eventName?: string;
    message: string;
  }) {
    const subject = `Nova mensagem de contato${data.eventName ? ` - ${data.eventName}` : ''}`;
    const html = `
      <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2>Nova mensagem de contato — Podio Ticket</h2>
          <p>Você recebeu uma nova mensagem através da plataforma Podio Ticket:</p>
          <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <p><strong>De:</strong> ${data.userName}</p>
            <p><strong>Email:</strong> ${data.userEmail}</p>
            ${data.userPhone ? `<p><strong>Telefone:</strong> ${data.userPhone}</p>` : ''}
            ${data.eventName ? `<p><strong>Evento:</strong> ${data.eventName}</p>` : ''}
          </div>
          <div style="background-color: #fff; padding: 20px; border-left: 4px solid #007bff; margin: 20px 0;">
            <p><strong>Mensagem:</strong></p>
            <p>${data.message.replace(/\n/g, '<br>')}</p>
          </div>
          <p style="margin-top: 30px; color: #666; font-size: 12px;">
            Esta mensagem foi enviada através da plataforma Podio Ticket.<br>
            Responda diretamente ao email do remetente: ${data.userEmail}
          </p>
        </body>
      </html>
    `;

    await this.send({
      from: this.from,
      to: data.organizerEmail,
      replyTo: data.userEmail,
      subject,
      html,
    });

    this.logger.log(`Contact email sent to organizer: ${data.organizerEmail}`);
  }

  async sendInvitationEmail(data: {
    email: string;
    firstName: string;
    eventName: string;
    inviterName: string;
    registrationLink: string;
  }) {
    const subject = `${data.inviterName} inscreveu você no evento ${data.eventName}`;
    const html = `
      <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2>Você foi inscrito em um evento!</h2>
          <p>Olá ${data.firstName},</p>
          <p><strong>${data.inviterName}</strong> inscreveu você no evento <strong>${data.eventName}</strong> através da plataforma Podio Ticket.</p>
          <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: center;">
            <p>Para visualizar sua inscrição, clique no link abaixo:</p>
            <a href="${data.registrationLink}" style="display: inline-block; background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-top: 10px;">
              Ver minha inscrição
            </a>
          </div>
          <p style="margin-top: 30px; color: #666; font-size: 12px;">
            Se você não esperava receber este email, pode ignorá-lo.
          </p>
        </body>
      </html>
    `;

    await this.send({ from: this.from, to: data.email, subject, html });
    this.logger.log(`Invitation email sent to: ${data.email}`);
  }

  async sendPasswordResetCode(data: {
    email: string;
    firstName: string;
    code: string;
  }) {
    const html = this.loadTemplate('recuperar-senha.html', {
      firstName: this.escapeHtml(data.firstName),
      code: this.escapeHtml(data.code),
    });

    await this.send({ from: this.from, to: data.email, subject: 'Recupere sua senha — PódioTicket', html });
    this.logger.log(`Password reset code sent to: ${data.email}`);
  }

  async sendEmailChangeVerification(data: {
    email: string;
    firstName: string;
    newEmail: string;
    code: string;
    requestDate: string;
    location: string;
    device: string;
  }) {
    const html = this.loadTemplate('troca-de-email.html', {
      firstName: this.escapeHtml(data.firstName),
      newEmail: this.escapeHtml(data.newEmail),
      code: this.escapeHtml(data.code),
      requestDate: this.escapeHtml(data.requestDate),
      location: this.escapeHtml(data.location),
      device: this.escapeHtml(data.device),
    });

    await this.send({ from: this.from, to: data.email, subject: 'Solicitação de troca de e-mail — PódioTicket', html });
    this.logger.log(`Email change verification sent to: ${data.email}`);
  }

  async sendRegistrationConfirmed(data: {
    email: string;
    firstName: string;
    eventName: string;
    eventLocation: string;
    eventBannerUrl: string;
  }) {
    const html = this.loadTemplate('inscricao-confirmada.html', {
      firstName: this.escapeHtml(data.firstName),
      eventName: this.escapeHtml(data.eventName),
      eventLocation: this.escapeHtml(data.eventLocation),
      eventBannerUrl: data.eventBannerUrl,
    });

    await this.send({ from: this.from, to: data.email, subject: `Inscrição confirmada — ${data.eventName}`, html });
    this.logger.log(`Registration confirmed email sent to: ${data.email}`);
  }

  async sendTransferRequested(data: {
    email: string;
    eventName: string;
    amount: string;
    transferId: string;
    orgName: string;
    bankAccount: string;
    pixKey: string;
    requestDate: string;
    sentDate: string;
  }) {
    const html = this.loadTemplate('repasse-solicitado.html', {
      eventName: this.escapeHtml(data.eventName),
      amount: this.escapeHtml(data.amount),
      transferId: this.escapeHtml(data.transferId),
      orgName: this.escapeHtml(data.orgName),
      bankAccount: this.escapeHtml(data.bankAccount),
      pixKey: this.escapeHtml(data.pixKey),
      requestDate: this.escapeHtml(data.requestDate),
      sentDate: this.escapeHtml(data.sentDate),
    });

    await this.send({ from: this.from, to: data.email, subject: 'Solicitação de repasse recebida — PódioTicket', html });
    this.logger.log(`Transfer requested email sent to: ${data.email}`);
  }

  async sendTransferConfirmed(data: {
    email: string;
    amount: string;
    transferId: string;
    orgName: string;
    bankAccount: string;
    pixKey: string;
    requestDate: string;
    sentDate: string;
    approvedDate: string;
  }) {
    const html = this.loadTemplate('repasse-confirmado.html', {
      amount: this.escapeHtml(data.amount),
      transferId: this.escapeHtml(data.transferId),
      orgName: this.escapeHtml(data.orgName),
      bankAccount: this.escapeHtml(data.bankAccount),
      pixKey: this.escapeHtml(data.pixKey),
      requestDate: this.escapeHtml(data.requestDate),
      sentDate: this.escapeHtml(data.sentDate),
      approvedDate: this.escapeHtml(data.approvedDate),
    });

    await this.send({ from: this.from, to: data.email, subject: 'Repasse concluído — PódioTicket', html });
    this.logger.log(`Transfer confirmed email sent to: ${data.email}`);
  }

  async sendPasswordResetLink(data: {
    email: string;
    firstName: string;
    resetUrl: string;
    accountLabel?: string;
  }) {
    const safeName = this.escapeHtml(data.firstName || 'usuário');
    const label = data.accountLabel
      ? this.escapeHtml(data.accountLabel)
      : 'sua conta Podio Ticket';

    const html = `
      <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2>Redefinir senha</h2>
          <p>Olá ${safeName},</p>
          <p>Recebemos um pedido para redefinir a senha de <strong>${label}</strong>.</p>
          <p>Se você não fez este pedido, ignore este e-mail — sua senha permanece a mesma.</p>
          <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: center;">
            <a href="${data.resetUrl}" style="display: inline-block; background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">
              Redefinir senha
            </a>
          </div>
          <p style="color: #666; font-size: 13px;">O link expira em breve. Se o botão não funcionar, copie e cole no navegador:</p>
          <p style="color: #666; font-size: 12px; word-break: break-all;">${this.escapeHtml(data.resetUrl)}</p>
          <p style="margin-top: 30px; color: #666; font-size: 12px;">
            Podio Ticket — este é um e-mail automático, não responda.
          </p>
        </body>
      </html>
    `;

    await this.send({ from: this.from, to: data.email, subject: 'Redefinição de senha — Podio Ticket', html });
    this.logger.log(`Password reset email sent to: ${data.email}`);
  }

  async sendPasswordChangedNotification(data: { email: string; firstName: string }) {
    const safeName = this.escapeHtml(data.firstName || 'usuário');
    const html = `
      <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2>Sua senha foi alterada</h2>
          <p>Olá ${safeName},</p>
          <p>A senha da sua conta Podio Ticket foi alterada com sucesso.</p>
          <p>Se você não realizou esta alteração, entre em contato com o suporte imediatamente.</p>
          <p style="margin-top: 30px; color: #666; font-size: 12px;">
            Podio Ticket — este é um e-mail automático, não responda.
          </p>
        </body>
      </html>
    `;
    await this.send({ from: this.from, to: data.email, subject: 'Sua senha foi alterada — Podio Ticket', html });
    this.logger.log(`Password changed notification sent to: ${data.email}`);
  }

  async sendEmailChangedNotification(data: { oldEmail: string; newEmail: string; firstName: string }) {
    const safeName = this.escapeHtml(data.firstName || 'usuário');
    const html = `
      <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2>E-mail da conta alterado</h2>
          <p>Olá ${safeName},</p>
          <p>O e-mail da sua conta Podio Ticket foi alterado para <strong>${this.escapeHtml(data.newEmail)}</strong>.</p>
          <p>Se você não realizou esta alteração, entre em contato com o suporte imediatamente.</p>
          <p style="margin-top: 30px; color: #666; font-size: 12px;">
            Podio Ticket — este é um e-mail automático, não responda.
          </p>
        </body>
      </html>
    `;
    // Notifica o email antigo (segurança) e o novo (confirmação)
    await Promise.all([
      this.send({ from: this.from, to: data.oldEmail, subject: 'E-mail da conta alterado — Podio Ticket', html }),
      this.send({ from: this.from, to: data.newEmail, subject: 'Bem-vindo ao novo e-mail — Podio Ticket', html }),
    ]);
    this.logger.log(`Email changed notification sent: ${data.oldEmail} → ${data.newEmail}`);
  }

  private escapeHtml(text: string): string {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
