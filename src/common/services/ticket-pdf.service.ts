import React from 'react';
import { Injectable, Logger } from '@nestjs/common';
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

async function fetchImageAsDataUrl(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return undefined;
    const buf = await res.arrayBuffer();
    const ct = res.headers.get('content-type') ?? 'image/jpeg';
    const base64 = Buffer.from(buf).toString('base64');
    return `data:${ct.split(';')[0]};base64,${base64}`;
  } catch {
    return undefined;
  }
}

@Injectable()
export class TicketPdfService {
  private readonly logger = new Logger(TicketPdfService.name);

  async generateTicketPdf(data: TicketPdfData): Promise<Buffer> {
    // Pre-fetch product images as base64 so @react-pdf/renderer never makes
    // remote requests during render (avoids silent drop on fetch failure)
    const registrationsWithQr = await Promise.all(
      data.registrations.map(async (reg) => {
        const qrDataUrl = await QRCode.toDataURL(reg.qrCode || reg.participantName, {
          width: 160,
          margin: 1,
          errorCorrectionLevel: 'L',
          color: { dark: '#1a1a1a', light: '#ffffff' },
        });

        const products = await Promise.all(
          reg.products.map(async (p) => {
            if (!p.imageUrl) return p;
            const dataUrl = await fetchImageAsDataUrl(p.imageUrl).catch(() => undefined);
            if (!dataUrl) {
              this.logger.warn(`Produto imagem indisponível: ${p.imageUrl}`);
            }
            return { ...p, imageUrl: dataUrl };
          }),
        );

        return { ...reg, qrDataUrl, products };
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
