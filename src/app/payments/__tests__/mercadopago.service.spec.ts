/**
 * ============================================================================
 * ROTEIRO — O que este arquivo testa
 * ============================================================================
 *
 * O MercadoPagoService é o gateway do cartão de DÉBITO (crédito/PIX seguem na
 * Cielo). Validamos a LÓGICA PURA — sem falar com o MP de verdade:
 *
 *   1. Body do POST /v1/payments do débito: valor convertido de CENTAVOS para
 *      reais decimais, installments=1, payment_method_id de débito, payer com
 *      CPF opcional, external_reference = orderId, three_d_secure_mode=mandatory (default; MP_3DS_MODE=optional faz opt-out)
 *      e headers X-Idempotency-Key / X-meli-session-id (device).
 *   2. Recusa de payment_method_id que NÃO é débito (proteção contra cobrar
 *      crédito por engano).
 *   3. Normalização da resposta: approved → success; pending_challenge →
 *      challenge{externalResourceUrl,creq}; rejected → success=false.
 *   4. Mapa de status MP → PaymentStatus interno (mesma semântica da Cielo).
 *   5. Assinatura do webhook (x-signature ts/v1, manifesto id;request-id;ts)
 *      com HMAC-SHA256 — aceita válida, rejeita adulterada.
 *   6. `enabled` controla o fallback: sem MP_ACCESS_TOKEN o débito continua
 *      no fluxo Cielo (testado no orders.service, aqui só o getter).
 * ============================================================================
 */

import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus } from '@prisma/client';
import { MercadoPagoService } from '../mercadopago.service';

