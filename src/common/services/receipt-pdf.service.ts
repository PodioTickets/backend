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

/**
 * Busca uma imagem remota e a re-encoda como data-URI PNG para o template do PDF.
 *
 * Por quê: o `@react-pdf/renderer` só decodifica PNG/JPEG — NÃO suporta WebP, e o
 * upload do projeto converte TODA imagem enviada para WebP (avatar do usuário, logo
 * da organização). Passar a URL crua ao `<Image>` faz a imagem simplesmente não
 * renderizar. Re-encodando via `sharp` para PNG, o renderer passa a exibir.
 *
 * Segurança: aceita SOMENTE `https://` (o fetch nativo acessaria `file:///`,
 * `http://localhost`, etc. — vetor de SSRF). Performance: timeout curto para não
 * travar a geração do PDF. Fail-open: qualquer erro → `undefined` (o template cai
 * no fallback da inicial), nunca quebra o documento.
 */
async function buildImageDataUri(url?: string | null): Promise<string | undefined> {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!/^https:\/\//i.test(trimmed)) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(trimmed, { signal: controller.signal });
    if (!res.ok) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    // Quadrado 144px (2× do exibido a 36px → nitidez); `cover` casa com o
    // borderRadius/objectFit:'cover' do template.
    const png = await sharp(buf).resize(144, 144, { fit: 'cover' }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } finally {
    clearTimeout(timeout);
  }
}

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
    // Pré-processa em paralelo: ícone do cartão + avatar do comprador + logo da org.
    // Avatar/logo são re-encodados de WebP→PNG (o renderer não decodifica WebP).
    const [iconDataUri, buyerImage, orgLogo] = await Promise.all([
      buildCardIconDataUri(data.payment.method, data.payment.cardBrand).catch(() => undefined),
      buildImageDataUri(data.buyer.imageUrl).catch(() => undefined),
      buildImageDataUri(data.organization.logoUrl).catch(() => undefined),
    ]);

    const enriched: ReceiptPdfData = {
      ...data,
      organization: { ...data.organization, logoUrl: orgLogo },
      buyer: { ...data.buyer, imageUrl: buyerImage },
      payment: { ...data.payment, iconDataUri },
    };

    const buffer = await renderToBuffer(
      React.createElement(ReceiptPdfDocument, { data: enriched }) as any,
    );
    return Buffer.from(buffer);
  }
}
