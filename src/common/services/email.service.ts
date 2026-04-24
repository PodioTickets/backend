import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private configService: ConfigService) {
    this.initializeTransporter();
  }

  private initializeTransporter() {
    const smtpHost = this.configService.get<string>('SMTP_HOST');
    const smtpPort = this.configService.get<number>('SMTP_PORT', 587);
    const smtpUser = this.configService.get<string>('SMTP_USER');
    const smtpPass = this.configService.get<string>('SMTP_PASSWORD');
    const smtpFrom = this.configService.get<string>('SMTP_FROM', 'noreply@podiogo.com');

    if (!smtpHost || !smtpUser || !smtpPass) {
      this.logger.warn('SMTP configuration incomplete. Email service will be disabled.');
      return;
    }

    this.transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    this.logger.log('Email transporter initialized');
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
    if (!this.transporter) {
      this.logger.warn('Email transporter not configured. Skipping email send.');
      return;
    }

    const subject = `Nova mensagem de contato${data.eventName ? ` - ${data.eventName}` : ''}`;
    const htmlContent = `
      <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2>Nova mensagem de contato - PodioGo</h2>
          <p>Você recebeu uma nova mensagem através da plataforma PodioGo:</p>
          
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
            Esta mensagem foi enviada através da plataforma PodioGo.<br>
            Por favor, responda diretamente ao email do remetente: ${data.userEmail}
          </p>
        </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: this.configService.get<string>('SMTP_FROM', 'noreply@podiogo.com'),
        to: data.organizerEmail,
        subject,
        html: htmlContent,
        replyTo: data.userEmail,
      });

      this.logger.log(`Email sent to organizer: ${data.organizerEmail}`);
    } catch (error) {
      this.logger.error('Failed to send email:', error);
      throw error;
    }
  }

  async sendInvitationEmail(data: {
    email: string;
    firstName: string;
    eventName: string;
    inviterName: string;
    registrationLink: string;
  }) {
    if (!this.transporter) {
      this.logger.warn('Email transporter not configured. Skipping email send.');
      return;
    }

    const subject = `${data.inviterName} inscreveu você no evento ${data.eventName}`;
    const htmlContent = `
      <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2>Você foi convidado para participar de um evento!</h2>
          <p>Olá ${data.firstName},</p>
          <p><strong>${data.inviterName}</strong> inscreveu você no evento <strong>${data.eventName}</strong> através da plataforma PodioGo.</p>
          
          <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: center;">
            <p>Para completar seu cadastro e definir sua senha, clique no link abaixo:</p>
            <a href="${data.registrationLink}" style="display: inline-block; background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-top: 10px;">
              Completar Cadastro
            </a>
          </div>
          
          <p style="margin-top: 30px; color: #666; font-size: 12px;">
            Se você não esperava receber este email, pode ignorá-lo.
          </p>
        </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: this.configService.get<string>('SMTP_FROM', 'noreply@podiogo.com'),
        to: data.email,
        subject,
        html: htmlContent,
      });

      this.logger.log(`Invitation email sent to: ${data.email}`);
    } catch (error) {
      this.logger.error('Failed to send invitation email:', error);
      throw error;
    }
  }

  async sendPasswordResetLink(data: {
    email: string;
    firstName: string;
    resetUrl: string;
    accountLabel?: string;
  }) {
    if (!this.transporter) {
      this.logger.warn('Email transporter not configured. Skipping password reset email.');
      return;
    }

    const safeName = this.escapeHtml(data.firstName || 'usuário');
    const label = data.accountLabel
      ? this.escapeHtml(data.accountLabel)
      : 'sua conta PodioGo';

    const subject = 'Redefinição de senha — PodioGo';
    const htmlContent = `
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
          <p style="color: #666; font-size: 13px;">O link expira em breve por motivos de segurança. Se o botão não funcionar, copie e cole no navegador:</p>
          <p style="color: #666; font-size: 12px; word-break: break-all;">${this.escapeHtml(data.resetUrl)}</p>
          <p style="margin-top: 30px; color: #666; font-size: 12px;">
            PodioGo — este é um e-mail automático, não responda.
          </p>
        </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: this.configService.get<string>('SMTP_FROM', 'noreply@podiogo.com'),
        to: data.email,
        subject,
        html: htmlContent,
      });
      this.logger.log(`Password reset email sent to: ${data.email}`);
    } catch (error) {
      this.logger.error('Failed to send password reset email:', error);
      throw error;
    }
  }

  private escapeHtml(text: string): string {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

