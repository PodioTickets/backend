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
import { buildPdfImageDataUri } from '../utils/pdf-image.util';

export type { TicketPdfData, TicketPdfProduct, TicketPdfRegistration };

@Injectable()
export class TicketPdfService {
  async generateTicketPdf(data: TicketPdfData): Promise<Buffer> {
    const registrationsWithQr = await Promise.all(
      data.registrations.map(async (reg) => {
        // QR (data-URL) + imagens dos produtos re-encodadas de WebP→PNG (o renderer
        // não decodifica WebP, que é o formato em que o upload salva as imagens).
        const [qrDataUrl, products] = await Promise.all([
          QRCode.toDataURL(reg.qrCode || reg.participantName, {
            width: 160,
            margin: 1,
            errorCorrectionLevel: 'L',
            color: { dark: '#1a1a1a', light: '#ffffff' },
          }),
          Promise.all(
            reg.products.map(async (p) => ({
              ...p,
              imageUrl: await buildPdfImageDataUri(p.imageUrl, 200).catch(() => undefined),
            })),
          ),
        ]);
        return { ...reg, products, qrDataUrl };
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
