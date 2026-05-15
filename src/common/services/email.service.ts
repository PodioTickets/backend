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
    this.from = this.configService.get<string>('SMTP_FROM', 'PódioTicket <no-reply@podioticket.com.br>');

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
          /* SendGrid MailDataRequired não tipifica headers extras — cast necessário */
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

    // Primeira passagem: blocos condicionais {{#key}}...{{/key}} e {{^key}}...{{/key}}
    for (const [key, value] of Object.entries(vars)) {
      const hasValue = value !== '' && value != null;
      html = html.replace(new RegExp(`\\{\\{#${key}\\}\\}([\\s\\S]*?)\\{\\{\\/${key}\\}\\}`, 'g'), hasValue ? '$1' : '');
      html = html.replace(new RegExp(`\\{\\{\\^${key}\\}\\}([\\s\\S]*?)\\{\\{\\/${key}\\}\\}`, 'g'), hasValue ? '' : '$1');
    }
    // Limpar blocos condicionais restantes (chaves ausentes do vars)
    html = html.replace(/\{\{#\w+\}\}[\s\S]*?\{\{\/\w+\}\}/g, '');
    html = html.replace(/\{\{\^\w+\}\}([\s\S]*?)\{\{\/\w+\}\}/g, '$1');

    // Segunda passagem: substituição simples {{key}}
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
    userCpf?: string;
    userAvatarUrl?: string;
    subject?: string;
    eventName?: string;
    message: string;
  }) {
    const emailSubject = this.sanitizeHeader(
      data.eventName
        ? `Nova mensagem de ${data.userName} sobre ${data.eventName}`
        : `Nova mensagem de ${data.userName}`,
    );

    const html = this.loadTemplate('mensagem-organizador.html', {
      organizerName: this.escapeHtml(data.organizerName),
      userName: this.escapeHtml(data.userName),
      userEmail: this.escapeHtml(data.userEmail),
      userPhone: data.userPhone ? this.escapeHtml(data.userPhone) : '',
      userCpf: data.userCpf ? this.escapeHtml(data.userCpf) : '',
      /* safeUrl valida esquema https:// antes de escapeHtml — previne javascript: em src */
      userAvatarUrl: this.escapeHtml(this.safeUrl(data.userAvatarUrl)),
      subject: data.subject ? this.escapeHtml(data.subject) : '',
      eventName: data.eventName ? this.escapeHtml(data.eventName) : '',
      message: this.escapeHtml(data.message),
    });

    const textParts = [
      `Nova mensagem de contato${data.eventName ? ` — ${data.eventName}` : ''}`,
      '',
      `De: ${data.userName} (${data.userEmail})`,
      data.userPhone ? `Telefone: ${data.userPhone}` : null,
      data.userCpf ? `CPF: ${data.userCpf}` : null,
      data.subject ? `Assunto: ${data.subject}` : null,
      '',
      'Mensagem:',
      data.message,
      '',
      `Responda diretamente para: ${data.userEmail}`,
    ].filter((l) => l !== null);
    const text = textParts.join('\n');

    await this.send({
      from: this.from,
      to: data.organizerEmail,
      replyTo: data.userEmail,
      subject: emailSubject,
      html,
      text,
    });

    this.logger.log(`Contact email sent to organizer: ${data.organizerEmail}`);
  }

  async sendContactMessageConfirmation(data: {
    recipientEmail: string;
    userName: string;
    userEmail: string;
    userCpf?: string;
    userPhone?: string;
    subject?: string;
    message: string;
    eventName?: string;
    organizerName: string;
    organizerAvatarUrl?: string;
  }) {
    const html = this.loadTemplate('confirmacao-mensagem-organizador.html', {
      userName: this.escapeHtml(data.userName),
      userEmail: this.escapeHtml(data.userEmail),
      userCpf: data.userCpf ? this.escapeHtml(data.userCpf) : '',
      userPhone: data.userPhone ? this.escapeHtml(data.userPhone) : '',
      subject: data.subject ? this.escapeHtml(data.subject) : '',
      message: this.escapeHtml(data.message),
      eventName: data.eventName ? this.escapeHtml(data.eventName) : '',
      organizerName: this.escapeHtml(data.organizerName),
      organizerAvatarUrl: this.escapeHtml(this.safeUrl(data.organizerAvatarUrl)),
    });

    const textParts = [
      'Mensagem enviada',
      '',
      `Sua mensagem foi entregue ao organizador ${data.organizerName}. Você receberá a resposta neste mesmo e-mail.`,
      '',
      data.eventName ? `Evento: ${data.eventName}` : null,
      `Nome: ${data.userName}`,
      `E-mail: ${data.userEmail}`,
      data.userCpf ? `CPF: ${data.userCpf}` : null,
      data.userPhone ? `Telefone: ${data.userPhone}` : null,
      data.subject ? `Assunto: ${data.subject}` : null,
      '',
      'Mensagem:',
      data.message,
      '',
      'PódioTicket — podioticket.com.br',
    ].filter((l) => l !== null);

    await this.send({
      from: this.from,
      to: data.recipientEmail,
      subject: 'Mensagem enviada — PódioTicket',
      html,
      text: textParts.join('\n'),
    });

    this.logger.log(`Confirmação de mensagem ao organizador enviada para: ${data.recipientEmail}`);
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
        <a href="${this.escapeHtml(this.safeUrl(data.registrationLink))}" style="display:inline-block;background-color:#007bff;color:#fff;padding:12px 24px;text-decoration:none;border-radius:5px;">Ver minha inscrição</a>
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
    await this.send({ from: this.from, to: data.email, subject: 'Recupere sua senha', html, text });
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
    eventDate?: string;
    eventAddress?: string;
    eventBannerUrl: string;
    ticketPdfs?: Array<{ buffer: Buffer; participantName: string }>;
  }) {
    const html = this.loadTemplate('inscricao-confirmada.html', {
      firstName: this.escapeHtml(data.firstName),
      eventName: this.escapeHtml(data.eventName),
      eventLocation: this.escapeHtml(data.eventLocation),
      eventDate: this.escapeHtml(data.eventDate ?? ''),
      eventAddress: this.escapeHtml(data.eventAddress ?? data.eventLocation),
      eventBannerUrl: this.escapeHtml(data.eventBannerUrl),
      hasReceipt: '',
    });

    const address = data.eventAddress ?? data.eventLocation;
    const text = `Olá ${data.firstName},\n\nSua inscrição na ${data.eventName} foi confirmada! Sua vaga está garantida.\n\nEvento: ${data.eventName}\nData: ${data.eventDate ?? ''}\nLocal: ${address}\n\nPodioTicket — podioticket.com.br`;

    const msg: any = {
      from: this.from,
      to: data.email,
      subject: `Inscrição confirmada — ${data.eventName}`,
      html,
      text,
    };

    const safeName = data.eventName.replace(/[^a-zA-Z0-9À-ÿ _-]/g, '').trim().replace(/\s+/g, '_');
    const attachments: any[] = (data.ticketPdfs ?? []).map(tp => {
      const safeParticipant = tp.participantName.replace(/[^a-zA-Z0-9À-ÿ _-]/g, '').trim().replace(/\s+/g, '_');
      return {
        content: tp.buffer.toString('base64'),
        filename: `ingresso_${safeName}_${safeParticipant}.pdf`,
        type: 'application/pdf',
        disposition: 'attachment',
      };
    });

    if (attachments.length > 0) msg.attachments = attachments;

    await this.send(msg);
    this.logger.log(`Registration confirmed email sent to: ${data.email}${attachments.length ? ` (${attachments.length} ticket PDF(s))` : ''}`);
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
    await this.send({ from: this.from, to: data.email, subject: 'Redefinição de senha', html, text });
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
    await this.send({ from: this.from, to: data.email, subject: 'Sua senha foi alterada', html, text });
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

  async sendOrganizerCommunication(data: {
    recipientEmail: string;
    firstName: string;
    eventName: string;
    orgName: string;
    orgAvatarUrl?: string;
    subject: string;
    messageHtml: string;
    instagram?: string;
    facebook?: string;
    youtube?: string;
    tiktok?: string;
    website?: string;
  }) {
    const hasSocialLinks = !!(data.instagram || data.facebook || data.youtube || data.tiktok || data.website);

    // Carrega template sem o messageHtml para evitar substituição de {{}} dentro do conteúdo livre
    let html = this.loadTemplate('comunicado-organizador.html', {
      eventName: this.escapeHtml(data.eventName),
      orgName: this.escapeHtml(data.orgName),
      orgAvatarUrl: data.orgAvatarUrl ? this.escapeHtml(data.orgAvatarUrl) : '',
      subject: this.escapeHtml(data.subject),
      instagram: data.instagram ? this.escapeHtml(this.normalizeSocialUrl('instagram', data.instagram)) : '',
      facebook: data.facebook ? this.escapeHtml(this.normalizeSocialUrl('facebook', data.facebook)) : '',
      youtube: data.youtube ? this.escapeHtml(this.normalizeSocialUrl('youtube', data.youtube)) : '',
      tiktok: data.tiktok ? this.escapeHtml(this.normalizeSocialUrl('tiktok', data.tiktok)) : '',
      website: data.website ? this.escapeHtml(this.normalizeSocialUrl('website', data.website)) : '',
      hasSocialLinks: hasSocialLinks ? 'true' : '',
    });

    // Injeta o corpo da mensagem SEM escaping — já foi sanitizado pelo serviço chamador
    html = html.replace('<!-- PODIO_MSG_BODY -->', data.messageHtml);

    const text = `${data.subject}\n\n${data.eventName} — ${data.orgName}\n\nPodioTicket — podioticket.com.br`;

    await this.send({
      from: this.from,
      to: data.recipientEmail,
      subject: `${data.subject} — ${data.eventName}`,
      html,
      text,
    });

    this.logger.log(`Comunicado organização enviado para: ${data.recipientEmail}`);
  }

  async sendMemberAdded(data: {
    recipientEmail: string;
    firstName: string;
    orgName: string;
    registeredAt: string;
  }) {
    const html = this.loadTemplate('membro-adicionado.html', {
      firstName: this.escapeHtml(data.firstName),
      email: this.escapeHtml(data.recipientEmail),
      orgName: this.escapeHtml(data.orgName),
      registeredAt: this.escapeHtml(data.registeredAt),
    });

    const text = `Olá ${data.firstName},\n\nVocê foi adicionado como colaborador da organização ${data.orgName} na PódioTicket.\n\nE-mail de acesso: ${data.recipientEmail}\nOrganização: ${data.orgName}\nCadastrado em: ${data.registeredAt}\n\nAcesse o painel em: https://www.podioticket.com.br/organizador\n\nPodioTicket — podioticket.com.br`;

    await this.send({
      from: this.from,
      to: data.recipientEmail,
      subject: `Bem-vindo à equipe — ${data.orgName}`,
      html,
      text,
    });

    this.logger.log(`Email de membro adicionado enviado para: ${data.recipientEmail}`);
  }

  async send2FACode(
    recipientEmail: string,
    code: string,
    opts?: { loginDate?: string; loginDevice?: string; loginLocation?: string },
  ): Promise<void> {
    const html = this.loadTemplate('codigo-2fa.html', {
      code: this.escapeHtml(code),
      loginDate: this.escapeHtml(opts?.loginDate ?? ''),
      loginDevice: this.escapeHtml(opts?.loginDevice ?? ''),
      loginLocation: this.escapeHtml(opts?.loginLocation ?? ''),
    });

    const text = [
      'Código de acesso — PódioTicket',
      '',
      `Seu código de acesso é: ${code}`,
      '',
      'Este código expira em 10 minutos.',
      'Não foi você? Altere sua senha ou contate o suporte.',
    ].join('\n');

    await this.send({
      from: this.from,
      to: recipientEmail,
      subject: 'Código de acesso — PódioTicket',
      html,
      text,
    });

    this.logger.log(`Código 2FA enviado para: ${recipientEmail}`);
  }

  async sendEventUnderReview(data: {
    recipientEmail: string;
    eventName: string;
    eventBannerUrl: string;
    eventDate: string;
    eventLocation: string;
    submittedAt: string;
  }): Promise<void> {
    const html = this.loadTemplate('evento-em-analise.html', {
      eventName: this.escapeHtml(data.eventName),
      /* safeUrl valida esquema https:// — previne javascript: em atributo src da imagem */
      eventBannerUrl: this.escapeHtml(this.safeUrl(data.eventBannerUrl)),
      eventDate: this.escapeHtml(data.eventDate),
      eventLocation: this.escapeHtml(data.eventLocation),
      submittedAt: this.escapeHtml(data.submittedAt),
    });

    const text = [
      `Seu evento está em análise — PódioTicket`,
      '',
      `Evento: ${data.eventName}`,
      `Data: ${data.eventDate}`,
      `Local: ${data.eventLocation}`,
      `Enviado para análise: ${data.submittedAt}`,
      '',
      'Recebemos sua solicitação de publicação. Nossa equipe fará uma revisão em até 1 dia útil.',
    ].join('\n');

    await this.send({
      from: this.from,
      to: data.recipientEmail,
      subject: `Seu evento está em análise — ${data.eventName}`,
      html,
      text,
    });

    this.logger.log(`Email de evento em análise enviado para: ${data.recipientEmail} (evento: ${data.eventName})`);
  }

  async sendEventApproved(data: {
    recipientEmail: string;
    organizerName?: string;
    eventName: string;
    eventBannerUrl: string;
    eventDate: string;
    eventLocation: string;
    submittedAt: string;
  }): Promise<void> {
    const html = this.loadTemplate('evento-aprovado.html', {
      organizerName: this.escapeHtml(data.organizerName ?? ''),
      eventName: this.escapeHtml(data.eventName),
      /* safeUrl valida esquema https:// — previne javascript: em atributo src da imagem */
      eventBannerUrl: this.escapeHtml(this.safeUrl(data.eventBannerUrl)),
      eventDate: this.escapeHtml(data.eventDate),
      eventLocation: this.escapeHtml(data.eventLocation),
      submittedAt: this.escapeHtml(data.submittedAt),
    });

    const text = [
      `Seu evento foi aprovado e está publicado — PódioTicket`,
      '',
      `Evento: ${data.eventName}`,
      `Data: ${data.eventDate}`,
      `Local: ${data.eventLocation}`,
      '',
      'A análise foi concluída. Seu evento já está disponível para inscrições.',
    ].join('\n');

    await this.send({
      from: this.from,
      to: data.recipientEmail,
      subject: `Seu evento foi aprovado — ${data.eventName}`,
      html,
      text,
    });

    this.logger.log(`Email de evento aprovado enviado para: ${data.recipientEmail} (evento: ${data.eventName})`);
  }

  /** Garante que URL tenha protocolo — sem ele o href vira relativo e não funciona */
  private normalizeUrl(url: string): string {
    const trimmed = url.trim();
    if (!trimmed) return '';
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }

  /**
   * Normaliza handle ou URL de rede social para URL absoluta válida.
   * Usuários frequentemente salvam apenas o handle (ex: @podioticket) em vez da URL completa.
   */
  private normalizeSocialUrl(platform: 'instagram' | 'facebook' | 'youtube' | 'tiktok' | 'website', value: string): string {
    const trimmed = value.trim().replace(/\/+$/, ''); // remove trailing slashes
    if (!trimmed) return '';
    // Já é URL completa
    if (/^https?:\/\//i.test(trimmed)) return trimmed;

    // Handle sem protocolo mas com domínio reconhecível (ex: instagram.com/user)
    const withoutAt = trimmed.replace(/^@/, '');

    switch (platform) {
      case 'instagram':
        // @handle ou handle → https://instagram.com/handle
        return `https://instagram.com/${withoutAt}`;
      case 'facebook':
        // @handle ou handle → https://facebook.com/handle
        return `https://facebook.com/${withoutAt}`;
      case 'tiktok':
        // @handle ou handle → https://tiktok.com/@handle
        return `https://tiktok.com/@${withoutAt}`;
      case 'youtube':
        // @handle ou handle → https://youtube.com/@handle
        return `https://youtube.com/@${withoutAt}`;
      case 'website':
      default:
        return `https://${trimmed}`;
    }
  }

  /**
   * Valida que URL seja exclusivamente https:// — rejeita javascript:, data:, file: etc.
   * Usar em atributos src/href de imagens e links em emails para prevenir scheme injection.
   * Retorna string vazia se inválida.
   */
  private safeUrl(url: string | undefined | null): string {
    if (!url) return '';
    const trimmed = url.trim();
    if (!/^https:\/\//i.test(trimmed)) return '';
    return trimmed;
  }

  /**
   * Remove \r e \n de strings usadas em cabeçalhos de email (Subject, To, From).
   * Previne email header injection.
   */
  private sanitizeHeader(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').trim();
  }

  private escapeHtml(text: string): string {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
