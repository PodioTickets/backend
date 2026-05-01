import React from 'react';
import { Injectable } from '@nestjs/common';
import { renderToBuffer } from '@react-pdf/renderer';
import * as QRCode from 'qrcode';
import { TicketPdfDocument } from './ticket-pdf.template';
import {
  TicketPdfData,
  TicketPdfProduct,
  TicketPdfRegistration,
  TicketPdfTemplateData,
} from './ticket-pdf.types';

export type { TicketPdfData, TicketPdfProduct, TicketPdfRegistration };

@Injectable()
export class TicketPdfService {
  async generateTicketPdf(data: TicketPdfData): Promise<Buffer> {
    const registrationsWithQr = await Promise.all(
      data.registrations.map(async (reg) => {
        const qrDataUrl = await QRCode.toDataURL(reg.qrCode || reg.participantName, {
          width: 160,
          margin: 1,
          color: { dark: '#000000', light: '#ffffff' },
        });
        return { ...reg, qrDataUrl };
      }),
    );

    const templateData: TicketPdfTemplateData = {
      ...data,
      registrations: registrationsWithQr,
    };

    const buffer = await renderToBuffer(
      React.createElement(TicketPdfDocument, { data: templateData }) as any,
    );

    return Buffer.from(buffer);
  }
}
