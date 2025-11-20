import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly apiToken: string;

  constructor(private configService: ConfigService) {
    this.apiUrl = this.configService.get<string>('WHATSAPP_API_URL') || '';
    this.apiKey = this.configService.get<string>('WHATSAPP_API_KEY') || '';
    this.apiToken = this.configService.get<string>('WHATSAPP_API_TOKEN') || '';
  }

  async sendContactMessageToOrganizer(data: {
    organizerPhone: string;
    organizerName: string;
    userName: string;
    userEmail: string;
    userPhone?: string;
    eventName?: string;
    message: string;
  }) {
    if (!this.apiUrl || !this.apiKey || !this.apiToken) {
      this.logger.warn('WhatsApp API configuration incomplete. Skipping WhatsApp send.');
      return;
    }

    const message = `*Nova mensagem de contato - PodioGo*\n\n` +
      `Você recebeu uma nova mensagem através da plataforma PodioGo:\n\n` +
      `*De:* ${data.userName}\n` +
      `*Email:* ${data.userEmail}\n` +
      (data.userPhone ? `*Telefone:* ${data.userPhone}\n` : '') +
      (data.eventName ? `*Evento:* ${data.eventName}\n` : '') +
      `\n*Mensagem:*\n${data.message}\n\n` +
      `_Responda ao email: ${data.userEmail}_`;

    try {
      await axios.post(
        `${this.apiUrl}/messages`,
        {
          to: data.organizerPhone,
          message: message,
          type: 'text',
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiToken}`,
            'X-API-Key': this.apiKey,
            'Content-Type': 'application/json',
          },
        }
      );

      this.logger.log(`WhatsApp message sent to organizer: ${data.organizerPhone}`);
    } catch (error) {
      this.logger.error('Failed to send WhatsApp message:', error);
      // Não lançar erro para não quebrar o fluxo principal
    }
  }
}

