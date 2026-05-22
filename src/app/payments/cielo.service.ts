import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
import * as crypto from 'crypto';

export interface CieloPaymentResult {
  success: boolean;
  paymentId?: string;
  paymentIntentId?: string;
  clientSecret?: string;
  qrCode?: string;
  pixCode?: string;
  txId?: string;        // Cielo2: SentOrderId (txid)
  endToEndId?: string;  // Cielo2: set after payment is made
  barcode?: string;
  boletoUrl?: string;
  expiresAt?: Date;
  error?: string;
  errorDetails?: any;
  cieloStatus?: string;
  authorizationCode?: string;
  proofOfSale?: string;
  returnCode?: string;
  returnMessage?: string;
  cardBrand?: string;
  authenticationUrl?: string; // Debit card 3DS redirect URL
}

export interface CieloPaymentResponse {
  MerchantOrderId: string;
  Payment: {
    PaymentId: string;
    Type: string;
    Amount: number;
    Currency: string;
    Country: string;
    Status: number;
    Provider: string;
    ReturnCode?: number;
    ReturnMessage?: string;
    // Cielo2 PIX fields
    SentOrderId?: string;        // txid in Cielo2 (was MerchantOrderId in legacy)
    EndToEndId?: string;         // set after payment is made (Cielo2 only)
    QrCodeBase64Image?: string;
    QrCodeString?: string;
    ExpirationDate?: string;
    // Credit/debit card fields
    AuthorizationCode?: string;
    AuthenticationUrl?: string;
    ProofOfSale?: string;        // not present in Cielo2 PIX
    CreditCard?: { Brand?: string };
    DebitCard?: { Brand?: string };
    // Boleto fields
    DigitableLine?: string;
    BarCodeNumber?: string;
    Instructions?: string;
    Assignor?: string;
    Address?: string;
    Identification?: string;
  };
}

@Injectable()
export class CieloService {
  private readonly axiosInstance: AxiosInstance;
  private readonly queryAxiosInstance: AxiosInstance;
  private readonly logger = new Logger(CieloService.name);
  private readonly merchantId: string;
  private readonly merchantKey: string;
  private readonly isSandbox: boolean;
  private readonly webhookSecret: string;
  private readonly threeDsClientId: string;
  private readonly threeDsClientSecret: string;
  private readonly threeDsEstablishmentCode: string;
  private readonly threeDsMerchantName: string;
  private readonly threeDsMcc: string;

  // Cache simples em memória: evita chamar o Braspag a cada request
  private threeDsTokenCache: { token: string; expiresAt: number } | null = null;

  constructor(private configService: ConfigService) {
    this.merchantId = this.configService.get<string>('CIELO_MERCHANT_ID') || '';
    this.merchantKey = this.configService.get<string>('CIELO_MERCHANT_KEY') || '';
    this.isSandbox = this.configService.get<string>('CIELO_ENV') !== 'production';
    this.webhookSecret = this.configService.get<string>('CIELO_WEBHOOK_SECRET') || '';
    this.threeDsClientId = this.configService.get<string>('CIELO_3DS_CLIENT_ID') || '';
    this.threeDsClientSecret = this.configService.get<string>('CIELO_3DS_CLIENT_SECRET') || '';
    this.threeDsEstablishmentCode = this.configService.get<string>('CIELO_3DS_ESTABLISHMENT_CODE') || '';
    this.threeDsMerchantName = this.configService.get<string>('CIELO_3DS_MERCHANT_NAME') || '';
    this.threeDsMcc = this.configService.get<string>('CIELO_3DS_MCC') || '';

    const baseURL = this.isSandbox
      ? 'https://apisandbox.braspag.com.br'
      : 'https://api.braspag.com.br';

    const queryBaseURL = this.isSandbox
      ? 'https://apiquerysandbox.braspag.com.br'
      : 'https://apiquery.braspag.com.br';

    if (!this.merchantId || !this.merchantKey) {
      this.logger.warn('CIELO_MERCHANT_ID or CIELO_MERCHANT_KEY not configured. Cielo service will be disabled.');
      this.axiosInstance = null as any;
      this.queryAxiosInstance = null as any;
      return;
    }

    this.logger.debug('Cielo credentials loaded:', {
      merchantId: this.merchantId,
      merchantKeyLength: this.merchantKey?.length || 0,
      hasMerchantId: !!this.merchantId,
      hasMerchantKey: !!this.merchantKey,
    });

    const sharedHeaders = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'MerchantId': this.merchantId,
      'MerchantKey': this.merchantKey,
    };

    this.axiosInstance = axios.create({
      baseURL,
      headers: sharedHeaders,
      timeout: 30000,
    });

