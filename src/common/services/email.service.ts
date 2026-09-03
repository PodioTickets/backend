import * as fs from 'fs';
import * as path from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MailDataRequired } from '@sendgrid/mail';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sgMail = require('@sendgrid/mail');
import {
  isBrazilian,
  formatPhoneByCountry,
  formatCpfByCountry,
} from '../utils/locale.util';

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
    /**
     * Quando true, o template exibe o label "CPF". Quando false, exibe "Documento"
     * e o valor é renderizado sem formatação de CPF (xxx.xxx.xxx-xx).
     * Default: detectado automaticamente a partir de userCountry/userDocumentType.
     */
    isBrazilian?: boolean;
    /**
     * Pais do remetente (nome em qualquer idioma ou ISO alpha-2/alpha-3).
     * Usado pra formatar o telefone via libphonenumber-js e decidir a label
     * CPF/Documento. Quando ausente, aplica heuristica via documentType e
     * shape do doc.
     */
    userCountry?: string | null;
    userDocumentType?: 'CPF' | 'PASSPORT' | string | null;
    subject?: string;
    eventName?: string;
    message: string;
  }) {
    const emailSubject = this.sanitizeHeader(
      data.eventName
        ? `Nova mensagem de ${data.userName} sobre ${data.eventName}`
        : `Nova mensagem de ${data.userName}`,
    );

    /* Detecta brasileiro pelo trio (country, documentType, doc). Flag legacy
     * `isBrazilian` ainda respeitada se passada explicitamente. */
    const isBrazilianFlag =
      data.isBrazilian !== undefined
        ? data.isBrazilian
        : isBrazilian(data.userCountry, data.userDocumentType, data.userCpf);
    const documentLabel = isBrazilianFlag ? 'CPF' : 'Documento';

    /* Formata telefone e documento conforme nacionalidade. Estrangeiro sem
     * country mapeado: phone fica so digitos, doc fica cru. */
    const formattedPhone = data.userPhone
      ? formatPhoneByCountry(
        data.userPhone,
        data.userCountry,
        data.userDocumentType,
        data.userCpf,
      )
      : '';
    const formattedCpf = data.userCpf
      ? formatCpfByCountry(data.userCpf, data.userCountry, data.userDocumentType)
      : '';

    const html = this.loadTemplate('mensagem-organizador.html', {
      organizerName: this.escapeHtml(data.organizerName),
      userName: this.escapeHtml(data.userName),
      userEmail: this.escapeHtml(data.userEmail),
      userPhone: formattedPhone ? this.escapeHtml(formattedPhone) : '',
      userCpf: formattedCpf ? this.escapeHtml(formattedCpf) : '',
      /* loadTemplate trata vars como string e usa truthiness (value !== '' && != null).
       * Para flags booleanas: '1' = truthy, '' = falsy. */
      isBrazilian: isBrazilianFlag ? '1' : '',
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
      formattedPhone ? `Telefone: ${formattedPhone}` : null,
      formattedCpf ? `${documentLabel}: ${formattedCpf}` : null,
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
    userAvatarUrl?: string;
    userCountry?: string | null;
    userDocumentType?: 'CPF' | 'PASSPORT' | string | null;
    subject?: string;
    message: string;
    eventName?: string;
    organizerName: string;
    organizerAvatarUrl?: string;
  }) {
    /* Formata phone/CPF conforme nacionalidade do remetente. */
    const formattedPhone = data.userPhone
      ? formatPhoneByCountry(
        data.userPhone,
        data.userCountry,
        data.userDocumentType,
        data.userCpf,
      )
      : '';
    const formattedCpf = data.userCpf
      ? formatCpfByCountry(data.userCpf, data.userCountry, data.userDocumentType)
      : '';
    const docLabel = isBrazilian(
      data.userCountry,
      data.userDocumentType,
      data.userCpf,
    )
      ? 'CPF'
      : 'Documento';

    const html = this.loadTemplate('confirmacao-mensagem-organizador.html', {
      userName: this.escapeHtml(data.userName),
      userEmail: this.escapeHtml(data.userEmail),
      userCpf: formattedCpf ? this.escapeHtml(formattedCpf) : '',
      userPhone: formattedPhone ? this.escapeHtml(formattedPhone) : '',
      userAvatarUrl: this.escapeHtml(this.safeUrl(data.userAvatarUrl)),
      subject: data.subject ? this.escapeHtml(data.subject) : '',
      message: this.escapeHtml(data.message),
      eventName: data.eventName ? this.escapeHtml(data.eventName) : '',
      organizerName: this.escapeHtml(data.organizerName),
      organizerAvatarUrl: this.escapeHtml(this.safeUrl(data.organizerAvatarUrl)),
      organizerInitial: this.escapeHtml(data.organizerName.charAt(0).toUpperCase()),
    });

    const textParts = [
      'Mensagem enviada',
      '',
      `Sua mensagem foi entregue ao organizador ${data.organizerName}. Você receberá a resposta neste mesmo e-mail.`,
      '',
      data.eventName ? `Evento: ${data.eventName}` : null,
      `Nome: ${data.userName}`,
      `E-mail: ${data.userEmail}`,
      formattedCpf ? `${docLabel}: ${formattedCpf}` : null,
      formattedPhone ? `Telefone: ${formattedPhone}` : null,
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
    /**
     * Nome completo do comprador quando a inscricao foi feita por outra pessoa
     * (comprador != participante). Renderiza banner "Inscricao feita por" no
     * template — paridade com badge da pagina /meus-ingressos. Vazio/omisso
     * = inscricao propria, sem banner.
     */
    invitedByName?: string;
    ticketPdfs?: Array<{ buffer: Buffer; participantName: string }>;
    /**
     * Comprovante (recibo) do pedido em PDF. Presente só no e-mail do COMPRADOR
     * (prova de pagamento). Quando definido, o template ativa o trecho
     * `{{#hasReceipt}}` ("ingresso e o recibo") e o PDF vai anexado.
     */
    receiptPdf?: Buffer;
  }) {
    const html = this.loadTemplate('inscricao-confirmada.html', {
      firstName: this.escapeHtml(data.firstName),
      eventName: this.escapeHtml(data.eventName),
      eventLocation: this.escapeHtml(data.eventLocation),
      eventDate: this.escapeHtml(data.eventDate ?? ''),
      eventAddress: this.escapeHtml(data.eventAddress ?? data.eventLocation),
      eventBannerUrl: this.escapeHtml(this.resolveEmailImageUrl(data.eventBannerUrl)),
      invitedByName: this.escapeHtml(data.invitedByName ?? ''),
      // Liga o trecho condicional "ingresso e o recibo" só quando há comprovante.
      hasReceipt: data.receiptPdf ? 'x' : '',
    });

    const address = data.eventAddress ?? data.eventLocation;
    const invitedByLine = data.invitedByName
      ? `\nInscrição feita por: ${data.invitedByName}\n`
      : '';
    const text = `Olá ${data.firstName},\n\nSua inscrição na ${data.eventName} foi confirmada! Sua vaga está garantida.${invitedByLine}\nEvento: ${data.eventName}\nData: ${data.eventDate ?? ''}\nLocal: ${address}\n\nPodioTicket — podioticket.com.br`;

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

    // Comprovante do pedido (só no e-mail do comprador).
    if (data.receiptPdf) {
      attachments.push({
        content: data.receiptPdf.toString('base64'),
        filename: `comprovante_${safeName}.pdf`,
        type: 'application/pdf',
        disposition: 'attachment',
      });
    }

    if (attachments.length > 0) msg.attachments = attachments;

    await this.send(msg);
    this.logger.log(`Registration confirmed email sent to: ${data.email}${attachments.length ? ` (${attachments.length} PDF(s)${data.receiptPdf ? ', incl. comprovante' : ''})` : ''}`);
  }

  /**
   * Aviso de ESTORNO concluído para o e-mail da INSCRIÇÃO estornada (participante).
   * Disparado pelo estorno do organizador OU do admin (fonte única no
   * `PaymentsRefundService.refundOrder`), um e-mail por participante distinto do
   * pedido. Best-effort no caller — falha de envio nunca reverte o estorno.
   *
   * Valores monetários chegam JÁ FORMATADOS ("R$ 189,90") — mesma convenção dos
   * e-mails de repasse — mantendo o EmailService agnóstico de centavos/locale.
   * O resumo financeiro é do PEDIDO (o estorno é sempre total): mostra a divisão
   * ingresso/produtos/desconto/taxa e o total devolvido ao comprador.
   */
  async sendRegistrationRefunded(data: {
    email: string;
    eventName: string;
    eventBannerUrl?: string | null;
    eventDate?: string;
    eventAddress?: string;
    /** Total devolvido ao comprador (= finalAmount do pedido), já formatado. */
    totalRefunded: string;
    ticketsSubtotal: string;
    /** Só passado quando há produtos adicionais cobrados (> 0). */
    productsSubtotal?: string;
    serviceFee: string;
    /** Rótulo do desconto (cupom/voucher). Só quando houve desconto (> 0). */
    discountLabel?: string;
    /** Valor do desconto, já formatado (sem o sinal "-"). Pareado com discountLabel. */
    discountValue?: string;
  }) {
    const hasProducts = !!data.productsSubtotal;
    const hasDiscount = !!(data.discountLabel && data.discountValue);

    const html = this.loadTemplate('estorno-inscricao.html', {
      eventName: this.escapeHtml(data.eventName),
      /* safeUrl valida https:// — resolveEmailImageUrl reescreve host local → público */
      eventBannerUrl: this.escapeHtml(this.safeUrl(this.resolveEmailImageUrl(data.eventBannerUrl))),
      eventDate: this.escapeHtml(data.eventDate ?? ''),
      eventAddress: this.escapeHtml(data.eventAddress ?? ''),
      totalRefunded: this.escapeHtml(data.totalRefunded),
      ticketsSubtotal: this.escapeHtml(data.ticketsSubtotal),
      productsSubtotal: this.escapeHtml(data.productsSubtotal ?? ''),
      /* Flags booleanas p/ loadTemplate: 'x' = truthy, '' = falsy. */
      hasProducts: hasProducts ? 'x' : '',
      serviceFee: this.escapeHtml(data.serviceFee),
      discountLabel: this.escapeHtml(data.discountLabel ?? ''),
      discountValue: this.escapeHtml(data.discountValue ?? ''),
      hasDiscount: hasDiscount ? 'x' : '',
    });

    const text = [
      'Estorno concluído — PódioTicket',
      '',
      `O estorno da sua inscrição na ${data.eventName} foi processado, e o valor será devolvido pelo mesmo meio de pagamento utilizado na compra.`,
      '',
      `Valor da inscrição: ${data.ticketsSubtotal}`,
      hasProducts ? `Produtos adicionais: ${data.productsSubtotal}` : null,
      hasDiscount ? `${data.discountLabel}: -${data.discountValue}` : null,
      `Taxa de serviço: ${data.serviceFee}`,
      `Total estornado: ${data.totalRefunded}`,
      '',
      'Quando recebo o valor?',
      'PIX: até 1 dia útil.',
      'Cartão de crédito: o valor pode aparecer na fatura atual ou na próxima, dependendo do prazo de processamento do banco emissor.',
      '',
      'PodioTicket — podioticket.com.br',
    ]
      .filter((l) => l !== null)
      .join('\n');

    await this.send({
      from: this.from,
      to: data.email,
      subject: this.sanitizeHeader(`Estorno concluído — ${data.eventName}`),
      html,
      text,
    });

    this.logger.log(`Refund email sent to: ${data.email} (evento: ${data.eventName})`);
  }

  async sendProductVariationChanged(data: {
    email: string;
    productName: string;
    productImageUrl?: string | null;
    previousVariationName: string;
    newVariationName: string;
    eventName: string;
    ticketName: string;
    changedAt: Date;
    /**
     * Ingresso (PDF) regenerado já com a variação ATUALIZADA. Reanexa o ingresso
     * ao mesmo e-mail da troca para o participante receber o documento atualizado
     * sem precisar voltar à plataforma. Best-effort: ausente se a geração falhou.
     */
    ticketPdf?: { buffer: Buffer; fileName: string };
  }) {
    // `changedAt` é um TIMESTAMP REAL (instante da troca). Sem `timeZone` explícito,
    // `toLocale*` usa o fuso do SERVIDOR (UTC em produção) → horário errado. Fixamos
    // Brasília (America/Sao_Paulo, UTC-3 sem DST) — padrão do projeto p/ timestamps
    // reais (PDFs, exports). Ver TZ_BR em ticket-pdf/receipt-pdf.template.ts.
    const TZ_BR = 'America/Sao_Paulo';
    const formatChangedAt = (d: Date) => {
      const date = d.toLocaleDateString('pt-BR', { timeZone: TZ_BR });
      const time = d
        .toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: TZ_BR,
        })
        .replace(':', 'h');
      return `${date} · ${time}`;
    };

    const html = this.loadTemplate('variacao-alterada.html', {
      productName: this.escapeHtml(data.productName),
      productImageUrl: this.escapeHtml(data.productImageUrl ?? ''),
      previousVariationName: this.escapeHtml(data.previousVariationName || '—'),
      newVariationName: this.escapeHtml(data.newVariationName),
      eventName: this.escapeHtml(data.eventName),
      ticketName: this.escapeHtml(data.ticketName),
      changedAt: this.escapeHtml(formatChangedAt(data.changedAt)),
    });

    const text = `Variação alterada com sucesso\n\nAtualizamos sua escolha. A nova variação já está vinculada ao seu ingresso.\n\nProduto: ${data.productName}\nVariação anterior: ${data.previousVariationName || '—'}\nVariação atual: ${data.newVariationName}\n\nEvento: ${data.eventName}\nIngresso: ${data.ticketName}\nAlterado em: ${formatChangedAt(data.changedAt)}\n\nO ingresso atualizado segue em anexo.\n\nPodioTicket — podioticket.com.br`;

    const msg: any = {
      from: this.from,
      to: data.email,
      subject: `Variação alterada — ${data.productName}`,
      html,
      text,
    };

    // Reanexa o ingresso já regenerado com a variação nova (best-effort no caller).
    if (data.ticketPdf) {
      msg.attachments = [
        {
          content: data.ticketPdf.buffer.toString('base64'),
          filename: data.ticketPdf.fileName,
          type: 'application/pdf',
          disposition: 'attachment',
        },
      ];
    }

    await this.send(msg);
    this.logger.log(
      `Product variation changed email sent to: ${data.email}${data.ticketPdf ? ' (incl. ingresso atualizado)' : ''}`,
    );
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

  async sendPasswordChangedNotification(data: {
    email: string;
    firstName?: string | null;
    changedAt: string;
    location: string;
    device: string;
  }) {
    const html = this.loadTemplate('senha-alterada.html', {
      changedAt: this.escapeHtml(data.changedAt),
      location: this.escapeHtml(data.location),
      device: this.escapeHtml(data.device),
    });

    const text = [
      'Senha alterada com sucesso — PódioTicket',
      '',
      'Sua nova senha já está ativa.',
      '',
      `Alterado em: ${data.changedAt}`,
      `Local aproximado: ${data.location}`,
      `Dispositivo: ${data.device}`,
      '',
      'Não foi você? Altere sua senha ou contate o suporte.',
      '',
      'PódioTicket — podioticket.com.br',
    ].join('\n');

    await this.send({
      from: this.from,
      to: data.email,
      subject: 'Senha alterada com sucesso — PódioTicket',
      html,
      text,
    });

    this.logger.log(`Password changed notification sent to: ${data.email}`);
  }

  async sendEmailChangedNotification(data: {
    oldEmail: string;
    newEmail: string;
    firstName: string;
    changedAt: string;
    location: string;
    device: string;
  }) {
    const html = this.loadTemplate('email-alterado.html', {
      oldEmail: this.escapeHtml(data.oldEmail),
      newEmail: this.escapeHtml(data.newEmail),
      changedAt: this.escapeHtml(data.changedAt),
      location: this.escapeHtml(data.location),
      device: this.escapeHtml(data.device),
    });

    const text = [
      'E-mail alterado com sucesso! — PódioTicket',
      '',
      `De: ${data.oldEmail}`,
      `Para: ${data.newEmail}`,
      '',
      `Alterado em: ${data.changedAt}`,
      `Local aproximado: ${data.location}`,
      `Dispositivo: ${data.device}`,
      '',
      'Não foi você? Altere sua senha ou contate o suporte.',
      '',
      'PódioTicket — podioticket.com.br',
    ].join('\n');

    await this.send({
      from: this.from,
      to: data.oldEmail,
      subject: 'E-mail da conta alterado — PódioTicket',
      html,
      text,
    });

    this.logger.log(`Email alterado: notificação enviada para ${data.oldEmail}`);
  }

  /**
   * Aviso LGPD ao encarregado (lgpd@podioticket.com.br) quando um usuário exclui
   * a própria conta. Inclui o MOTIVO informado e os DADOS da conta excluída
   * (capturados ANTES da anonimização). E-mail interno — HTML inline, sem template.
   */
  async sendAccountDeletionNotice(data: {
    reason: string;
    account: {
      id: string;
      firstName?: string | null;
      lastName?: string | null;
      email: string;
      phone?: string | null;
      documentType?: string | null;
      documentNumber?: string | null;
      country?: string | null;
      createdAt: Date;
      deletedAt: Date;
    };
  }) {
    const a = data.account;
    const e = (v: unknown) =>
      this.escapeHtml(v == null || v === '' ? '—' : String(v));
    const fullName = `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim() || '—';
    const doc = a.documentNumber
      ? `${a.documentType ? `${a.documentType} ` : ''}${a.documentNumber}`
      : '—';
    const iso = (d: Date) => {
      try {
        return d.toISOString();
      } catch {
        return String(d);
      }
    };

    const rows: [string, string][] = [
      ['ID da conta', e(a.id)],
      ['Nome', e(fullName)],
      ['E-mail', e(a.email)],
      ['Telefone', e(a.phone)],
      ['Documento', e(doc)],
      ['País', e(a.country)],
      ['Conta criada em', e(iso(a.createdAt))],
      ['Excluída em', e(iso(a.deletedAt))],
    ];
    const rowsHtml = rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 12px;font-weight:600;color:#333;border-bottom:1px solid #eee;">${k}</td><td style="padding:6px 12px;color:#111;border-bottom:1px solid #eee;">${v}</td></tr>`,
      )
      .join('');

    const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111;">
      <h2 style="margin:0 0 8px;">Solicitação de exclusão de conta (LGPD)</h2>
      <p style="margin:0 0 16px;color:#555;">Um usuário excluiu a própria conta na plataforma. Registro para fins de conformidade (LGPD).</p>
      <p style="margin:0 0 4px;font-weight:600;">Motivo informado:</p>
      <p style="margin:0 0 16px;padding:10px 12px;background:#f6f6f6;border-radius:6px;">${e(data.reason)}</p>
      <table style="border-collapse:collapse;width:100%;max-width:520px;">${rowsHtml}</table>
      <p style="margin:16px 0 0;color:#888;font-size:12px;">E-mail automático. A conta passou por soft-delete/anonimização; inscrições e histórico foram preservados via snapshot para os organizadores.</p>
    </body></html>`;

    const text = [
      'Solicitação de exclusão de conta (LGPD)',
      '',
      `Motivo: ${data.reason}`,
      '',
      `ID: ${a.id}`,
      `Nome: ${fullName}`,
      `E-mail: ${a.email}`,
      `Telefone: ${a.phone ?? '—'}`,
      `Documento: ${doc}`,
      `País: ${a.country ?? '—'}`,
      `Criada em: ${iso(a.createdAt)}`,
      `Excluída em: ${iso(a.deletedAt)}`,
    ].join('\n');

    await this.send({
      from: this.from,
      to: 'lgpd@podioticket.com.br',
      subject: 'Exclusão de conta (LGPD) — PódioTicket',
      html,
      text,
    });

    this.logger.log(`Aviso LGPD de exclusão enviado (conta ${a.id})`);
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
      // Inicial do nome (fantasia) — fallback do avatar quando a org não tem logo.
      orgInitial: this.escapeHtml(((data.orgName || 'O').trim().charAt(0) || 'O').toUpperCase()),
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
      title: 'Código de acesso',
      description:
        'Use o código abaixo para concluir a verificação. Ele expira em 10 minutos.',
      securityNote: 'Não foi você? Ignore este e-mail ou contate o suporte.',
      code: this.escapeHtml(code),
      loginDate: this.escapeHtml(opts?.loginDate ?? ''),
      loginDevice: this.escapeHtml(opts?.loginDevice ?? ''),
      loginLocation: this.escapeHtml(opts?.loginLocation ?? ''),
    });

    const text = [
      'Código de acesso — PódioTicket',
      '',
      `Seu código é: ${code}`,
      '',
      'Expira em 10 minutos. Não foi você? Ignore este e-mail ou contate o suporte.',
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

  /**
   * Código para CONFIRMAR a exclusão da conta. Reusa o template do código, mas
   * com copy própria e SEM o card de "tentativa de login" (não passa loginDate),
   * para não parecer um e-mail de acesso.
   */
  async sendAccountDeletionCode(
    recipientEmail: string,
    code: string,
  ): Promise<void> {
    const html = this.loadTemplate('codigo-2fa.html', {
      title: 'Confirme a exclusão da sua conta',
      description:
        'Recebemos um pedido para excluir a sua conta na PódioTicket. Use o código abaixo para confirmar. A exclusão é permanente e não pode ser desfeita — o código expira em 10 minutos.',
      securityNote:
        'Não pediu para excluir sua conta? Ignore este e-mail: nada será alterado. Por segurança, recomendamos trocar sua senha.',
      code: this.escapeHtml(code),
      // Chaves de login VAZIAS: a remoção por chave (1ª passagem do loadTemplate)
      // apaga o card de login de forma limpa. Omiti-las cairia no regex genérico
      // de limpeza, que quebra com o bloco aninhado (loginLocation).
      loginDate: '',
      loginDevice: '',
      loginLocation: '',
    });

    const text = [
      'Confirme a exclusão da sua conta — PódioTicket',
      '',
      'Recebemos um pedido para excluir a sua conta na PódioTicket.',
      `Seu código de confirmação é: ${code}`,
      '',
      'A exclusão é permanente e não pode ser desfeita. O código expira em 10 minutos.',
      '',
      'Não pediu isso? Ignore este e-mail (nada será alterado) e troque sua senha por segurança.',
    ].join('\n');

    await this.send({
      from: this.from,
      to: recipientEmail,
      subject: 'Confirme a exclusão da sua conta — PódioTicket',
      html,
      text,
    });

    this.logger.log(`Código de exclusão de conta enviado para: ${recipientEmail}`);
  }

  async sendEventUnderReview(data: {
    /**
     * Contato da organização + dono, já deduplicados
     * (`buildOrganizerNotificationRecipients`). UM e-mail com os dois no `to`,
     * não um envio por destinatário.
     */
    recipientEmails: string[];
    eventName: string;
    eventBannerUrl: string;
    eventDate: string;
    eventLocation: string;
    submittedAt: string;
  }): Promise<void> {
    const html = this.loadTemplate('evento-em-analise.html', {
      eventName: this.escapeHtml(data.eventName),
      /* safeUrl valida esquema https:// — previne javascript: em atributo src da imagem */
      eventBannerUrl: this.escapeHtml(this.safeUrl(this.resolveEmailImageUrl(data.eventBannerUrl))),
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
      to: data.recipientEmails,
      subject: `Seu evento está em análise — ${data.eventName}`,
      html,
      text,
    });

    this.logger.log(`Email de evento em análise enviado para: ${data.recipientEmails.join(', ')} (evento: ${data.eventName})`);
  }

  async sendEventApproved(data: {
    /**
     * Contato da organização + TODOS os owners, já deduplicados
     * (`buildOrganizerNotificationRecipients`). UM e-mail com todos no `to`,
     * não um envio por destinatário.
     */
    recipientEmails: string[];
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
      eventBannerUrl: this.escapeHtml(this.safeUrl(this.resolveEmailImageUrl(data.eventBannerUrl))),
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
      to: data.recipientEmails,
      subject: `Seu evento foi aprovado — ${data.eventName}`,
      html,
      text,
    });

    this.logger.log(`Email de evento aprovado enviado para: ${data.recipientEmails.join(', ')} (evento: ${data.eventName})`);
  }

  async sendEventChangesRequested(data: {
    /**
     * Contato da organização + dono, já deduplicados
     * (`buildOrganizerNotificationRecipients`). UM e-mail com os dois no `to`,
     * não um envio por destinatário.
     */
    recipientEmails: string[];
    organizerName?: string;
    eventName: string;
    eventBannerUrl: string;
    eventDate: string;
    eventLocation: string;
    /** Quando o admin concluiu a análise (já formatado em pt-BR). */
    reviewedAt: string;
    /** Texto livre escrito pelo admin — entra escapado no HTML. */
    reason: string;
  }): Promise<void> {
    const html = this.loadTemplate('evento-ajustes-solicitados.html', {
      organizerName: this.escapeHtml(data.organizerName ?? ''),
      eventName: this.escapeHtml(data.eventName),
      /* safeUrl valida esquema https:// — previne javascript: em atributo src da imagem */
      eventBannerUrl: this.escapeHtml(this.safeUrl(this.resolveEmailImageUrl(data.eventBannerUrl))),
      eventDate: this.escapeHtml(data.eventDate),
      eventLocation: this.escapeHtml(data.eventLocation),
      reviewedAt: this.escapeHtml(data.reviewedAt),
      // Escapa PRIMEIRO e só então troca as quebras por <br> — inverter a ordem
      // faria o próprio <br> ser escapado e aparecer como texto no e-mail.
      reason: this.escapeHtml(data.reason).replace(/\r?\n/g, '<br>'),
    });

    const text = [
      `Seu evento precisa de ajustes — PódioTicket`,
      '',
      `Evento: ${data.eventName}`,
      `Data: ${data.eventDate}`,
      `Local: ${data.eventLocation}`,
      `Analisado em: ${data.reviewedAt}`,
      '',
      'O que precisa ser ajustado:',
      data.reason,
      '',
      'Corrija o evento em "Meus eventos" e reenvie para análise.',
    ].join('\n');

    await this.send({
      from: this.from,
      to: data.recipientEmails,
      subject: `Seu evento precisa de ajustes — ${data.eventName}`,
      html,
      text,
    });

    this.logger.log(
      `Email de ajustes solicitados enviado para: ${data.recipientEmails.join(', ')} (evento: ${data.eventName})`,
    );
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
   * Resolve a URL de imagem para o e-mail. Clientes externos (Gmail etc.) NÃO
   * alcançam `localhost`/caminhos relativos — quando o upload foi feito em um
   * ambiente que "carimbou" o host local, reescreve para o host PÚBLICO
   * (`SERVER_URL`). URLs já públicas (GCS/CDN https) passam intactas.
   */
  private resolveEmailImageUrl(url: string | undefined | null): string {
    if (!url) return '';
    const trimmed = url.trim();
    if (!trimmed) return '';
    const base = (process.env.SERVER_URL ?? '').replace(/\/+$/, '');
    // Caminho relativo (ex.: /uploads/images/x.webp).
    if (trimmed.startsWith('/')) return base ? `${base}${trimmed}` : trimmed;
    // http(s)://localhost[:porta]/... ou 127.0.0.1 → troca só o host pelo público.
    const local = trimmed.match(
      /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(\/.*)?$/i,
    );
    if (local && base) return `${base}${local[1] ?? ''}`;
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
