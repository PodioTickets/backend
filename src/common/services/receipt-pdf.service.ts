import React from 'react';
import { Injectable } from '@nestjs/common';
import { renderToBuffer } from '@react-pdf/renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import * as CardIcons from 'react-svg-credit-card-payment-icons';
import * as sharpLib from 'sharp';
import { ReceiptPdfDocument } from './receipt-pdf.template';
import { ReceiptPdfData, ReceiptPdfRegistrationRow } from './receipt-pdf.types';

export type { ReceiptPdfData, ReceiptPdfRegistrationRow };

const sharp = (sharpLib as any).default ?? sharpLib;

const BRAND_ICON_MAP: Record<string, any> = {
  visa: (CardIcons as any).VisaFlatRoundedIcon,
  master: (CardIcons as any).MastercardFlatRoundedIcon,
  mastercard: (CardIcons as any).MastercardFlatRoundedIcon,
  amex: (CardIcons as any).AmericanExpressFlatRoundedIcon,
  americanexpress: (CardIcons as any).AmericanExpressFlatRoundedIcon,
  elo: (CardIcons as any).EloFlatRoundedIcon,
  hipercard: (CardIcons as any).HipercardFlatRoundedIcon,
  hiper: (CardIcons as any).HiperFlatRoundedIcon,
  diners: (CardIcons as any).DinersClubFlatRoundedIcon,
  discover: (CardIcons as any).DiscoverFlatRoundedIcon,
  jcb: (CardIcons as any).JCBFlatRoundedIcon,
  maestro: (CardIcons as any).MaestroFlatRoundedIcon,
  unionpay: (CardIcons as any).UnionPayFlatRoundedIcon,
};

async function buildCardIconDataUri(method: string, cardBrand?: string): Promise<string | undefined> {
  const isPix = method?.toLowerCase().includes('pix');
  const isFree = method?.toUpperCase() === 'FREE';
  if (isPix || isFree) return undefined;

  const brandKey = (cardBrand ?? '').toLowerCase().replace(/[\s-]/g, '');
  const IconComponent = BRAND_ICON_MAP[brandKey] ?? (CardIcons as any).GenericFlatRoundedIcon;
  if (!IconComponent) return undefined;

  const svgString = renderToStaticMarkup(React.createElement(IconComponent, {}));
  const svgWithSize = svgString.replace('<svg ', '<svg width="60" height="40" ');
  const pngBuffer = await sharp(Buffer.from(svgWithSize)).resize(60, 40).png().toBuffer();
  return `data:image/png;base64,${pngBuffer.toString('base64')}`;
}

@Injectable()
export class ReceiptPdfService {
  async generateReceiptPdf(data: ReceiptPdfData): Promise<Buffer> {
    const iconDataUri = await buildCardIconDataUri(
      data.payment.method,
      data.payment.cardBrand,
    ).catch(() => undefined);

    const enriched: ReceiptPdfData = {
      ...data,
      payment: { ...data.payment, iconDataUri },
    };

    const buffer = await renderToBuffer(
      React.createElement(ReceiptPdfDocument, { data: enriched }) as any,
    );
    return Buffer.from(buffer);
  }
}
