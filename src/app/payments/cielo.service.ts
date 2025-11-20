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
  cieloStatus?: string;
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

    this.axiosInstance = axios.create({
      baseURL,
      headers: {
        'Content-Type': 'application/json',
        MerchantId: this.merchantId,
        MerchantKey: this.merchantKey,
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
  ): Promise<CieloPaymentResult> {
    if (!this.axiosInstance) {
      throw new Error('Cielo is not configured');
    }

    try {
      const amountInCents = Math.round(amount * 100);

      let paymentData: any = {
        Type: '',
        Amount: amountInCents,
        Currency: currency,
        Installments: 1,
        Capture: false,
      };

      switch (paymentMethod) {
        case PaymentMethod.CREDIT_CARD:
          // Para cartão de crédito, será necessário criar um PaymentIntent separado
          // com os dados do cartão fornecido pelo cliente
          paymentData.Type = 'CreditCard';
          paymentData.CreditCard = {
            CardNumber: '', // Será preenchido pelo cliente
            Holder: customerData?.name || '',
            ExpirationDate: '', // Será preenchido pelo cliente
            SecurityCode: '', // Será preenchido pelo cliente
            Brand: '', // Será determinado automaticamente ou pelo cliente
          };
          break;

        case PaymentMethod.PIX:
          paymentData.Type = 'Pix';
          paymentData.Pix = {
            ExpiresDate: new Date(Date.now() + 3600000).toISOString(), // 1 hora
          };
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

      const requestBody = {
        MerchantOrderId: merchantOrderId,
        Customer: customerData
          ? {
              Name: customerData.name,
              Email: customerData.email,
              Identity: customerData.identity,
              IdentityType: customerData.identityType || 'CPF',
            }
          : undefined,
        Payment: paymentData,
      };

      const response = await this.axiosInstance.post<CieloPaymentResponse>(
        '/1/sales',
        requestBody,
      );

      const payment = response.data.Payment;
      const result: CieloPaymentResult = {
        success: payment.Status !== 2 && payment.Status !== 3, // 2 = Cancelled, 3 = Denied
        paymentId: payment.PaymentId,
        paymentIntentId: payment.PaymentId,
        cieloStatus: this.mapCieloStatusToString(payment.Status),
      };

      // Adicionar informações específicas do método de pagamento
      if (paymentMethod === PaymentMethod.PIX) {
        if (payment.QrCodeString) {
          result.qrCode = payment.QrCodeString;
          result.pixCode = payment.QrCodeString;
        }
        if (payment.QrCodeBase64Image) {
          result.qrCode = payment.QrCodeBase64Image;
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
      this.logger.error('Error creating Cielo payment:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.Message || error.message || 'Failed to create payment',
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
}

