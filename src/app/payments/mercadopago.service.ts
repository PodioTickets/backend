import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

/**
 * Resultado normalizado de uma operação no Mercado Pago — espelha o papel do
 * CieloPaymentResult para o fluxo de DÉBITO, que é o único método processado
 * pelo MP (crédito e PIX permanecem na Cielo).
 */
export interface MpPaymentResult {
  success: boolean;
  /** id numérico do pagamento no MP, serializado como string (vira Payment.transactionId). */
  mpPaymentId?: string;
  /** Status cru do MP: approved | pending | in_process | rejected | cancelled | refunded | charged_back. */
  mpStatus?: string;
  /** status_detail do MP (ex.: pending_challenge, cc_rejected_bad_filled_card_number). */
  statusDetail?: string;
  /** payment_method_id do MP (debvisa, debmaster, debelo...). */
  paymentMethodId?: string;
  /** Bandeira "humana" derivada do payment_method_id (Visa, Master, Elo...). */
  cardBrand?: string;
  last4Digits?: string;
  holder?: string;
  /** Desafio 3DS do MP — quando presente, o front deve renderizar o iframe. */
  challenge?: { externalResourceUrl: string; creq: string };
  error?: string;
}

/** Corpo do webhook do MP (topic payment). */
export interface MpWebhookEvent {
  type?: string;
  action?: string;
  data?: { id?: string | number };
}

/**
 * Gateway Mercado Pago — usado EXCLUSIVAMENTE para cartão de DÉBITO
 * (decisão de negócio: instabilidade do débito na Cielo). Crédito, PIX e
 * estornos de pagamentos antigos continuam no CieloService.
 *
 * Sem SDK npm (mesmo padrão do CieloService): axios direto na API
 * https://api.mercadopago.com. Sandbox = credenciais de teste (prefixo TEST-),
 * não há flag de ambiente própria.
 *
 * Habilitação: presença de MP_ACCESS_TOKEN. Ausente → `enabled` = false e o
 * OrdersService mantém o débito no fluxo legado da Cielo (rollback por env).
 */