    this.queryAxiosInstance = axios.create({
      baseURL: queryBaseURL,
      headers: sharedHeaders,
      timeout: 15000,
    });

    this.logger.log(`Cielo service initialized (${this.isSandbox ? 'Sandbox' : 'Production'})`);
  }

  async createPayment(
    amount: number,
    currency: string = 'BRL',
    paymentMethod: PaymentMethod,
    merchantOrderId: string,
    customerData?: {
      name?: string;
      email?: string;
      identity?: string;
      identityType?: string;
    },
    cardData?: {
      number: string;
      holder: string;
      expiry: string;
      cvv: string;
      installments: number;
    },
    cardToken?: {
      token: string;
      brand: string;
      holder?: string;
      securityCode?: string;
      installments: number;
    },
    threedsData?: {
      cavv: string;
      eci: string;
      xid?: string;
      version?: string;
      referenceId?: string;
    },
    returnUrl?: string,
  ): Promise<CieloPaymentResult> {
    if (!this.axiosInstance) {
      throw new Error('Cielo is not configured');
    }

    // amount já está em centavos (valor exato)
    const amountInCents = amount;

    try {
      // Campos base do payment - alguns campos são específicos por método
      let paymentData: any = {
        Type: '',
        Amount: amountInCents,
      };

      // Currency só é necessário para métodos que não sejam PIX
      if (paymentMethod !== PaymentMethod.PIX) {
        paymentData.Currency = currency;
      }

      switch (paymentMethod) {
        case PaymentMethod.CREDIT_CARD:
          if (!cardToken && !cardData) {
            throw new Error('Card data or card token is required for credit card payments');
          }

          paymentData.Type = 'CreditCard';
          paymentData.Capture = false;
          if (this.isSandbox) {
            paymentData.Provider = 'Simulado';
          }

          if (cardToken) {
            paymentData.Installments = cardToken.installments || 1;
            paymentData.CreditCard = {
              CardToken: cardToken.token,
              Brand: cardToken.brand,
              ...(cardToken.holder && { Holder: cardToken.holder }),
              ...(cardToken.securityCode && { SecurityCode: cardToken.securityCode }),
            };

            this.logger.debug('Credit card payment via token:', {
              brand: cardToken.brand,
              installments: paymentData.Installments,
              hasSecurityCode: !!cardToken.securityCode,
            });
            break;
          }

          // Detectar bandeira do cartão baseado no número
          const cardBrand = this.detectCardBrand(cardData.number);
          if (!cardBrand) {
            this.logger.error('Unable to detect card brand', {
              cardNumber: cardData.number?.replace(/\d(?=\d{4})/g, '*'),
            });
            throw new Error('Unable to detect card brand. Please check the card number.');
          }

          // Converter data de validade de MM/YY para MM/YYYY (formato esperado pela Cielo conforme documentação)
          const expiryParts = cardData.expiry.split('/');
          let expiryDate: string;

          if (expiryParts.length === 2) {
            const month = expiryParts[0].padStart(2, '0');
            const year = expiryParts[1];
            // Validar mês (1-12)
            const monthNum = parseInt(month, 10);
            if (monthNum < 1 || monthNum > 12) {
              throw new Error(`Invalid month: ${month}. Month must be between 01 and 12`);
            }
            // Se o ano tem 2 dígitos, converter para 4 dígitos (assumindo 20XX)
            const fullYear = year.length === 2 ? `20${year}` : year;
            // Validar ano (deve ser >= ano atual)
            const yearNum = parseInt(fullYear, 10);
            const currentYear = new Date().getFullYear();
            if (yearNum < currentYear) {
              throw new Error(`Invalid year: ${fullYear}. Year must be >= ${currentYear}`);
            }
            // Formato MM/YYYY (com barra) - formato esperado pela Cielo conforme documentação oficial
            expiryDate = `${month}/${fullYear}`;
          } else {
            // Tentar extrair mês e ano de outros formatos
            const cleaned = cardData.expiry.replace(/\D/g, '');
            if (cleaned.length >= 4) {
              const month = cleaned.substring(0, 2).padStart(2, '0');
              const year = cleaned.substring(2);
              const fullYear = year.length === 2 ? `20${year}` : year;
              expiryDate = `${month}/${fullYear}`; // Formato MM/YYYY
            } else {
              throw new Error('Invalid expiry date format. Expected MM/YY or MM/YYYY');
            }
          }

          this.logger.debug('Expiry date conversion:', {
            original: cardData.expiry,
            converted: expiryDate,
          });

          const cardNumber = cardData.number.replace(/\D/g, '');

          if (!cardData.cvv) {
            throw new Error('CVV is required');
          }

          const securityCodeStr = String(cardData.cvv).replace(/\D/g, '');
          if (!securityCodeStr || securityCodeStr.length < 3 || securityCodeStr.length > 4) {
            throw new Error(`Invalid CVV: must be 3 or 4 digits`);
          }

          paymentData.Installments = cardData.installments || 1;
          paymentData.CreditCard = {
            CardNumber: cardNumber,
            Holder: cardData.holder,
            ExpirationDate: expiryDate,
            SecurityCode: securityCodeStr,
            Brand: cardBrand,
          };

          this.logger.debug('Credit card payment data prepared:', {
            brand: cardBrand,
            installments: paymentData.Installments,
            hasCardNumber: !!cardNumber,
            cardNumberLength: cardNumber.length,
            hasHolder: !!cardData.holder,
            expiryDate: expiryDate,
            hasCvv: !!cardData.cvv,
            fullPaymentData: JSON.stringify({
              Type: paymentData.Type,
              CreditCard: {
                CardNumber: cardNumber.substring(0, 4) + '****' + cardNumber.substring(cardNumber.length - 4),
                Holder: cardData.holder,
                ExpirationDate: expiryDate,
                SecurityCode: securityCodeStr,
                Brand: cardBrand,
              },
            }),
          });
          break;

        case PaymentMethod.DEBIT_CARD:
          if (!cardData) {
            throw new Error('Card data is required for debit card payments');
          }
          if (!threedsData && !returnUrl) {
            throw new Error('Either 3DS authentication data or a returnUrl is required for debit card payments');
          }

          paymentData.Type = 'DebitCard';
          paymentData.Installments = 1;
          if (this.isSandbox) {
            paymentData.Provider = 'Simulado';
          } else {
            paymentData.Provider = 'Cielo2';
          }

          {
            const debitBrand = this.detectCardBrand(cardData.number);
            if (!debitBrand) throw new Error('Unable to detect card brand. Please check the card number.');

            const debitExpiryParts = cardData.expiry.split('/');
            let debitExpiryDate: string;
            if (debitExpiryParts.length === 2) {
              const m = debitExpiryParts[0].padStart(2, '0');
              const y = debitExpiryParts[1].length === 2 ? `20${debitExpiryParts[1]}` : debitExpiryParts[1];
              debitExpiryDate = `${m}/${y}`;
            } else {
              const cleaned = cardData.expiry.replace(/\D/g, '');
              const m = cleaned.substring(0, 2).padStart(2, '0');
              const y = cleaned.substring(2).length === 2 ? `20${cleaned.substring(2)}` : cleaned.substring(2);
              debitExpiryDate = `${m}/${y}`;
            }

            paymentData.DebitCard = {
              CardNumber: cardData.number.replace(/\D/g, ''),
              Holder: cardData.holder,
              ExpirationDate: debitExpiryDate,
              SecurityCode: String(cardData.cvv).replace(/\D/g, ''),
              Brand: debitBrand,
            };

            if (threedsData) {
              // Post-3DS flow: frontend already authenticated externally
              paymentData.Authenticate = true;
              paymentData.ExternalAuthentication = {
                Cavv: threedsData.cavv,
                Eci: threedsData.eci,
                ...(threedsData.xid && { Xid: threedsData.xid }),
                Version: threedsData.version ?? '2',
                ...(threedsData.referenceId && { ReferenceId: threedsData.referenceId }),
              };
            } else {
              // Pre-3DS flow: Cielo handles 3DS redirect via ReturnUrl
              // Authenticate: true é obrigatório para o Braspag iniciar o fluxo 3DS
              paymentData.Authenticate = true;
              paymentData.ReturnUrl = returnUrl;
            }
          }
          break;

        case PaymentMethod.PIX:
          paymentData.Type = 'Pix';
          paymentData.Provider = this.isSandbox ? 'Simulado' : 'Cielo2';
          paymentData.Amount = amountInCents;
          this.logger.debug('PIX payment data:', {
            type: paymentData.Type,
            provider: paymentData.Provider,
            amount: paymentData.Amount,
          });
          break;

        case PaymentMethod.BOLETO:
          paymentData.Type = 'Boleto';
          paymentData.Boleto = {
            ExpirationDate: new Date(Date.now() + 3 * 24 * 3600000).toISOString(), // 3 dias
            Instructions: 'Não receber após o vencimento',
            Assignor: 'PodioGo',
          };
          break;

        case PaymentMethod.CRYPTO:
          throw new Error('Crypto payments are not supported by Cielo');

        default:
          throw new Error(`Unsupported payment method: ${paymentMethod}`);
      }

      // Construir request body
      const requestBody: any = {
        MerchantOrderId: merchantOrderId,
        Payment: paymentData,
      };

      // Adicionar Customer ao request body.
      //
      // Regra por método:
      //   - PIX: Cielo exige Customer com Identity (CPF). Sem identity, não
      //     monta Customer (o PIX vai falhar antes, mas mantemos a semântica
      //     antiga pra não inventar identity falsa).
      //   - CREDIT_CARD / DEBIT_CARD: Cielo exige Customer.Name (erro 105
      //     "Customer Name is required" quando ausente). Identity é opcional —
      //     participantes estrangeiros (PASSPORT) chegam sem CPF, então só
      //     enviamos Name. Não passamos passaporte como Identity porque
      //     IdentityType da Cielo é estritamente CPF/CNPJ; mandar passaporte
      //     como CPF causaria recusa por algoritmo de validação.
      //
      // Estrutura: Name + (Identity, IdentityType opcionais) + Email
      // (Email omitido em PIX por convenção da documentação Cielo).
      const isPix = paymentMethod === PaymentMethod.PIX;
      const hasIdentity = !!customerData?.identity;
      const hasName = !!customerData?.name?.trim();
      const shouldSendCustomer = isPix ? hasIdentity : (hasName || hasIdentity);

      if (customerData && shouldSendCustomer) {
        requestBody.Customer = {
          ...(hasName && { Name: customerData.name!.trim() }),
          ...(hasIdentity && {
            Identity: customerData.identity,
            IdentityType: customerData.identityType || 'CPF',
          }),
          ...(customerData.email && !isPix && { Email: customerData.email.trim() }),
        };
      }

      this.logger.debug('Sending payment request to Cielo:', {
        method: paymentMethod,
        amount: amountInCents,
        merchantOrderId,
        paymentType: paymentData.Type,
        ...(paymentMethod === PaymentMethod.CREDIT_CARD && {
          cardBrand: paymentData.CreditCard?.Brand,
          expiryDate: paymentData.CreditCard?.ExpirationDate,
          cardNumberLength: paymentData.CreditCard?.CardNumber?.length,
        }),
      });

      // Log do request body completo (mascarando dados sensíveis apenas para cartão)
      const maskedRequestBody = { ...requestBody };
      if (maskedRequestBody.Payment?.CreditCard) {
        const card = maskedRequestBody.Payment.CreditCard;
        maskedRequestBody.Payment.CreditCard = {
          ...card,
          CardNumber: card.CardNumber?.substring(0, 4) + '****' + card.CardNumber?.substring(card.CardNumber.length - 4),
          SecurityCode: requestBody.Payment.CreditCard.SecurityCode,
        };
      }
      this.logger.debug('Request body (masked):', JSON.stringify(maskedRequestBody, null, 2));

      // Para PIX, log completo do request (sem dados sensíveis)
      if (paymentMethod === PaymentMethod.PIX) {
        this.logger.debug('PIX Request body (complete):', JSON.stringify(requestBody, null, 2));
        this.logger.debug('PIX Request body (as sent to Cielo):', {
          url: '/v2/sales',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            MerchantId: this.merchantId,
            MerchantKey: '***masked***',
          },
          body: requestBody,
        });
      }

      let response: any;
      try {
        // Log da URL completa sendo usada
        const fullUrl = `${this.axiosInstance.defaults.baseURL}/v2/sales`;

        // Log dos headers que serão enviados
        this.logger.debug('Making request to Cielo:', {
          method: 'POST',
          url: fullUrl,
          baseURL: this.axiosInstance.defaults.baseURL,
          endpoint: '/v2/sales',
          headers: {
            'Accept': this.axiosInstance.defaults.headers['Accept'],
            'Content-Type': this.axiosInstance.defaults.headers['Content-Type'],
            'MerchantId': this.axiosInstance.defaults.headers['MerchantId'],
            'MerchantKey': this.axiosInstance.defaults.headers['MerchantKey'],
          },
        });

        response = await this.axiosInstance.post<CieloPaymentResponse>(
          '/v2/sales',
          requestBody,
          {
            headers: {
              'MerchantId': this.merchantId,
              'MerchantKey': this.merchantKey,
            },
          },
        );
      } catch (requestError: any) {
        // Log detalhado do erro para debug
        this.logger.error('Error creating Cielo payment:', {
          message: requestError.message,
          status: requestError.response?.status,
          statusText: requestError.response?.statusText,
          data: requestError.response?.data,
          errorDetails: requestError.response?.data,
          paymentMethod,
          amount: amountInCents,
          merchantOrderId,
        });

        // Se o erro for capturado aqui, re-lançar para ser tratado no catch externo
        throw requestError;
      }

      // Log da resposta para debug
      this.logger.debug('Cielo payment response:', {
        status: response.status,
        hasPayment: !!response.data?.Payment,
        paymentStatus: response.data?.Payment?.Status,
        paymentReturnCode: response.data?.Payment?.ReturnCode,
        paymentReturnMessage: response.data?.Payment?.ReturnMessage,
      });

      // Para PIX, log completo da resposta
      if (paymentMethod === PaymentMethod.PIX) {
        this.logger.debug('PIX Response (complete):', JSON.stringify(response.data, null, 2));
        this.logger.debug('PIX Response headers:', response.headers);
      }

      const payment = response.data.Payment;

      // Verificar se há erros na resposta mesmo com status 200
      if (!payment) {
        this.logger.error('No Payment object in Cielo response:', response.data);
        return {
          success: false,
          error: 'Resposta inválida da Cielo: Payment não encontrado',
          errorDetails: response.data,
        };
      }

      // Verificar status do pagamento
      // Status 1 = Autorizado (sucesso)
      // Status 2 = PaymentConfirmed (sucesso para PIX/Boleto)
      // Status 3 = Negado (erro)
      // Status 0 = NotFinished (pode ser erro se houver ReturnCode de erro)
      const returnCode = payment.ReturnCode;
      const returnMessage = payment.ReturnMessage;

      // Códigos de retorno de erro comuns:
      // BP904 = O Json informado não é válido
      // 129 = Affiliation not found (problema de configuração da conta Cielo - PIX não habilitado)
      // Outros códigos começando com BP ou números >= 100 geralmente indicam erro
      // ReturnCode '4' = Operation Successful (sucesso)
      // ReturnCode '5' ou outros = Negado/Erro

      // Verificar se há erro baseado no Status e ReturnCode
      const hasErrorReturnCode = returnCode && (
        returnCode.toString().startsWith('BP') || // Códigos BP são erros
        (typeof returnCode === 'number' && returnCode >= 100) || // Códigos numéricos >= 100 são erros
        returnCode.toString() === '5' // ReturnCode 5 = Negado
      );

      const isError = payment.Status === 3 ||
        (payment.Status === 0 && hasErrorReturnCode); // Status 0 com ReturnCode de erro

      const result: CieloPaymentResult = {
        success: !isError, // Status 1 = sucesso, Status 2 ou 3 = erro
        paymentId: payment.PaymentId,
        paymentIntentId: payment.PaymentId,
        cieloStatus: this.mapCieloStatusToString(payment.Status),
        authorizationCode: payment.AuthorizationCode,
        proofOfSale: payment.ProofOfSale,
        returnCode: payment.ReturnCode?.toString(),
        returnMessage: payment.ReturnMessage,
        cardBrand: payment.CreditCard?.Brand ?? payment.DebitCard?.Brand ?? undefined,
        ...(payment.AuthenticationUrl && { authenticationUrl: payment.AuthenticationUrl }),
      } as any;

      // Se houver erro, adicionar informações de erro com mensagens amigáveis
      if (isError) {
        // Mapear códigos de erro comuns para mensagens mais amigáveis
        let userFriendlyMessage = returnMessage || `Pagamento negado`;

        if (returnCode) {
          const codeStr = returnCode.toString();
          // Mapear códigos de erro conhecidos
          switch (codeStr) {
            case '77':
              userFriendlyMessage = 'Cartão cancelado ou bloqueado. Entre em contato com seu banco ou use outro cartão.';
              break;
            case '51':
              userFriendlyMessage = 'Saldo insuficiente ou limite excedido. Verifique seu limite ou use outro cartão.';
              break;
            case '57':
              userFriendlyMessage = 'Transação não permitida para este cartão. Entre em contato com seu banco.';
              break;
            case '78':
              userFriendlyMessage = 'Cartão bloqueado. Entre em contato com seu banco.';
              break;
            case '82':
              userFriendlyMessage = 'Erro no processamento do cartão. Tente novamente ou use outro cartão.';
              break;
            case '83':
              userFriendlyMessage = 'Erro na validação do cartão. Verifique os dados e tente novamente.';
              break;
            case '96':
              userFriendlyMessage = 'Falha no processamento. Tente novamente em alguns instantes.';
              break;
            case 'AA':
              userFriendlyMessage = 'Timeout na comunicação. Tente novamente.';
              break;
            default:
              // Manter mensagem original se não houver mapeamento específico
              if (returnMessage) {
                userFriendlyMessage = returnMessage;
              }
          }
        }

        result.error = userFriendlyMessage;
        result.errorDetails = {
          status: payment.Status,
          returnCode,
          returnMessage,
          proofOfSale: payment.ProofOfSale,
          authorizationCode: payment.AuthorizationCode,
        };
      } else {
        // Log de sucesso para debug
        this.logger.debug('Payment authorized successfully:', {
          paymentId: payment.PaymentId,
          status: payment.Status,
          returnCode,
          returnMessage,
          proofOfSale: payment.ProofOfSale,
          authorizationCode: payment.AuthorizationCode,
        });
      }

      // Adicionar informações específicas do método de pagamento
      if (paymentMethod === PaymentMethod.PIX) {
        if (payment.QrCodeBase64Image) {
          result.qrCode = payment.QrCodeBase64Image;
        }
        if (payment.QrCodeString) {
          result.pixCode = payment.QrCodeString;
          if (!result.qrCode) {
            result.qrCode = payment.QrCodeString;
          }
        }
        if (payment.ExpirationDate) {
          result.expiresAt = new Date(payment.ExpirationDate);
        }
        // Cielo2: SentOrderId = txid, EndToEndId = identifier after payment
        if (payment.SentOrderId) {
          (result as any).txId = payment.SentOrderId;
        }
        if (payment.EndToEndId) {
          (result as any).endToEndId = payment.EndToEndId;
        }
      }

      if (paymentMethod === PaymentMethod.BOLETO) {
        if (payment.DigitableLine) {
          result.barcode = payment.DigitableLine;
        }
        if (payment.BarCodeNumber) {
          result.barcode = payment.BarCodeNumber;
        }
        if (payment.ExpirationDate) {
          result.expiresAt = new Date(payment.ExpirationDate);
        }
      }

      if (paymentMethod === PaymentMethod.CREDIT_CARD && payment.AuthenticationUrl) {
        result.clientSecret = payment.AuthenticationUrl;
      }

      return result;
    } catch (error: any) {
      const errorData = error.response?.data;

      // A Cielo pode retornar erros em diferentes formatos:
      // 1. Array de objetos com Code e Message: [{Code: 304, Message: "..."}]
      // 2. Objeto com Message: {Message: "..."}
      // 3. Objeto com ValidationErrors: {ValidationErrors: [...]}

      let errorMessage = 'Failed to create payment';
      let errorDetails: any = null;

      if (errorData) {
        // Se for um array (formato mais comum da Cielo)
        if (Array.isArray(errorData)) {
          errorDetails = errorData;
          const firstError = errorData[0];
          if (firstError?.Message) {
            errorMessage = firstError.Message;
            // Melhorar mensagem para erros específicos conhecidos
            if (firstError.Code === 129) {
              const methodHint = paymentMethod === PaymentMethod.PIX
                ? 'Check if PIX is enabled and the Provider is set to "Cielo2" in the Cielo panel.'
                : `Check if ${paymentMethod} is enabled for this affiliation in the Cielo panel.`;
              errorMessage = `Affiliation not found - ${methodHint}`;
            }
          } else if (firstError?.message) {
            errorMessage = firstError.message;
          }
        }
        // Se for um objeto
        else if (typeof errorData === 'object') {
          errorDetails = errorData;
          // Tentar diferentes campos de mensagem
          errorMessage = errorData.Message
            || errorData.message
            || errorData.error
            || errorMessage;

          // Se tiver ValidationErrors, usar eles como detalhes
          if (errorData.ValidationErrors) {
            errorDetails = errorData.ValidationErrors;
          } else if (errorData.errors) {
            errorDetails = errorData.errors;
          }
        }
      } else if (error.message) {
        errorMessage = error.message;
      }

      this.logger.error('Error creating Cielo payment:', {
        message: errorMessage,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: errorData,
        errorDetails,
        paymentMethod,
        amount: amountInCents,
        merchantOrderId,
      });

      // Construir mensagem de erro mais descritiva
      let fullErrorMessage = errorMessage;
      if (errorDetails) {
        try {
          if (Array.isArray(errorDetails)) {
            const messages = errorDetails
              .map((item: any) => item?.Message || item?.message || JSON.stringify(item))
              .filter((msg: string) => msg);
            if (messages.length > 0) {
              fullErrorMessage += ` - ${messages.join(', ')}`;
            }
          } else if (typeof errorDetails === 'object') {
            const detailsStr = JSON.stringify(errorDetails);
            if (detailsStr && detailsStr !== '{}') {
              fullErrorMessage += ` - ${detailsStr}`;
            }
          } else {
            fullErrorMessage += ` - ${String(errorDetails)}`;
          }
        } catch (e) {
          // Se falhar ao formatar, usar mensagem básica
          this.logger.warn('Failed to format error details', e);
        }
      }

      return {
        success: false,
        error: fullErrorMessage,
        errorDetails: errorDetails || errorData,
      };
    }
  }

  /**
   * Obtém o access token do Braspag MPI v2 para inicializar o SDK 3DS no frontend.
   * Endpoint: POST /v2/auth/token (Basic Auth + body com dados do estabelecimento).
   * Token tem validade de ~24h; mantemos em cache e renovamos com 60s de margem.
   */
  async get3dsAccessToken(): Promise<string> {
    if (!this.threeDsClientId || !this.threeDsClientSecret) {
      throw new Error('CIELO_3DS_CLIENT_ID ou CIELO_3DS_CLIENT_SECRET não configurados');
    }
    if (!this.threeDsEstablishmentCode || !this.threeDsMerchantName || !this.threeDsMcc) {
      throw new Error('CIELO_3DS_ESTABLISHMENT_CODE, CIELO_3DS_MERCHANT_NAME ou CIELO_3DS_MCC não configurados');
    }

    const now = Date.now();
    if (this.threeDsTokenCache && now < this.threeDsTokenCache.expiresAt) {
      return this.threeDsTokenCache.token;
    }

    const mpiBaseUrl = this.isSandbox
      ? 'https://mpisandbox.braspag.com.br'
      : 'https://mpi.braspag.com.br';

    const credentials = Buffer.from(
      `${this.threeDsClientId}:${this.threeDsClientSecret}`,
    ).toString('base64');

    const response = await axios.post<{ access_token: string; expires_in: string | number }>(
      `${mpiBaseUrl}/v2/auth/token`,
      {
        EstablishmentCode: this.threeDsEstablishmentCode,
        MerchantName: this.threeDsMerchantName,
        MCC: this.threeDsMcc,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${credentials}`,
        },
        timeout: 10000,
      },
    );

    const { access_token, expires_in } = response.data;
    const expiresInSeconds = typeof expires_in === 'string' ? parseInt(expires_in, 10) : expires_in;
    // Armazena com 60s de margem antes da expiração real
    this.threeDsTokenCache = {
      token: access_token,
      expiresAt: now + (expiresInSeconds - 60) * 1000,
    };

    this.logger.debug(`3DS access token renovado (expira em ${expiresInSeconds}s)`);
    return access_token;
  }

  get sandboxMode(): boolean {
    return this.isSandbox;
  }

  async capturePayment(paymentId: string, amount?: number): Promise<CieloPaymentResult> {
    if (!this.axiosInstance) {
      throw new Error('Cielo is not configured');
    }

    try {
      const url = `/v2/sales/${paymentId}/capture`;
      // amount já está em centavos, mas Cielo espera em centavos também
      const requestBody = amount ? { Amount: amount } : {};

      const response = await this.axiosInstance.put<any>(url, requestBody);

      return {
        success: response.data.Status === 2, // 2 = Captured
        paymentId: response.data.PaymentId,
        cieloStatus: this.mapCieloStatusToString(response.data.Status),
      };
    } catch (error: any) {
      this.logger.error('Error capturing Cielo payment:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.Message || error.message || 'Failed to capture payment',
      };
    }
  }

  /**
   * Cancela ou estorna um pagamento via endpoint `/void` da Cielo.
   *
   * A própria Cielo decide entre void (pré-captura/liquidação) e refund (pós) com base
   * no status atual da transação. Os retornos possíveis são:
   *   - Status 10 (Voided)   — cancelamento concluído na hora (crédito não capturado, débito, etc.)
   *   - Status 11 (Refunded) — estorno concluído (PIX devolvido, crédito liquidado)
   *   - Status 12 (Pending)  — operação aceita mas será confirmada por webhook
   *
   * `amount` em centavos habilita estorno parcial; omitir = estorno total.
   */
  async cancelPayment(paymentId: string, amount?: number): Promise<CieloPaymentResult> {
    if (!this.axiosInstance) {
      throw new Error('Cielo is not configured');
    }

    try {
      const url = `/v2/sales/${paymentId}/void`;
      // amount já está em centavos, mas Cielo espera em centavos também
      const requestBody = amount ? { Amount: amount } : {};

      const response = await this.axiosInstance.put<any>(url, requestBody);
      const status = response.data.Status;
      const isReversed = status === 10 || status === 11; // Voided ou Refunded
      const isPending = status === 12; // Aguardando confirmação assíncrona

      return {
        success: isReversed || isPending,
        paymentId: response.data.PaymentId,
        cieloStatus: this.mapCieloStatusToString(status),
        returnCode: response.data.ReturnCode?.toString(),
        returnMessage: response.data.ReturnMessage,
      };
    } catch (error: any) {
      this.logger.error('Error canceling Cielo payment:', error.response?.data || error.message);
      const errorData = error.response?.data;
      let errorMessage = 'Failed to cancel payment';
      if (Array.isArray(errorData) && errorData[0]?.Message) {
        errorMessage = errorData[0].Message;
      } else if (errorData?.Message) {
        errorMessage = errorData.Message;
      } else if (error.message) {
        errorMessage = error.message;
      }
      return {
        success: false,
        error: errorMessage,
        errorDetails: errorData,
      };
    }
  }

  async getPayment(paymentId: string): Promise<CieloPaymentResponse | null> {
    if (!this.queryAxiosInstance) {
      throw new Error('Cielo is not configured');
    }

    try {
      const response = await this.queryAxiosInstance.get<CieloPaymentResponse>(
        `/v2/sales/${paymentId}`,
      );
      return response.data;
    } catch (error: any) {
      this.logger.error('Error retrieving Cielo payment:', error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Valida assinatura do webhook Cielo e parseia o payload.
   *
   * Segurança:
   * - Comparação em tempo constante via `crypto.timingSafeEqual` para mitigar
   *   timing attack na descoberta do secret.
   * - Verifica comprimento ANTES do timingSafeEqual (Node lança se buffers
   *   tiverem tamanhos diferentes); o pre-check NÃO é timing-sensitive porque
   *   o tamanho do secret é conhecido e não revela seus bytes.
   *
   * Retorna o evento parseado em caso de sucesso; null em qualquer falha
   * (não exibe causa do erro para evitar oracle).
   */
  async handleWebhook(signature: string, payload: string): Promise<any | null> {
    if (!this.webhookSecret) {
      this.logger.warn('Cielo webhook secret not configured');
      return null;
    }

    if (!signature || !payload) {
      this.logger.warn('Webhook signature or payload missing');
      return null;
    }

    try {
      const secretBuf = Buffer.from(this.webhookSecret, 'utf8');
      const sigBuf = Buffer.from(signature, 'utf8');

      const valid =
        sigBuf.length === secretBuf.length &&
        crypto.timingSafeEqual(sigBuf, secretBuf);

      if (!valid) {
        this.logger.warn('Webhook signature verification failed');
        return null;
      }

      const event = JSON.parse(payload);
      return event;
    } catch (error: any) {
      this.logger.error('Error parsing webhook payload:', error?.message ?? 'unknown');
      return null;
    }
  }

  mapCieloStatusToPaymentStatus(cieloStatus: number): PaymentStatus {
    // Status da Cielo/Braspag:
    // 0  = NotFinished
    // 1  = Authorized
    // 2  = PaymentConfirmed
    // 3  = Denied
    // 10 = Voided (cancelado/estornado pelo emissor ou lojista)
    // 11 = Refunded (reembolso)
    // 12 = Pending
    // 13 = Aborted

    switch (cieloStatus) {
      case 2: // PaymentConfirmed
        return PaymentStatus.PAID;
      case 1: // Authorized
      case 0: // NotFinished
      case 12: // Pending
        return PaymentStatus.PENDING;
      case 3: // Denied
      case 13: // Aborted
        return PaymentStatus.FAILED;
      case 10: // Voided (cancelado/estornado)
      case 11: // Refunded
        return PaymentStatus.REFUNDED;
      default:
        return PaymentStatus.PENDING;
    }
  }

  mapCieloStatusToString(cieloStatus: number): string {
    const statusMap: Record<number, string> = {
      0: 'NotFinished',
      1: 'Authorized',
      2: 'PaymentConfirmed',
      3: 'Denied',
      10: 'Voided',
      11: 'Refunded',
      12: 'Pending',
      13: 'Aborted',
    };

    return statusMap[cieloStatus] || 'Unknown';
  }

  /**
   * Detecta a bandeira do cartão baseado no número
   * Retorna o código da bandeira conforme esperado pela Cielo
   */
  private detectCardBrand(cardNumber: string): string | null {
    const number = cardNumber.replace(/\D/g, ''); // Remove caracteres não numéricos

    // Visa: começa com 4
    if (/^4/.test(number)) {
      return 'Visa';
    }

    // Mastercard: começa com 5[1-5] ou 2[2-7]
    if (/^5[1-5]/.test(number) || /^2[2-7]/.test(number)) {
      return 'Master';
    }

    // Amex: começa com 34 ou 37
    if (/^3[47]/.test(number)) {
      return 'Amex';
    }

    // Elo: começa com vários padrões
    if (/^4011|^431274|^438935|^451416|^457393|^457631|^457632|^504175|^627780|^636297|^636368|^636369/.test(number)) {
      return 'Elo';
    }

    // Discover: começa com 6011 ou 65
    if (/^6011/.test(number) || /^65/.test(number)) {
      return 'Discover';
    }

    // JCB: começa com 35
    if (/^35/.test(number)) {
      return 'JCB';
    }

    // Diners: começa com 30, 36 ou 38
    if (/^3[068]/.test(number)) {
      return 'Diners';
    }

    return null;
  }
}

