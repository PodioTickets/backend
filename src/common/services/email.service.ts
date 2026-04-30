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
      const [response] = await sgMail.send({
        ...msg,
        headers: {
          'List-Unsubscribe': '<mailto:contato@podioticket.com.br?subject=unsubscribe>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          ...((msg as any).headers ?? {}),
        },
        trackingSettings: {
          clickTracking: { enable: false, enableText: false },
          openTracking: { enable: false },
          subscriptionTracking: { enable: false },
        },
      });
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
      html = html.split(`{{${key}}}`).join(value);
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
    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;line-height:1.6;color:#333;background-color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#fff;border-radius:8px;padding:32px;">
    <tr><td>
      <h2 style="margin:0 0 16px 0;color:#202020;">Nova mensagem de contato — Podio Ticket</h2>
      <p style="margin:0 0 16px 0;">Você recebeu uma nova mensagem através da plataforma Podio Ticket:</p>
      <div style="background-color:#f5f5f5;padding:20px;border-radius:5px;margin:0 0 16px 0;">
        <p style="margin:0 0 8px 0;"><strong>De:</strong> ${this.escapeHtml(data.userName)}</p>
        <p style="margin:0 0 8px 0;"><strong>Email:</strong> ${this.escapeHtml(data.userEmail)}</p>
        ${data.userPhone ? `<p style="margin:0 0 8px 0;"><strong>Telefone:</strong> ${this.escapeHtml(data.userPhone)}</p>` : ''}
        ${data.eventName ? `<p style="margin:0;"><strong>Evento:</strong> ${this.escapeHtml(data.eventName)}</p>` : ''}
      </div>
      <div style="background-color:#fff;padding:20px;border-left:4px solid #007bff;margin:0 0 16px 0;">
        <p style="margin:0 0 8px 0;"><strong>Mensagem:</strong></p>
        <p style="margin:0;">${data.message.replace(/\n/g, '<br>')}</p>
      </div>
      <p style="margin:0;color:#666;font-size:12px;">Esta mensagem foi enviada através da plataforma Podio Ticket.<br>Responda diretamente ao email do remetente: ${this.escapeHtml(data.userEmail)}</p>
    </td></tr>
  </table>
  </td></tr></table>