@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name);
  private readonly client: AxiosInstance;
  private readonly accessToken: string;
  private readonly webhookSecret: string;
  private readonly statementDescriptor: string;

  constructor(private readonly configService: ConfigService) {
    this.accessToken = this.configService.get<string>('MP_ACCESS_TOKEN') || '';
    this.webhookSecret = this.configService.get<string>('MP_WEBHOOK_SECRET') || '';
    this.statementDescriptor =
      this.configService.get<string>('MP_STATEMENT_DESCRIPTOR') || 'PODIOTICKET';

    if (this.enabled && !this.webhookSecret && process.env.NODE_ENV === 'production') {
      // Mesma postura do CIELO_WEBHOOK_SECRET: webhook sem validação de
      // assinatura em produção permitiria forjar confirmações de pagamento.
      throw new Error('MP_WEBHOOK_SECRET is required in production when MP_ACCESS_TOKEN is set');
    }

    this.client = axios.create({
      baseURL: 'https://api.mercadopago.com',
      timeout: 30000,
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
  }

  /** MP ativo para débito? (rollback: basta remover MP_ACCESS_TOKEN do env) */
  get enabled(): boolean {
    return !!this.accessToken;
  }

  /** Credenciais de teste do MP têm prefixo TEST- (não há flag de sandbox). */
  get sandboxMode(): boolean {
    return this.accessToken.startsWith('TEST-');
  }

  /**
   * Cria pagamento de DÉBITO no MP a partir do card token gerado no browser
   * (MercadoPago.js V2 — o PAN nunca chega ao nosso backend neste fluxo).
   *
   * `amountInCents` segue a convenção interna (centavos); o MP fala em reais
   * decimais, a conversão acontece aqui e SÓ aqui.
   */
  async createDebitPayment(params: {
    amountInCents: number;
    orderId: string;
    cardToken: string;
    paymentMethodId: string;
    payer: { email?: string; firstName?: string; lastName?: string; cpf?: string };
    deviceId?: string;
    idempotencyKey: string;
    notificationUrl?: string;
    description?: string;
  }): Promise<MpPaymentResult> {
    if (!this.enabled) {
      return { success: false, error: 'Mercado Pago is not configured (MP_ACCESS_TOKEN missing)' };
    }
    // Aceita métodos de débito (debvisa, debmaster, debelo...) e PRÉ-PAGOS da
    // conta (elo/visa/master — ex.: Elo Débito Virtual e os cartões de teste do
    // MP), que processam à vista igual débito. Como o id de pré-pago COLIDE com
    // o de crédito, ids não-`deb*` são validados contra a lista real de métodos
    // da conta (cache 1h); API indisponível → recusa (fail-closed, comportamento
    // antigo). Um payment_method_id de crédito puro segue rejeitado.
    if (!/^deb/.test(params.paymentMethodId)) {
      let prepaidOk = false;
      try {
        const ids = await this.loadDebitCapableMethodIds();
        prepaidOk = ids.has(params.paymentMethodId);
      } catch {
        prepaidOk = false;
      }
      if (!prepaidOk) {
        return { success: false, error: `payment_method_id '${params.paymentMethodId}' não é de cartão de débito` };
      }
    }

    const body: Record<string, any> = {
      transaction_amount: Number((params.amountInCents / 100).toFixed(2)),
      token: params.cardToken,
      installments: 1,
      payment_method_id: params.paymentMethodId,
      payer: {
        email: params.payer.email || undefined,
        first_name: params.payer.firstName || undefined,
        last_name: params.payer.lastName || undefined,
        ...(params.payer.cpf && {
          identification: { type: 'CPF', number: params.payer.cpf },
        }),
      },
      external_reference: params.orderId,
      description: params.description ?? `Pedido ${params.orderId}`,
      statement_descriptor: this.statementDescriptor,
      capture: true,
      // 3DS a critério do risco do MP; challenge chega como pending_challenge.
      three_d_secure_mode: 'optional',
      ...(params.notificationUrl && { notification_url: params.notificationUrl }),
    };

    try {
      const response = await this.client.post('/v1/payments', body, {
        headers: {
          // Idempotência exigida pelo MP; reusa a key do checkout (escopada
          // por user+order via Redis) para retry seguro do mesmo pagamento.
          'X-Idempotency-Key': params.idempotencyKey,
          ...(params.deviceId && { 'X-meli-session-id': params.deviceId }),
        },
      });
      return this.toResult(response.data);
    } catch (err: any) {
      const apiMessage = err?.response?.data?.message ?? err.message;
      this.logger.error(
        `MP createDebitPayment falhou (order ${params.orderId}): ${apiMessage}`,
        err?.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : undefined,
      );
      return { success: false, error: apiMessage };
    }
  }

  /** Consulta o estado real de um pagamento (anti-forjamento do webhook e polling). */
  async getPayment(mpPaymentId: string): Promise<MpPaymentResult> {
    try {
      const response = await this.client.get(`/v1/payments/${mpPaymentId}`);
      return this.toResult(response.data);
    } catch (err: any) {
      const apiMessage = err?.response?.data?.message ?? err.message;
      this.logger.error(`MP getPayment ${mpPaymentId} falhou: ${apiMessage}`);
      return { success: false, error: apiMessage };
    }
  }

  /**
   * Estorno TOTAL (amount omitido) ou PARCIAL (amountInCents) de um pagamento
   * aprovado. Equivalente funcional do cancelPayment da Cielo para débito MP —
   * débito capturado não tem "void": é sempre refund.
   */
  async refundPayment(mpPaymentId: string, amountInCents?: number): Promise<MpPaymentResult> {
    try {
      const body =
        amountInCents != null ? { amount: Number((amountInCents / 100).toFixed(2)) } : {};
      await this.client.post(`/v1/payments/${mpPaymentId}/refunds`, body, {
        headers: { 'X-Idempotency-Key': crypto.randomUUID() },
      });
      // Re-consulta para devolver o estado consolidado (refunded/approved c/ parcial).
      return await this.getPayment(mpPaymentId);
    } catch (err: any) {
      const apiMessage = err?.response?.data?.message ?? err.message;
      this.logger.error(`MP refundPayment ${mpPaymentId} falhou: ${apiMessage}`);
      return { success: false, error: apiMessage };
    }
  }

  /**
   * Cancela um pagamento ainda NÃO aprovado (pending/in_process — ex.: challenge
   * 3DS abandonado). Para pagamentos aprovados use refundPayment.
   */
  async cancelPayment(mpPaymentId: string): Promise<MpPaymentResult> {
    try {
      const response = await this.client.put(`/v1/payments/${mpPaymentId}`, {
        status: 'cancelled',
      });
      return this.toResult(response.data);
    } catch (err: any) {
      const apiMessage = err?.response?.data?.message ?? err.message;
      this.logger.error(`MP cancelPayment ${mpPaymentId} falhou: ${apiMessage}`);
      return { success: false, error: apiMessage };
    }
  }

  /**
   * Valida a assinatura do webhook do MP (header x-signature: "ts=...,v1=...").
   * Manifesto oficial: `id:{data.id};request-id:{x-request-id};ts:{ts};`
   * — HMAC-SHA256 com o secret configurado no painel do MP.
   *
   * Fora de produção sem secret configurado: aceita (dev/sandbox), igual à
   * postura do webhook Cielo.
   */
  verifyWebhookSignature(params: {
    xSignature?: string;
    xRequestId?: string;
    dataId?: string;
  }): boolean {
    if (!this.webhookSecret) {
      if (process.env.NODE_ENV === 'production') return false;
      this.logger.warn('MP_WEBHOOK_SECRET ausente — assinatura do webhook NÃO validada (dev)');
      return true;
    }
    const { xSignature, xRequestId, dataId } = params;
    if (!xSignature || !dataId) return false;

    const parts = Object.fromEntries(
      xSignature.split(',').map((p) => p.trim().split('=').map((s) => s.trim()) as [string, string]),
    );
    const ts = parts['ts'];
    const v1 = parts['v1'];
    if (!ts || !v1) return false;

    // data.id numérico vai minúsculo no manifesto (regra da doc do MP p/ ids alfanuméricos).
    const manifest = `id:${String(dataId).toLowerCase()};request-id:${xRequestId ?? ''};ts:${ts};`;
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(manifest).digest('hex');

    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'));
    } catch {
      return false; // v1 não-hex / tamanho diferente
    }
  }

  /** Mapeia status do MP → PaymentStatus interno (mesma semântica do mapCieloStatusToPaymentStatus). */
  mapMpStatusToPaymentStatus(mpStatus?: string): PaymentStatus | null {
    switch (mpStatus) {
      case 'approved':
        return PaymentStatus.PAID;
      case 'pending':
      case 'in_process':
      case 'authorized':
        return PaymentStatus.PENDING;
      case 'rejected':
      case 'cancelled':
        return PaymentStatus.FAILED;
      case 'refunded':
      case 'charged_back':
        return PaymentStatus.REFUNDED;
      default:
        return null;
    }
  }

  /** Mensagem PT-BR amigável para recusas comuns (status_detail do MP). */
  mapRejectionMessage(statusDetail?: string): string {
    const map: Record<string, string> = {
      cc_rejected_bad_filled_card_number: 'Número do cartão inválido. Verifique e tente novamente.',
      cc_rejected_bad_filled_date: 'Data de validade inválida. Verifique e tente novamente.',
      cc_rejected_bad_filled_security_code: 'Código de segurança inválido. Verifique e tente novamente.',
      cc_rejected_bad_filled_other: 'Dados do cartão inválidos. Verifique e tente novamente.',
      cc_rejected_insufficient_amount: 'Saldo insuficiente no cartão.',
      cc_rejected_call_for_authorize: 'Pagamento não autorizado pelo banco. Entre em contato com o emissor do cartão.',
      cc_rejected_card_disabled: 'Cartão desabilitado. Entre em contato com o emissor.',
      cc_rejected_duplicated_payment: 'Pagamento duplicado detectado. Aguarde alguns instantes.',
      cc_rejected_high_risk: 'Pagamento recusado pela análise de segurança.',
      cc_rejected_blacklist: 'Pagamento recusado pela análise de segurança.',
      cc_rejected_max_attempts: 'Limite de tentativas atingido. Tente novamente mais tarde.',
      cc_rejected_other_reason: 'Pagamento recusado pelo emissor do cartão.',
    };
    return map[statusDetail ?? ''] ?? 'Pagamento não autorizado. Verifique os dados do cartão e tente novamente.';
  }

  /** Normaliza a resposta crua do MP num MpPaymentResult. */
  private toResult(payment: any): MpPaymentResult {
    const threeDsInfo = payment?.three_ds_info;
    const challenge =
      payment?.status === 'pending' &&
      payment?.status_detail === 'pending_challenge' &&
      threeDsInfo?.external_resource_url
        ? { externalResourceUrl: threeDsInfo.external_resource_url, creq: threeDsInfo.creq }
        : undefined;

    return {
      success: payment?.status === 'approved',
      mpPaymentId: payment?.id != null ? String(payment.id) : undefined,
      mpStatus: payment?.status,
      statusDetail: payment?.status_detail,
      paymentMethodId: payment?.payment_method_id,
      cardBrand: this.brandFromMethodId(payment?.payment_method_id),
      last4Digits: payment?.card?.last_four_digits ?? undefined,
      holder: payment?.card?.cardholder?.name ?? undefined,
      challenge,
    };
  }

  /** debvisa→Visa, debmaster→Master, debelo→Elo... (rótulos que o painel/recibo já usam). */
  private brandFromMethodId(paymentMethodId?: string): string | undefined {
    const map: Record<string, string> = {
      debvisa: 'Visa',
      debmaster: 'Master',
      debelo: 'Elo',
      debcabal: 'Cabal',
      // Pré-pagos (processam como débito à vista) usam o id "cru" da bandeira.
      visa: 'Visa',
      master: 'Master',
      elo: 'Elo',
    };
    return paymentMethodId ? (map[paymentMethodId] ?? paymentMethodId) : undefined;
  }

  // ── Métodos débito/pré-pago da conta (cache 1h) ────────────────────────────
  // Fonte da validação de ids não-`deb*` no createDebitPayment: só aceitamos um
  // id "cru" (elo/visa/master) se a CONTA tiver a entrada prepaid_card/debit_card
  // correspondente ativa — evita whitelist hardcoded que dessincroniza do MP.
  private debitMethodIdsCache: { ids: Set<string>; expiresAt: number } | null = null;

  private async loadDebitCapableMethodIds(): Promise<Set<string>> {
    const now = Date.now();
    if (this.debitMethodIdsCache && now < this.debitMethodIdsCache.expiresAt) {
      return this.debitMethodIdsCache.ids;
    }
    const { data } = await this.client.get('/v1/payment_methods');
    const ids = new Set<string>(
      (Array.isArray(data) ? data : [])
        .filter(
          (m: any) =>
            m?.status === 'active' &&
            (m?.payment_type_id === 'debit_card' || m?.payment_type_id === 'prepaid_card'),
        )
        .map((m: any) => String(m.id)),
    );
    this.debitMethodIdsCache = { ids, expiresAt: now + 60 * 60 * 1000 };
    return ids;
  }
}
