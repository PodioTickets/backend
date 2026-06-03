/**
 * ============================================================================
 * ROTEIRO (em português leigo) — O que este arquivo testa
 * ============================================================================
 *
 * O CieloService é quem monta o "pacote" (request body) que enviamos para a
 * Cielo na hora de cobrar um cliente. Já tivemos bugs sérios nesse pacote
 * (número de cartão mascarado indo no payload, Provider vazio em produção,
 * etc.), então aqui validamos a LÓGICA PURA de montagem — NÃO conversamos com
 * a Cielo de verdade.
 *
 * COMO testamos sem internet:
 *   - Trocamos o "axiosInstance" interno do service por um dublê (jest.fn) que
 *     finge uma resposta de sucesso da Cielo.
 *   - Depois inspecionamos o 2º argumento do .post(...) — que é exatamente o
 *     corpo (body) que teria ido para a Cielo — e conferimos campo a campo.
 *
 * O QUE conferimos (tudo lido do código real, não inventado):
 *   1. Bandeira do cartão deduzida pelo NÚMERO (Visa, Master, Amex...).
 *   2. Validade convertida de MM/YY para MM/YYYY (com barra).
 *   3. Body de CRÉDITO: Type=CreditCard, Capture=false, Provider certo por
 *      ambiente (sandbox='Simulado' / produção='Cielo30'), e o objeto
 *      CreditCard preenchido (CardNumber só dígitos, Holder, ExpirationDate,
 *      SecurityCode, Brand). Também o caminho via CardToken.
 *   4. Customer: Name sempre; Identity/IdentityType só quando há CPF; sem CPF
 *      vai só o Name.
 *   5. PIX: Type=Pix, Provider por ambiente, SEM Email no Customer.
 *   6. Valores ficam em CENTAVOS (o service recebe centavos e repassa igual).
 *
 * IMPORTANTE: testamos SÓ o que o código faz hoje. Onde o comportamento real
 * difere do "ideal" ou de comentários do código, anotamos no relatório final
 * (não corrigimos produção).
 * ============================================================================
 */

import { ConfigService } from '@nestjs/config';
import { PaymentMethod } from '@prisma/client';
import { CieloService } from '../cielo.service';

/**
 * Cria um ConfigService dublê. Por padrão devolve credenciais válidas e
 * ambiente SANDBOX. Passe `env: 'production'` para forçar produção.
 */
