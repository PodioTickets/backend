import React from 'react';
import { Injectable } from '@nestjs/common';
import { renderToBuffer } from '@react-pdf/renderer';
import { ReceiptPdfDocument } from './receipt-pdf.template';
import { ReceiptPdfData, ReceiptPdfRegistrationRow } from './receipt-pdf.types';

export type { ReceiptPdfData, ReceiptPdfRegistrationRow };

@Injectable()
export class ReceiptPdfService {
  async generateReceiptPdf(data: ReceiptPdfData): Promise<Buffer> {
    const buffer = await renderToBuffer(
      React.createElement(ReceiptPdfDocument, { data }) as any,
    );
    return Buffer.from(buffer);
  }
}