</body>
</html>`;

    const text = `Nova mensagem de contato${data.eventName ? ` — ${data.eventName}` : ''}\n\nDe: ${data.userName} (${data.userEmail})${data.userPhone ? `\nTelefone: ${data.userPhone}` : ''}\n\nMensagem:\n${data.message}\n\nResponda diretamente para: ${data.userEmail}`;
    await this.send({
      from: this.from,
      to: data.organizerEmail,
      replyTo: data.userEmail,
      subject,
      html,
      text,
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
    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;line-height:1.6;color:#333;background-color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#fff;border-radius:8px;padding:32px;">
    <tr><td>
      <h2 style="margin:0 0 16px 0;color:#202020;">Você foi inscrito em um evento!</h2>
      <p style="margin:0 0 16px 0;">Olá ${this.escapeHtml(data.firstName)},</p>
      <p style="margin:0 0 24px 0;"><strong>${this.escapeHtml(data.inviterName)}</strong> inscreveu você no evento <strong>${this.escapeHtml(data.eventName)}</strong> através da plataforma Podio Ticket.</p>
      <div style="background-color:#f5f5f5;padding:20px;border-radius:5px;margin:0 0 24px 0;text-align:center;">
        <p style="margin:0 0 16px 0;">Para visualizar sua inscrição, clique no link abaixo:</p>
        <a href="${data.registrationLink}" style="display:inline-block;background-color:#007bff;color:#fff;padding:12px 24px;text-decoration:none;border-radius:5px;">Ver minha inscrição</a>
      </div>
      <p style="margin:0;color:#666;font-size:12px;">Se você não esperava receber este email, pode ignorá-lo.</p>
    </td></tr>
  </table>
  </td></tr></table>
</body>
</html>`;

    const text = `Olá ${data.firstName},\n\n${data.inviterName} inscreveu você no evento ${data.eventName}.\n\nAcesse sua inscrição: ${data.registrationLink}\n\nPodioTicket — podioticket.com.br`;
    await this.send({ from: this.from, to: data.email, subject, html, text });
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

    const text = `Olá ${data.firstName},\n\nSeu código de recuperação de senha é: ${data.code}\n\nSe você não solicitou isso, ignore este email.\n\nPodioTicket — podioticket.com.br`;
    await this.send({ from: this.from, to: data.email, subject: 'Recupere sua senha — PódioTicket', html, text });
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

    const text = `Olá ${data.firstName},\n\nSeu código de verificação para troca de e-mail é: ${data.code}\n\nNovo e-mail: ${data.newEmail}\nSolicitado em: ${data.requestDate}\n\nSe você não solicitou isso, entre em contato com o suporte.\n\nPodioTicket — podioticket.com.br`;
    await this.send({ from: this.from, to: data.email, subject: 'Solicitação de troca de e-mail — PódioTicket', html, text });
    this.logger.log(`Email change verification sent to: ${data.email}`);
  }

  async sendRegistrationConfirmed(data: {
    email: string;
    firstName: string;
    eventName: string;
    eventLocation: string;
    eventBannerUrl: string;
    ticketPdf?: Buffer;
    receiptPdf?: Buffer;
  }) {
    const html = this.loadTemplate('inscricao-confirmada.html', {
      firstName: this.escapeHtml(data.firstName),
      eventName: this.escapeHtml(data.eventName),
      eventLocation: this.escapeHtml(data.eventLocation),
      eventBannerUrl: data.eventBannerUrl,
    });

    const text = `Olá ${data.firstName},\n\nSua inscrição na ${data.eventName} foi confirmada! Sua vaga está garantida.\n\nEvento: ${data.eventName}\nLocal: ${data.eventLocation}\n\nPodioTicket — podioticket.com.br`;

    const msg: any = {
      from: this.from,
      to: data.email,
      subject: `Inscrição confirmada — ${data.eventName}`,
      html,
      text,
    };

    const safeName = data.eventName.replace(/[^a-zA-Z0-9À-ÿ _-]/g, '').trim().replace(/\s+/g, '_');
    const attachments: any[] = [];

    if (data.ticketPdf) {
      attachments.push({
        content: data.ticketPdf.toString('base64'),
        filename: `ingresso_${safeName}.pdf`,
        type: 'application/pdf',
        disposition: 'attachment',
      });
    }
    if (data.receiptPdf) {
      attachments.push({
        content: data.receiptPdf.toString('base64'),
        filename: `recibo_${safeName}.pdf`,
        type: 'application/pdf',
        disposition: 'attachment',
      });
    }
    if (attachments.length > 0) msg.attachments = attachments;

    await this.send(msg);
    const attachInfo = [data.ticketPdf ? 'ticket' : '', data.receiptPdf ? 'receipt' : ''].filter(Boolean).join('+');
    this.logger.log(`Registration confirmed email sent to: ${data.email}${attachInfo ? ` (${attachInfo} PDF)` : ''}`);
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

    const text = `Solicitação de repasse recebida\n\nEvento: ${data.eventName}\nOrganização: ${data.orgName}\nValor: ${data.amount}\nID: ${data.transferId}\nSolicitado em: ${data.requestDate}\n\nPodioTicket — podioticket.com.br`;
    await this.send({ from: this.from, to: data.email, subject: 'Solicitação de repasse recebida — PódioTicket', html, text });
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

    const text = `Repasse concluído\n\nOrganização: ${data.orgName}\nValor: ${data.amount}\nID: ${data.transferId}\nAprovado em: ${data.approvedDate}\n\nPodioTicket — podioticket.com.br`;
    await this.send({ from: this.from, to: data.email, subject: 'Repasse concluído — PódioTicket', html, text });
    this.logger.log(`Transfer confirmed email sent to: ${data.email}`);
  }

  async sendWelcomeUser(data: { email: string; firstName: string }) {
    const html = this.loadTemplate('bem-vindo.html', {
      firstName: this.escapeHtml(data.firstName),
    });
    const text = `Olá ${data.firstName},\n\nBem-vindo à PodioTicket! Sua plataforma pra encontrar provas, garantir vagas e acompanhar tudo num só lugar.\n\nPodioTicket — podioticket.com.br`;
    await this.send({ from: this.from, to: data.email, subject: 'Bem-vindo à PódioTicket', html, text });
    this.logger.log(`Welcome email sent to: ${data.email}`);
  }

  async sendWelcomeOrganizer(data: { email: string; firstName: string }) {
    const html = this.loadTemplate('bem-vindo-organizador.html', {
      firstName: this.escapeHtml(data.firstName),
    });
    const text = `Olá ${data.firstName},\n\nSua conta de organizador foi ativada na PodioTicket! Crie seu primeiro evento e configure seus dados de repasse.\n\nPodioTicket — podioticket.com.br`;
    await this.send({ from: this.from, to: data.email, subject: 'Bem-vindo à PódioTicket — Organizador', html, text });
    this.logger.log(`Welcome organizer email sent to: ${data.email}`);
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

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;line-height:1.6;color:#333;background-color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#fff;border-radius:8px;padding:32px;">
    <tr><td>
      <h2 style="margin:0 0 16px 0;color:#202020;">Redefinir senha</h2>
      <p style="margin:0 0 16px 0;">Olá ${safeName},</p>
      <p style="margin:0 0 16px 0;">Recebemos um pedido para redefinir a senha de <strong>${label}</strong>.</p>
      <p style="margin:0 0 24px 0;">Se você não fez este pedido, ignore este e-mail — sua senha permanece a mesma.</p>
      <div style="background-color:#f5f5f5;padding:20px;border-radius:5px;margin:0 0 24px 0;text-align:center;">
        <a href="${data.resetUrl}" style="display:inline-block;background-color:#007bff;color:#fff;padding:12px 24px;text-decoration:none;border-radius:5px;">Redefinir senha</a>
      </div>
      <p style="margin:0 0 8px 0;color:#666;font-size:13px;">O link expira em breve. Se o botão não funcionar, copie e cole no navegador:</p>
      <p style="margin:0 0 24px 0;color:#666;font-size:12px;word-break:break-all;">${this.escapeHtml(data.resetUrl)}</p>
      <p style="margin:0;color:#666;font-size:12px;">Podio Ticket — este é um e-mail automático, não responda.</p>
    </td></tr>
  </table>
  </td></tr></table>
</body>
</html>`;

    const text = `Olá ${data.firstName || 'usuário'},\n\nClique no link abaixo para redefinir sua senha:\n${data.resetUrl}\n\nSe você não solicitou isso, ignore este email.\n\nPodioTicket — podioticket.com.br`;
    await this.send({ from: this.from, to: data.email, subject: 'Redefinição de senha — Podio Ticket', html, text });
    this.logger.log(`Password reset email sent to: ${data.email}`);
  }

  async sendPasswordChangedNotification(data: { email: string; firstName: string }) {
    const safeName = this.escapeHtml(data.firstName || 'usuário');
    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;line-height:1.6;color:#333;background-color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#fff;border-radius:8px;padding:32px;">
    <tr><td>
      <h2 style="margin:0 0 16px 0;color:#202020;">Sua senha foi alterada</h2>
      <p style="margin:0 0 16px 0;">Olá ${safeName},</p>
      <p style="margin:0 0 16px 0;">A senha da sua conta Podio Ticket foi alterada com sucesso.</p>
      <p style="margin:0 0 24px 0;">Se você não realizou esta alteração, entre em contato com o suporte imediatamente.</p>
      <p style="margin:0;color:#666;font-size:12px;">Podio Ticket — este é um e-mail automático, não responda.</p>
    </td></tr>
  </table>
  </td></tr></table>
</body>
</html>`;
    const text = `Olá ${data.firstName || 'usuário'},\n\nA senha da sua conta PodioTicket foi alterada com sucesso.\n\nSe você não realizou esta alteração, entre em contato com o suporte imediatamente.\n\nPodioTicket — podioticket.com.br`;
    await this.send({ from: this.from, to: data.email, subject: 'Sua senha foi alterada — Podio Ticket', html, text });
    this.logger.log(`Password changed notification sent to: ${data.email}`);
  }

  async sendEmailChangedNotification(data: { oldEmail: string; newEmail: string; firstName: string }) {
    const safeName = this.escapeHtml(data.firstName || 'usuário');
    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;line-height:1.6;color:#333;background-color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#fff;border-radius:8px;padding:32px;">
    <tr><td>
      <h2 style="margin:0 0 16px 0;color:#202020;">E-mail da conta alterado</h2>
      <p style="margin:0 0 16px 0;">Olá ${safeName},</p>
      <p style="margin:0 0 16px 0;">O e-mail da sua conta Podio Ticket foi alterado para <strong>${this.escapeHtml(data.newEmail)}</strong>.</p>
      <p style="margin:0 0 24px 0;">Se você não realizou esta alteração, entre em contato com o suporte imediatamente.</p>
      <p style="margin:0;color:#666;font-size:12px;">Podio Ticket — este é um e-mail automático, não responda.</p>
    </td></tr>
  </table>
  </td></tr></table>
</body>
</html>`;
    const text = `Olá ${data.firstName || 'usuário'},\n\nO e-mail da sua conta PodioTicket foi alterado para ${data.newEmail}.\n\nSe você não realizou esta alteração, entre em contato com o suporte imediatamente.\n\nPodioTicket — podioticket.com.br`;
    // Notifica o email antigo (segurança) e o novo (confirmação)
    await Promise.all([
      this.send({ from: this.from, to: data.oldEmail, subject: 'E-mail da conta alterado — Podio Ticket', html, text }),
      this.send({ from: this.from, to: data.newEmail, subject: 'Bem-vindo ao novo e-mail — Podio Ticket', html, text }),
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