function makeConfig(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function makeService(overrides: Record<string, string> = {}) {
  const service = new MercadoPagoService(
    makeConfig({ MP_ACCESS_TOKEN: 'TEST-abc123', MP_WEBHOOK_SECRET: 'whsec', ...overrides }),
  );
  const post = jest.fn();
  const get = jest.fn();
  const put = jest.fn();
  (service as any).client = { post, get, put };
  return { service, post, get, put };
}

const approvedPayment = {
  id: 12345678901,
  status: 'approved',
  status_detail: 'accredited',
  payment_method_id: 'debvisa',
  card: { last_four_digits: '1234', cardholder: { name: 'FULANO SILVA' } },
};

describe('MercadoPagoService — débito', () => {
  it('enabled reflete a presença de MP_ACCESS_TOKEN (fallback Cielo sem token)', () => {
    expect(makeService().service.enabled).toBe(true);
    const disabled = new MercadoPagoService(makeConfig({}));
    expect(disabled.enabled).toBe(false);
  });

  it('sandboxMode = credencial com prefixo TEST-', () => {
    expect(makeService().service.sandboxMode).toBe(true);
    expect(makeService({ MP_ACCESS_TOKEN: 'APP_USR-live' }).service.sandboxMode).toBe(false);
  });

  it('monta o body do débito: centavos→reais, installments=1, payer CPF, 3DS optional, headers', async () => {
    const { service, post } = makeService();
    post.mockResolvedValue({ data: approvedPayment });

    const result = await service.createDebitPayment({
      amountInCents: 15750, // R$ 157,50
      orderId: 'order-uuid-1',
      cardToken: 'tok_abc',
      paymentMethodId: 'debvisa',
      payer: { email: 'a@b.com', firstName: 'Fulano', lastName: 'Silva', cpf: '12345678901' },
      deviceId: 'device-123',
      idempotencyKey: 'idem-1',
      notificationUrl: 'https://api.example.com/api/v1/payments/mp-webhook',
    });

    expect(post).toHaveBeenCalledWith('/v1/payments', expect.any(Object), expect.any(Object));
    const [, body, options] = post.mock.calls[0];

    expect(body.transaction_amount).toBe(157.5); // reais decimais, nunca centavos
    expect(body.token).toBe('tok_abc');
    expect(body.installments).toBe(1); // débito é sempre à vista
    expect(body.payment_method_id).toBe('debvisa');
    expect(body.payer.email).toBe('a@b.com');
    expect(body.payer.identification).toEqual({ type: 'CPF', number: '12345678901' });
    expect(body.external_reference).toBe('order-uuid-1');
    expect(body.three_d_secure_mode).toBe('mandatory');
    expect(body.capture).toBe(true);
    expect(body.notification_url).toContain('/mp-webhook');
    expect(options.headers['X-Idempotency-Key']).toBe('idem-1');
    expect(options.headers['X-meli-session-id']).toBe('device-123');

    expect(result.success).toBe(true);
    expect(result.mpPaymentId).toBe('12345678901');
    expect(result.cardBrand).toBe('Visa');
    expect(result.last4Digits).toBe('1234');
  });

  it('sem CPF: payer vai sem identification (participante estrangeiro)', async () => {
    const { service, post } = makeService();
    post.mockResolvedValue({ data: approvedPayment });

    await service.createDebitPayment({
      amountInCents: 1000,
      orderId: 'o1',
      cardToken: 't',
      paymentMethodId: 'debmaster',
      payer: { email: 'x@y.com' },
      idempotencyKey: 'k',
    });

    const [, body] = post.mock.calls[0];
    expect(body.payer.identification).toBeUndefined();
  });

  it('recusa payment_method_id que não é débito (não deixa cobrar como crédito)', async () => {
    const { service, post } = makeService();
    const result = await service.createDebitPayment({
      amountInCents: 1000,
      orderId: 'o1',
      cardToken: 't',
      paymentMethodId: 'visa', // crédito!
      payer: {},
      idempotencyKey: 'k',
    });
    expect(result.success).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('aceita id PRE-PAGO listado na conta (ex.: elo dos cartoes de teste) como debito', async () => {
    const { service, post, get } = makeService();
    get.mockResolvedValue({
      data: [
        { id: 'elo', payment_type_id: 'prepaid_card', status: 'active' },
        { id: 'debelo', payment_type_id: 'debit_card', status: 'active' },
        { id: 'visa', payment_type_id: 'credit_card', status: 'active' },
      ],
    });
    post.mockResolvedValue({ data: approvedPayment });

    const result = await service.createDebitPayment({
      amountInCents: 1000,
      orderId: 'o-prepaid',
      cardToken: 't',
      paymentMethodId: 'elo',
      payer: {},
      idempotencyKey: 'k2',
    });
    expect(get).toHaveBeenCalledWith('/v1/payment_methods');
    expect(result.success).toBe(true);
    expect(post).toHaveBeenCalled();
  });

  it('pending_challenge → devolve challenge {externalResourceUrl, creq}', async () => {
    const { service, post } = makeService();
    post.mockResolvedValue({
      data: {
        id: 555,
        status: 'pending',
        status_detail: 'pending_challenge',
        payment_method_id: 'debmaster',
        three_ds_info: { external_resource_url: 'https://acs.bank/3ds', creq: 'creq-token' },
      },
    });

    const result = await service.createDebitPayment({
      amountInCents: 1000,
      orderId: 'o1',
      cardToken: 't',
      paymentMethodId: 'debmaster',
      payer: {},
      idempotencyKey: 'k',
    });

    expect(result.success).toBe(false);
    expect(result.challenge).toEqual({ externalResourceUrl: 'https://acs.bank/3ds', creq: 'creq-token' });
    expect(result.mpPaymentId).toBe('555');
    expect(result.cardBrand).toBe('Master');
  });

  it('rejected → success=false com statusDetail preservado', async () => {
    const { service, post } = makeService();
    post.mockResolvedValue({
      data: { id: 7, status: 'rejected', status_detail: 'cc_rejected_insufficient_amount', payment_method_id: 'debvisa' },
    });

    const result = await service.createDebitPayment({
      amountInCents: 1000,
      orderId: 'o1',
      cardToken: 't',
      paymentMethodId: 'debvisa',
      payer: {},
      idempotencyKey: 'k',
    });

    expect(result.success).toBe(false);
    expect(result.statusDetail).toBe('cc_rejected_insufficient_amount');
    expect(service.mapRejectionMessage(result.statusDetail)).toContain('Saldo insuficiente');
  });

  it('mapMpStatusToPaymentStatus: mesma semântica do mapa da Cielo', () => {
    const { service } = makeService();
    expect(service.mapMpStatusToPaymentStatus('approved')).toBe(PaymentStatus.PAID);
    expect(service.mapMpStatusToPaymentStatus('pending')).toBe(PaymentStatus.PENDING);
    expect(service.mapMpStatusToPaymentStatus('in_process')).toBe(PaymentStatus.PENDING);
    expect(service.mapMpStatusToPaymentStatus('rejected')).toBe(PaymentStatus.FAILED);
    expect(service.mapMpStatusToPaymentStatus('cancelled')).toBe(PaymentStatus.FAILED);
    expect(service.mapMpStatusToPaymentStatus('refunded')).toBe(PaymentStatus.REFUNDED);
    expect(service.mapMpStatusToPaymentStatus('charged_back')).toBe(PaymentStatus.REFUNDED);
    expect(service.mapMpStatusToPaymentStatus('???')).toBeNull();
  });

  describe('verifyWebhookSignature (x-signature HMAC)', () => {
    const sign = (secret: string, dataId: string, requestId: string, ts: string) =>
      crypto
        .createHmac('sha256', secret)
        .update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`)
        .digest('hex');

    it('aceita assinatura válida', () => {
      const { service } = makeService();
      const v1 = sign('whsec', '123', 'req-1', '1700000000');
      expect(
        service.verifyWebhookSignature({
          xSignature: `ts=1700000000,v1=${v1}`,
          xRequestId: 'req-1',
          dataId: '123',
        }),
      ).toBe(true);
    });

    it('rejeita assinatura adulterada ou de outro payload', () => {
      const { service } = makeService();
      const v1 = sign('whsec', '123', 'req-1', '1700000000');
      // outro data.id com a mesma assinatura → inválido
      expect(
        service.verifyWebhookSignature({
          xSignature: `ts=1700000000,v1=${v1}`,
          xRequestId: 'req-1',
          dataId: '999',
        }),
      ).toBe(false);
      // v1 corrompido → inválido
      expect(
        service.verifyWebhookSignature({
          xSignature: `ts=1700000000,v1=${'0'.repeat(64)}`,
          xRequestId: 'req-1',
          dataId: '123',
        }),
      ).toBe(false);
      // header ausente → inválido
      expect(service.verifyWebhookSignature({ dataId: '123' })).toBe(false);
    });
  });

  it('refundPayment converte centavos→reais no estorno parcial e reconsulta o pagamento', async () => {
    const { service, post, get } = makeService();
    post.mockResolvedValue({ data: {} });
    get.mockResolvedValue({ data: { ...approvedPayment, status: 'refunded' } });

    const result = await service.refundPayment('987', 5025); // R$ 50,25 parcial

    expect(post).toHaveBeenCalledWith('/v1/payments/987/refunds', { amount: 50.25 }, expect.any(Object));
    expect(get).toHaveBeenCalledWith('/v1/payments/987');
    expect(result.mpStatus).toBe('refunded');
  });

  it('refundPayment total: body vazio (sem amount)', async () => {
    const { service, post, get } = makeService();
    post.mockResolvedValue({ data: {} });
    get.mockResolvedValue({ data: { ...approvedPayment, status: 'refunded' } });

    await service.refundPayment('987');
    expect(post.mock.calls[0][1]).toEqual({});
  });
});
