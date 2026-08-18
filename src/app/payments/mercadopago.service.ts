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
  /**
   * Desafio 3DS do MP — quando presente, o front deve renderizar o iframe.
   * Orders API: `creq` vem VAZIO (a URL é autocontida — iframe com src direto).
   * Legado /v1/payments: URL + creq (form POST pro ACS).
   */
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
   * Usa a **Orders API** (`POST /v1/orders`) — no Brasil, débito de cartão
   * MÚLTIPLO (Visa/Master crédito+débito no mesmo plástico) só existe nela:
   * envia-se o id da BANDEIRA (`master`/`visa`/`elo`) + `type: "debit_card"`.
   * A `/v1/payments` clássica não tem esse conceito (débito BR = só `debelo`),
   * e era por isso que cartões múltiplos caíam em "não tem função débito".
   *
   * O 3DS vem via `config.online.transaction_security`; o challenge retorna
   * como URL para iframe (`transaction_security.url`), sem creq.
   *
   * `amountInCents` segue a convenção interna (centavos); o MP fala em reais
   * decimais em STRING, a conversão acontece aqui e SÓ aqui.
   */
  async createDebitPayment(params: {
    amountInCents: number;
    orderId: string;
    cardToken: string;
    paymentMethodId: string;
    /** payment_type_id do BIN lookup (debit_card | prepaid_card) — vai como veio. */
    paymentMethodType?: 'debit_card' | 'prepaid_card';
    payer: { email?: string; firstName?: string; lastName?: string; cpf?: string };
    /** additional_info do checklist de aprovação (items + payer) — só a rota clássica usa. */
    additionalInfo?: Record<string, any>;
    deviceId?: string;
    idempotencyKey: string;
    notificationUrl?: string;
    description?: string;
  }): Promise<MpPaymentResult> {
    if (!this.enabled) {
      return { success: false, error: 'Mercado Pago is not configured (MP_ACCESS_TOKEN missing)' };
    }

    // id + type vão COMO VIERAM do BIN lookup (a Orders API valida contra a
    // conta). Sem type informado, infere: deb* = debit_card; id cru
    // (visa/master/elo) = prepaid_card. `credit_card` NUNCA (o DTO já barra) —
    // cobraria crédito silenciosamente como débito.
    const brandId = params.paymentMethodId;
    const methodType: 'debit_card' | 'prepaid_card' =
      params.paymentMethodType === 'prepaid_card'
        ? 'prepaid_card'
        : params.paymentMethodType === 'debit_card'
          ? 'debit_card'
          : /^deb/.test(brandId)
            ? 'debit_card'
            : 'prepaid_card';
    const amount = (params.amountInCents / 100).toFixed(2);

    const body: Record<string, any> = {
      type: 'online',
      processing_mode: 'automatic',
      external_reference: params.orderId,
      total_amount: amount,
      payer: {
        email: params.payer.email || undefined,
        ...(params.payer.firstName && { first_name: params.payer.firstName }),
        ...(params.payer.lastName && { last_name: params.payer.lastName }),
        ...(params.payer.cpf && {
          identification: { type: 'CPF', number: params.payer.cpf },
        }),
      },
      transactions: {
        payments: [
          {
            amount,
            payment_method: {
              id: brandId,
              type: methodType,
              token: params.cardToken,
              // installments só existe p/ debit_card — em prepaid_card a Orders
              // API recusa ("additionalProperties 'installments' not allowed";
              // pré-pago é à vista por definição).
              ...(methodType === 'debit_card' && { installments: 1 }),
            },
          },
        ],
      },
      // 3DS conforme risco, com liability shift pro emissor — o challenge chega
      // como transaction_security.url (iframe direto no MpChallengeModal).
      config: {
        online: {
          transaction_security: { validation: 'on_fraud_risk', liability_shift: 'required' },
        },
      },
    };

    // Diagnóstico (mascarado): confirma se identification foi incluída no body.
    this.logger.log(
      `[MP-debit] orders body: identification=${body.payer?.identification ? 'INCLUIDA' : 'AUSENTE'} brand=${brandId} type=${methodType} device=${params.deviceId ? 'sim' : 'nao'}`,
    );

    try {
      const response = await this.client.post('/v1/orders', body, {
        headers: {
          // Idempotência exigida pelo MP; reusa a key do checkout (escopada
          // por user+order via Redis) para retry seguro do mesmo pagamento.
          'X-Idempotency-Key': params.idempotencyKey,
          ...(params.deviceId && { 'X-meli-session-id': params.deviceId }),
        },
      });
      return this.toOrderResult(response.data);
    } catch (err: any) {
      const data = err?.response?.data;
      const apiMessage = data?.errors?.[0]?.message ?? data?.message ?? err.message;
      // Fallback: se a Orders API recusar o FORMATO (qualquer 400 de validação
      // com array errors — property_value, unsupported_properties etc.), tenta
      // a /v1/payments clássica, que comprovadamente aceita ids de pré-pago
      // (chegava ao motor de risco). Recusa de negócio NÃO vem como 400.
      const isFormatRejection = err?.response?.status === 400 && Array.isArray(data?.errors);
      if (isFormatRejection) {
        this.logger.warn(
          `[MP-debit] Orders API recusou o formato (${JSON.stringify(data?.errors?.[0]?.details ?? []).slice(0, 200)}) — fallback pra /v1/payments clássica`,
        );
        return this.createClassicDebitPayment(params);
      }
      this.logger.error(
        `MP createDebitPayment (orders) falhou (order ${params.orderId}): ${apiMessage}`,
        data ? JSON.stringify(data).slice(0, 500) : undefined,
      );
      return { success: false, error: apiMessage };
    }
  }

  /**
   * Caminho CLÁSSICO (/v1/payments) — usado para PRÉ-PAGOS (visa/master/elo),
   * que a Orders API não aceita em type debit_card. 3DS mandatory: sem ele o
   * risco recusava direto (cc_rejected_high_risk) sem desafiar.
   */
  private async createClassicDebitPayment(params: {
    amountInCents: number;
    orderId: string;
    cardToken: string;
    paymentMethodId: string;
    payer: { email?: string; firstName?: string; lastName?: string; cpf?: string };
    additionalInfo?: Record<string, any>;
    deviceId?: string;
    idempotencyKey: string;
    notificationUrl?: string;
    description?: string;
  }): Promise<MpPaymentResult> {
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
      // PRÉ-PAGO não suporta 3DS: mandatory aqui gerava `internal_error` no MP.
      // optional deixa o risco decidir (com CPF do titular + device fingerprint).
      three_d_secure_mode: 'optional',
      // Pilar 2 do checklist de aprovação: items + dados do comprador (o plugin
      // oficial WooCommerce do MP envia sempre; ausência pesa no high_risk).
      ...(params.additionalInfo && { additional_info: params.additionalInfo }),
      ...(params.notificationUrl && { notification_url: params.notificationUrl }),
    };

    this.logger.log(
      `[MP-debit] classic body (pre-pago): identification=${body.payer?.identification ? 'INCLUIDA' : 'AUSENTE'} method=${params.paymentMethodId} device=${params.deviceId ? 'sim' : 'nao'}`,
    );

    try {
      const response = await this.client.post('/v1/payments', body, {
        headers: {
          'X-Idempotency-Key': params.idempotencyKey,
          ...(params.deviceId && { 'X-meli-session-id': params.deviceId }),
        },
      });
      return this.toResult(response.data);
    } catch (err: any) {
      const apiMessage = err?.response?.data?.message ?? err.message;
      this.logger.error(
        `MP createClassicDebitPayment falhou (order ${params.orderId}): ${apiMessage}`,
        err?.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : undefined,
      );
      return { success: false, error: apiMessage };
    }
  }

  /** Ids da Orders API são alfanuméricos (ORD...); os da /v1/payments, numéricos. */
  private isOrderId(id: string): boolean {
    return !/^\d+$/.test(id);
  }

  /** Consulta o estado real de um pagamento/order (anti-forjamento do webhook e polling). */
  async getPayment(mpPaymentId: string): Promise<MpPaymentResult> {
    try {
      if (this.isOrderId(mpPaymentId)) {
        const response = await this.client.get(`/v1/orders/${mpPaymentId}`);
        return this.toOrderResult(response.data);
      }
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
      if (this.isOrderId(mpPaymentId)) {
        // Orders API: estorno TOTAL = POST /refund sem body; PARCIAL exige o id
        // do payment interno da order + amount decimal em string.
        let body: Record<string, any> | undefined;
        if (amountInCents != null) {
          const { data: order } = await this.client.get(`/v1/orders/${mpPaymentId}`);
          const innerPaymentId = order?.transactions?.payments?.[0]?.id;
          if (!innerPaymentId) {
            return { success: false, error: 'Order sem payment interno para estorno parcial' };
          }
          body = {
            transactions: {
              payments: [{ id: innerPaymentId, amount: (amountInCents / 100).toFixed(2) }],
            },
          };
        }
        await this.client.post(`/v1/orders/${mpPaymentId}/refund`, body ?? undefined, {
          headers: { 'X-Idempotency-Key': crypto.randomUUID() },
        });
        return await this.getPayment(mpPaymentId);
      }
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
      if (this.isOrderId(mpPaymentId)) {
        const response = await this.client.post(`/v1/orders/${mpPaymentId}/cancel`, undefined, {
          headers: { 'X-Idempotency-Key': crypto.randomUUID() },
        });
        return this.toOrderResult(response.data);
      }
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

  /**
   * Normaliza a resposta da ORDERS API num MpPaymentResult (mesmo contrato do
   * toResult): callers (polling, webhook, refund) não distinguem as duas APIs.
   *
   * Mapeamento de status da order → vocabulário de payment (mapMpStatusToPaymentStatus):
   *   processed → approved · action_required/at_terminal → pending ·
   *   failed → rejected · canceled/expired → cancelled · refunded → refunded.
   * O challenge 3DS vem como URL pura (transaction_security.url) — creq vazio
   * sinaliza ao front "iframe direto, sem form POST".
   */
  private toOrderResult(order: any): MpPaymentResult {
    const pay = order?.transactions?.payments?.[0];
    const orderStatus: string | undefined = order?.status;
    const statusDetail: string | undefined = pay?.status_detail ?? order?.status_detail;
    const challengeUrl: string | undefined = pay?.payment_method?.transaction_security?.url;

    const statusMap: Record<string, string> = {
      processed: 'approved',
      action_required: 'pending',
      at_terminal: 'pending',
      failed: 'rejected',
      canceled: 'cancelled',
      expired: 'cancelled',
      refunded: 'refunded',
      partially_refunded: 'approved',
    };
    const mpStatus = orderStatus ? (statusMap[orderStatus] ?? orderStatus) : undefined;

    const challenge =
      mpStatus === 'pending' && challengeUrl
        ? { externalResourceUrl: challengeUrl, creq: '' }
        : undefined;

    return {
      success: orderStatus === 'processed',
      mpPaymentId: order?.id != null ? String(order.id) : undefined,
      mpStatus,
      statusDetail,
      paymentMethodId: pay?.payment_method?.id,
      cardBrand: this.brandFromMethodId(pay?.payment_method?.id),
      last4Digits: pay?.payment_method?.card?.last_four_digits ?? undefined,
      holder: pay?.payment_method?.card?.cardholder?.name ?? undefined,
      challenge,
    };
  }
}