function makeConfig(env: 'sandbox' | 'production' = 'sandbox'): ConfigService {
  const values: Record<string, string> = {
    CIELO_MERCHANT_ID: 'merchant-id-fake',
    CIELO_MERCHANT_KEY: 'merchant-key-fake',
    // O service considera produção apenas quando CIELO_ENV === 'production'.
    CIELO_ENV: env === 'production' ? 'production' : 'sandbox',
  };
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

/**
 * Instancia o service e injeta um axios dublê que SEMPRE responde sucesso.
 * Retorna o service e o mock do .post para inspeção do request body.
 */
function makeService(env: 'sandbox' | 'production' = 'sandbox') {
  const service = new CieloService(makeConfig(env));

  // Resposta de sucesso mínima da Cielo (Status 1 = Autorizado).
  const postMock = jest.fn().mockResolvedValue({
    status: 200,
    headers: {},
    data: {
      MerchantOrderId: 'order-1',
      Payment: {
        PaymentId: 'cielo-payment-id-1',
        Type: 'CreditCard',
        Status: 1,
        ReturnCode: '4',
        ReturnMessage: 'Operation Successful',
        CreditCard: { Brand: 'Visa' },
      },
    },
  });

  // Substitui o axios interno usado pelo createPayment.
  (service as any).axiosInstance = { post: postMock, defaults: { baseURL: 'https://fake', headers: {} } };

  return { service, postMock };
}

/** Atalho: pega o body (2º arg) do primeiro .post capturado. */
function capturedBody(postMock: jest.Mock): any {
  expect(postMock).toHaveBeenCalledTimes(1);
  return postMock.mock.calls[0][1];
}

describe('CieloService — montagem do payload enviado à Cielo (lógica pura)', () => {
  // Dados de cartão de teste reutilizáveis (Visa). Validade futura para passar na validação de ano.
  const cardVisa = {
    number: '4111 1111 1111 1111',
    holder: 'JOAO DA SILVA',
    expiry: '12/30',
    cvv: '123',
    installments: 1,
  };

  describe('Detecção de bandeira pelo número do cartão', () => {
    // Tabela: prefixo de número -> bandeira esperada (conforme detectCardBrand).
    const casos: Array<[string, string, string]> = [
      ['Visa', '4111111111111111', 'Visa'],
      ['Master (5x)', '5111111111111111', 'Master'],
      ['Master (2x)', '2221111111111111', 'Master'],
      ['Amex', '341111111111111', 'Amex'],
      // OBS: Visa (^4) é checado ANTES de Elo no código, então prefixos Elo que
      // começam com 4 (ex.: 4011, 431274...) são detectados como Visa. Usamos um
      // prefixo Elo que NÃO começa com 4 (636297) para exercitar o ramo Elo.
      ['Elo', '6362971111111111', 'Elo'],
      ['Discover', '6011111111111111', 'Discover'],
      ['JCB', '3511111111111111', 'JCB'],
      ['Diners', '3011111111111111', 'Diners'],
    ];

    it.each(casos)(
      'deve detectar %s e enviar em CreditCard.Brand',
      async (_nome, numero, brandEsperada) => {
        const { service, postMock } = makeService('sandbox');

        await service.createPayment(
          1000,
          'BRL',
          PaymentMethod.CREDIT_CARD,
          'order-1',
          { name: 'Cliente' },
          { ...cardVisa, number: numero },
        );

        const body = capturedBody(postMock);
        expect(body.Payment.CreditCard.Brand).toBe(brandEsperada);
      },
    );

    it('retorna erro (success=false) quando a bandeira não é reconhecida (ex.: começa com 9)', async () => {
      // OBS: a validação ocorre DENTRO do try do createPayment, então o erro é
      // capturado pelo catch e devolvido como { success:false }, NÃO lançado.
      const { service, postMock } = makeService('sandbox');

      const res = await service.createPayment(
        1000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: 'Cliente' },
        { ...cardVisa, number: '9999999999999999' },
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('Unable to detect card brand');
      // E nada foi enviado à Cielo.
      expect(postMock).not.toHaveBeenCalled();
    });
  });

  describe('Conversão de validade MM/YY -> MM/YYYY', () => {
    it('converte 12/30 em 12/2030 (com barra)', async () => {
      const { service, postMock } = makeService('sandbox');

      await service.createPayment(
        1000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: 'Cliente' },
        { ...cardVisa, expiry: '12/30' },
      );

      expect(capturedBody(postMock).Payment.CreditCard.ExpirationDate).toBe('12/2030');
    });

    it('faz padStart no mês: 1/30 vira 01/2030', async () => {
      const { service, postMock } = makeService('sandbox');

      await service.createPayment(
        1000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: 'Cliente' },
        { ...cardVisa, expiry: '1/30' },
      );

      expect(capturedBody(postMock).Payment.CreditCard.ExpirationDate).toBe('01/2030');
    });

    it('mantém ano de 4 dígitos: 12/2031 permanece 12/2031', async () => {
      const { service, postMock } = makeService('sandbox');

      await service.createPayment(
        1000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: 'Cliente' },
        { ...cardVisa, expiry: '12/2031' },
      );

      expect(capturedBody(postMock).Payment.CreditCard.ExpirationDate).toBe('12/2031');
    });

    it('rejeita mês inválido (13/30) — retorna success=false', async () => {
      const { service, postMock } = makeService('sandbox');

      const res = await service.createPayment(
        1000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: 'Cliente' },
        { ...cardVisa, expiry: '13/30' },
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('Invalid month');
      expect(postMock).not.toHaveBeenCalled();
    });

    it('rejeita ano no passado (12/20) — retorna success=false', async () => {
      const { service, postMock } = makeService('sandbox');

      const res = await service.createPayment(
        1000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: 'Cliente' },
        { ...cardVisa, expiry: '12/20' },
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('Invalid year');
      expect(postMock).not.toHaveBeenCalled();
    });
  });

  describe('Body de CRÉDITO (cartão com dados completos)', () => {
    it('monta Type=CreditCard, Capture=false e CreditCard preenchido', async () => {
      const { service, postMock } = makeService('sandbox');

      await service.createPayment(
        12345,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-credit',
        { name: 'Cliente' },
        { ...cardVisa, installments: 3 },
      );

      const body = capturedBody(postMock);
      expect(body.MerchantOrderId).toBe('order-credit');
      expect(body.Payment.Type).toBe('CreditCard');
      // Capture=false: a captura é feita em etapa separada (capturePayment).
      expect(body.Payment.Capture).toBe(false);
      expect(body.Payment.Currency).toBe('BRL');
      expect(body.Payment.Installments).toBe(3);
      expect(body.Payment.CreditCard).toEqual({
        // CardNumber sai SÓ com dígitos (espaços removidos).
        CardNumber: '4111111111111111',
        Holder: 'JOAO DA SILVA',
        ExpirationDate: '12/2030',
        SecurityCode: '123',
        Brand: 'Visa',
      });
    });

    it('Provider = "Simulado" em sandbox', async () => {
      const { service, postMock } = makeService('sandbox');

      await service.createPayment(
        1000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: 'Cliente' },
        cardVisa,
      );

      expect(capturedBody(postMock).Payment.Provider).toBe('Simulado');
    });

    it('Provider = "Cielo30" em produção', async () => {
      const { service, postMock } = makeService('production');

      await service.createPayment(
        1000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: 'Cliente' },
        cardVisa,
      );

      expect(capturedBody(postMock).Payment.Provider).toBe('Cielo30');
    });

    it('Installments cai para 1 quando não informado (0/undefined)', async () => {
      const { service, postMock } = makeService('sandbox');

      await service.createPayment(
        1000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: 'Cliente' },
        { ...cardVisa, installments: 0 },
      );

      expect(capturedBody(postMock).Payment.Installments).toBe(1);
    });

    it('CVV inválido (2 dígitos) é rejeitado — retorna success=false', async () => {
      const { service, postMock } = makeService('sandbox');

      const res = await service.createPayment(
        1000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: 'Cliente' },
        { ...cardVisa, cvv: '12' },
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('Invalid CVV');
      expect(postMock).not.toHaveBeenCalled();
    });
  });

  describe('Body de CRÉDITO via CardToken (cartão salvo)', () => {
    it('usa CardToken + Brand e NÃO inclui CardNumber/ExpirationDate', async () => {
      const { service, postMock } = makeService('production');

      await service.createPayment(
        2000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-token',
        { name: 'Cliente' },
        undefined, // sem cardData
        {
          token: 'tok-abc',
          brand: 'Master',
          holder: 'MARIA',
          securityCode: '999',
          installments: 2,
        },
      );

      const body = capturedBody(postMock);
      expect(body.Payment.Type).toBe('CreditCard');
      expect(body.Payment.Capture).toBe(false);
      expect(body.Payment.Provider).toBe('Cielo30');
      expect(body.Payment.Installments).toBe(2);
      expect(body.Payment.CreditCard).toEqual({
        CardToken: 'tok-abc',
        Brand: 'Master',
        Holder: 'MARIA',
        SecurityCode: '999',
      });
      // Não deve vazar dados de cartão cru.
      expect(body.Payment.CreditCard.CardNumber).toBeUndefined();
      expect(body.Payment.CreditCard.ExpirationDate).toBeUndefined();
    });

    it('omite Holder e SecurityCode quando não fornecidos no token', async () => {
      const { service, postMock } = makeService('sandbox');

      await service.createPayment(
        2000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-token',
        { name: 'Cliente' },
        undefined,
        { token: 'tok-xyz', brand: 'Visa', installments: 1 },
      );

      const body = capturedBody(postMock);
      expect(body.Payment.CreditCard).toEqual({
        CardToken: 'tok-xyz',
        Brand: 'Visa',
      });
    });
  });

  describe('Montagem do Customer', () => {
    it('com CPF: envia Name + Identity + IdentityType (default CPF)', async () => {
      const { service, postMock } = makeService('sandbox');

      await service.createPayment(
        1000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: '  Joao  ', identity: '12345678901', email: 'joao@x.com' },
        cardVisa,
      );

      const body = capturedBody(postMock);
      expect(body.Customer).toEqual({
        Name: 'Joao', // trim aplicado
        Identity: '12345678901',
        IdentityType: 'CPF',
        Email: 'joao@x.com',
      });
    });

    it('respeita IdentityType custom quando informado', async () => {
      const { service, postMock } = makeService('sandbox');

      await service.createPayment(
        1000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: 'Empresa', identity: '11222333000181', identityType: 'CNPJ' },
        cardVisa,
      );

      expect(capturedBody(postMock).Customer.IdentityType).toBe('CNPJ');
    });

    it('sem CPF: envia só Name (sem Identity/IdentityType) — caso passaporte/estrangeiro', async () => {
      const { service, postMock } = makeService('sandbox');

      await service.createPayment(
        1000,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: 'John Foreigner', email: 'john@x.com' },
        cardVisa,
      );

      const body = capturedBody(postMock);
      expect(body.Customer.Name).toBe('John Foreigner');
      expect(body.Customer.Identity).toBeUndefined();
      expect(body.Customer.IdentityType).toBeUndefined();
      // Email permitido em crédito.
      expect(body.Customer.Email).toBe('john@x.com');
    });
  });

  describe('Body de PIX', () => {
    it('monta Type=Pix, Provider por ambiente e SEM Currency', async () => {
      const { service, postMock } = makeService('sandbox');

      await service.createPayment(
        5000,
        'BRL',
        PaymentMethod.PIX,
        'order-pix',
        { name: 'Cliente PIX' },
      );

      const body = capturedBody(postMock);
      expect(body.Payment.Type).toBe('Pix');
      expect(body.Payment.Provider).toBe('Simulado');
      // PIX não envia Currency.
      expect(body.Payment.Currency).toBeUndefined();
      expect(body.Payment.Amount).toBe(5000);
    });

    it('Provider = "Cielo30" em produção para PIX', async () => {
      const { service, postMock } = makeService('production');

      await service.createPayment(
        5000,
        'BRL',
        PaymentMethod.PIX,
        'order-pix',
        { name: 'Cliente PIX' },
      );

      expect(capturedBody(postMock).Payment.Provider).toBe('Cielo30');
    });

    it('Customer do PIX leva Name mas NÃO leva Email (mesmo se fornecido)', async () => {
      const { service, postMock } = makeService('sandbox');

      await service.createPayment(
        5000,
        'BRL',
        PaymentMethod.PIX,
        'order-pix',
        { name: 'Cliente PIX', email: 'pix@x.com', identity: '12345678901' },
      );

      const body = capturedBody(postMock);
      expect(body.Customer.Name).toBe('Cliente PIX');
      expect(body.Customer.Identity).toBe('12345678901');
      // Email é deliberadamente omitido no PIX.
      expect(body.Customer.Email).toBeUndefined();
    });
  });

  describe('Valores em centavos preservados', () => {
    it('repassa o amount recebido sem conversão (12345 -> 12345)', async () => {
      const { service, postMock } = makeService('sandbox');

      await service.createPayment(
        12345,
        'BRL',
        PaymentMethod.CREDIT_CARD,
        'order-1',
        { name: 'Cliente' },
        cardVisa,
      );

      expect(capturedBody(postMock).Payment.Amount).toBe(12345);
    });
  });

  describe('Guarda de configuração', () => {
    it('lança "Cielo is not configured" quando faltam credenciais', async () => {
      // Sem MERCHANT_ID/KEY o construtor zera o axiosInstance.
      const cfg = {
        get: (key: string) => (key === 'CIELO_ENV' ? 'sandbox' : undefined),
      } as unknown as ConfigService;
      const service = new CieloService(cfg);

      await expect(
        service.createPayment(1000, 'BRL', PaymentMethod.PIX, 'order-1', { name: 'X' }),
      ).rejects.toThrow('Cielo is not configured');
    });
  });
});
