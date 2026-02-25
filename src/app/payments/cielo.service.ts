import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { PaymentMethod, PaymentStatus } from '@prisma/client';

export interface CieloPaymentResult {
  success: boolean;
  paymentId?: string;
  paymentIntentId?: string;
  clientSecret?: string;
  qrCode?: string;
  pixCode?: string;
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
    ProofOfSale?: string;
    AuthorizationCode?: string;
    AuthenticationUrl?: string;
    QrCodeBase64Image?: string;
    QrCodeString?: string;
    DigitableLine?: string;
    BarCodeNumber?: string;
    ExpirationDate?: string;
    Instructions?: string;
    Assignor?: string;
    Address?: string;
    Identification?: string;
  };
}

@Injectable()
export class CieloService {
  private readonly axiosInstance: AxiosInstance;
  private readonly logger = new Logger(CieloService.name);
  private readonly merchantId: string;
  private readonly merchantKey: string;
  private readonly isSandbox: boolean;
  private readonly webhookSecret: string;

  constructor(private configService: ConfigService) {
    this.merchantId = this.configService.get<string>('CIELO_MERCHANT_ID') || '';
    this.merchantKey = this.configService.get<string>('CIELO_MERCHANT_KEY') || '';
    this.isSandbox = this.configService.get<string>('CIELO_ENV') !== 'production';
    this.webhookSecret = this.configService.get<string>('CIELO_WEBHOOK_SECRET') || '';

    const baseURL = this.isSandbox
      ? 'https://apisandbox.cieloecommerce.cielo.com.br'
      : 'https://api.cieloecommerce.cielo.com.br';

    if (!this.merchantId || !this.merchantKey) {
      this.logger.warn('CIELO_MERCHANT_ID or CIELO_MERCHANT_KEY not configured. Cielo service will be disabled.');
      this.axiosInstance = null as any;
      return;
    }

    // Verificar se as credenciais estão configuradas
    if (!this.merchantId || !this.merchantKey) {
      this.logger.warn('CIELO_MERCHANT_ID or CIELO_MERCHANT_KEY not configured. Cielo service will be disabled.');
      this.axiosInstance = null as any;
      return;
    }

    this.logger.debug('Cielo credentials loaded:', {
      merchantId: this.merchantId,
      merchantKeyLength: this.merchantKey?.length || 0,
      hasMerchantId: !!this.merchantId,
      hasMerchantKey: !!this.merchantKey,
    });

    this.axiosInstance = axios.create({
      baseURL,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'MerchantId': this.merchantId,
        'MerchantKey': this.merchantKey,
      },
      timeout: 30000,
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
  ): Promise<CieloPaymentResult> {
    if (!this.axiosInstance) {
      throw new Error('Cielo is not configured');
    }

    // Normalizar para centavos: se o valor é menor que 1000, assume que está em reais e converte
    // Caso contrário, assume que já está em centavos
    const amountInCents = amount < 1000 ? Math.round(amount * 100) : Math.round(amount);

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
          if (!cardData) {
            throw new Error('Card data is required for credit card payments');
          }

          // Detectar bandeira do cartão baseado no número
          const cardBrand = this.detectCardBrand(cardData.number);
          if (!cardBrand) {
            this.logger.error('Unable to detect card brand', {
              cardNumber: cardData.number?.replace(/\d(?=\d{4})/g, '*'), // Mascarar número para log
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

          const cardNumber = cardData.number.replace(/\D/g, ''); // Remover espaços e caracteres não numéricos

          // Validar e limpar CVV (deve conter apenas números)
          if (!cardData.cvv) {
            throw new Error('CVV é obrigatório');
          }

          // Converter para string, remover caracteres não numéricos e validar
          const securityCodeStr = String(cardData.cvv).replace(/\D/g, '');
          if (!securityCodeStr || securityCodeStr.length < 3 || securityCodeStr.length > 4) {
            throw new Error(`CVV inválido. Deve conter 3 ou 4 dígitos numéricos. Recebido: ${cardData.cvv} (limpo: ${securityCodeStr})`);
          }

          // Converter para número inteiro (Cielo pode esperar tipo Number, não string)
          const securityCode = parseInt(securityCodeStr, 10);
          if (isNaN(securityCode)) {
            throw new Error(`CVV inválido. Não foi possível converter para número: ${securityCodeStr}`);
          }

          this.logger.debug('CVV validation:', {
            original: cardData.cvv,
            cleaned: securityCodeStr,
            asNumber: securityCode,
            length: securityCodeStr.length,
            type: typeof securityCode,
          });

          paymentData.Type = 'CreditCard';
          // Campos específicos de cartão de crédito
          paymentData.Installments = cardData.installments || 1;
          paymentData.Capture = false;
          paymentData.CreditCard = {
            CardNumber: cardNumber,
            Holder: cardData.holder,
            ExpirationDate: expiryDate,
            SecurityCode: securityCode, // Número inteiro (Cielo espera tipo Number)
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
                SecurityCode: securityCode,
                Brand: cardBrand,
              },
            }),
          });
          break;

        case PaymentMethod.PIX:
          paymentData.Type = 'Pix';
          // Provider é obrigatório para PIX - deve ser "Cielo2"
          paymentData.Provider = 'Cielo2';
          // Amount deve ser número (não string) - a resposta da Cielo sempre retorna como número
          paymentData.Amount = amountInCents;
          // QrCode.Expiration é opcional - se não informado, padrão é 86400 segundos (24 horas)
          // Vamos definir 1 hora (3600 segundos) para expiração
          paymentData.QrCode = {
            Expiration: 3600, // 1 hora em segundos
          };
          this.logger.debug('PIX payment data:', {
            type: paymentData.Type,
            provider: paymentData.Provider,
            amount: paymentData.Amount,
            amountType: typeof paymentData.Amount,
            qrCodeExpiration: paymentData.QrCode.Expiration,
            originalAmountInCents: amountInCents,
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

      // Adicionar Customer se fornecido
      // IMPORTANTE: Para PIX, a Cielo requer Customer com Identity (CPF)
      // Estrutura conforme documentação: apenas Name, Identity e IdentityType (SEM Email)
      if (customerData && customerData.identity) {
        requestBody.Customer = {
          // Limpar espaços no início e fim do nome
          ...(customerData.name && { Name: customerData.name.trim() }),
          Identity: customerData.identity,
          IdentityType: customerData.identityType || 'CPF',
          // Email NÃO deve ser incluído para PIX (conforme exemplo da documentação)
          // Apenas incluir Email para outros métodos de pagamento
          ...(customerData.email && paymentMethod !== PaymentMethod.PIX && { Email: customerData.email.trim() }),
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
          url: '/1/sales',
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
        const fullUrl = `${this.axiosInstance.defaults.baseURL}/1/sales`;
        
        // Log dos headers que serão enviados
        this.logger.debug('Making request to Cielo:', {
          method: 'POST',
          url: fullUrl,
          baseURL: this.axiosInstance.defaults.baseURL,
          endpoint: '/1/sales',
          headers: {
            'Accept': this.axiosInstance.defaults.headers['Accept'],
            'Content-Type': this.axiosInstance.defaults.headers['Content-Type'],
            'MerchantId': this.axiosInstance.defaults.headers['MerchantId'],
            'MerchantKey': this.axiosInstance.defaults.headers['MerchantKey'] ? '***present***' : '***missing***',
          },
        });
        
        // Enviar headers explicitamente para garantir que sejam enviados corretamente
        // O axios pode normalizar headers customizados, então vamos garantir que MerchantId e MerchantKey sejam enviados
        response = await this.axiosInstance.post<CieloPaymentResponse>(
          '/1/sales',
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
      
      const isError = payment.Status === 2 || payment.Status === 3 || 
        (payment.Status === 0 && hasErrorReturnCode); // Status 0 com ReturnCode de erro

      const result: CieloPaymentResult = {
        success: !isError, // Status 1 = sucesso, Status 2 ou 3 = erro
        paymentId: payment.PaymentId,
        paymentIntentId: payment.PaymentId,
        cieloStatus: this.mapCieloStatusToString(payment.Status),
        // Adicionar informações adicionais para extrato
        authorizationCode: payment.AuthorizationCode,
        proofOfSale: payment.ProofOfSale,
        returnCode: payment.ReturnCode?.toString(),
        returnMessage: payment.ReturnMessage,
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
        // Priorizar QrCodeBase64Image para exibição (imagem), mas também salvar QrCodeString (código)
        // Conforme documentação Cielo: https://docs.cielo.com.br/ecommerce-cielo/reference/qrcode-pix
        if (payment.QrCodeBase64Image) {
          result.qrCode = payment.QrCodeBase64Image; // Imagem base64 para exibição
        }
        if (payment.QrCodeString) {
          result.pixCode = payment.QrCodeString; // Código PIX string para copiar/colar
          // Se não tiver imagem, usar o código string como fallback
          if (!result.qrCode) {
            result.qrCode = payment.QrCodeString;
          }
        }
        if (payment.ExpirationDate) {
          result.expiresAt = new Date(payment.ExpirationDate);
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
              errorMessage = 'Affiliation not found - A conta Cielo não está habilitada para PIX. Verifique se a afiliação está configurada para usar o Provider "Cielo2" no painel da Cielo.';
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

  async capturePayment(paymentId: string, amount?: number): Promise<CieloPaymentResult> {
    if (!this.axiosInstance) {
      throw new Error('Cielo is not configured');
    }

    try {
      const url = `/1/sales/${paymentId}/capture`;
      const requestBody = amount ? { Amount: Math.round(amount * 100) } : {};

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

  async cancelPayment(paymentId: string, amount?: number): Promise<CieloPaymentResult> {
    if (!this.axiosInstance) {
      throw new Error('Cielo is not configured');
    }

    try {
      const url = `/1/sales/${paymentId}/void`;
      const requestBody = amount ? { Amount: Math.round(amount * 100) } : {};

      const response = await this.axiosInstance.put<any>(url, requestBody);

      return {
        success: response.data.Status === 11 || response.data.Status === 12, // 11 = Voided, 12 = Pending Void
        paymentId: response.data.PaymentId,
        cieloStatus: this.mapCieloStatusToString(response.data.Status),
      };
    } catch (error: any) {
      this.logger.error('Error canceling Cielo payment:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.Message || error.message || 'Failed to cancel payment',
      };
    }
  }

  async getPayment(paymentId: string): Promise<CieloPaymentResponse | null> {
    if (!this.axiosInstance) {
      throw new Error('Cielo is not configured');
    }

    try {
      const response = await this.axiosInstance.get<CieloPaymentResponse>(
        `/1/sales/${paymentId}`,
      );
      return response.data;
    } catch (error: any) {
      this.logger.error('Error retrieving Cielo payment:', error.response?.data || error.message);
      return null;
    }
  }

  async handleWebhook(signature: string, payload: string): Promise<any | null> {
    if (!this.webhookSecret) {
      this.logger.warn('Cielo webhook secret not configured');
      return null;
    }

    try {
      // A Cielo usa autenticação básica ou token específico para webhooks
      // A validação do webhook pode ser feita comparando o signature com o secret
      // Por enquanto, vamos apenas validar que o signature existe
      if (signature !== this.webhookSecret) {
        this.logger.warn('Webhook signature verification failed');
        return null;
      }

      const event = JSON.parse(payload);
      return event;
    } catch (error: any) {
      this.logger.error('Error parsing webhook payload:', error);
      return null;
    }
  }

  mapCieloStatusToPaymentStatus(cieloStatus: number): PaymentStatus {
    // Status da Cielo:
    // 0 = NotFinished
    // 1 = Authorized
    // 2 = PaymentConfirmed
    // 3 = Denied
    // 10 = Voided
    // 11 = Refunded
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

