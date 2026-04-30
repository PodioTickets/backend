import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp: (input: Buffer) => import('sharp').Sharp = require('sharp');

// ── SVG assets (same logo as ticket PDF) ─────────────────────────────────────

const VECTOR_SVG = `<svg width="29" height="28" viewBox="0 0 29 28" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M28.023 12.4933C27.1431 11.4496 25.8464 10.8458 24.482 10.8458H18.8104C18.1477 10.8458 17.5122 11.1017 17.0364 11.5617L0 28L6.70384 11.0729C6.96406 10.4145 7.60094 9.98316 8.30828 9.98316H15.1156C15.8833 9.98316 16.4656 9.35346 16.4656 8.63463C16.4656 8.5038 16.4469 7.07476 16.4067 6.94249C16.2327 6.37462 15.7079 5.98788 15.1156 5.98788H7.60813C7.06757 5.98788 6.55864 5.73485 6.23229 5.30499L1.22921 0H17.1571C17.1974 0 17.2376 0.00143767 17.2779 0.004313C17.2836 0.004313 17.2908 0.004313 17.298 0.00575067C17.9981 0.0632573 18.5991 0.539125 18.8076 1.21914L19.2432 2.64243C19.4114 3.18875 19.9146 3.56254 20.4868 3.56254H25.6854C26.4444 3.56254 27.1144 4.0571 27.3358 4.78312L28.6009 8.91497C28.9733 10.1327 28.7605 11.4539 28.023 12.4933Z" fill="url(#paint0_linear)"/><defs><linearGradient id="paint0_linear" x1="22.5514" y1="-1.14754" x2="0.808587" y2="28.4166" gradientUnits="userSpaceOnUse"><stop stop-color="#57D321"/><stop offset="0.523222" stop-color="#1CB757"/><stop offset="1" stop-color="#18773D"/></linearGradient></defs></svg>`;

const PODIO_SVG = `<svg width="60" height="19" viewBox="0 0 60 19" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19.7389 5.00534C21.0148 5.00535 22.1414 5.29011 23.1078 5.8702C24.0692 6.44729 24.8164 7.24686 25.3468 8.26266C25.8783 9.273 26.1397 10.4298 26.1397 11.725C26.1397 13.0281 25.8745 14.1927 25.3352 15.2107L25.3351 15.2105C24.8044 16.2189 24.0573 17.0143 23.0965 17.5911L23.0949 17.592C22.129 18.1638 21.0069 18.4446 19.7389 18.4446C18.4701 18.4446 17.3473 18.1597 16.3811 17.5798C15.4201 17.0029 14.6728 16.2073 14.1421 15.1986L14.1415 15.1973L14.1408 15.1962C13.6178 14.1792 13.3605 13.0196 13.3605 11.725C13.3605 10.4076 13.6256 9.23867 14.1656 8.22726C14.7039 7.21913 15.4551 6.42731 16.4167 5.85801C17.3817 5.28666 18.4924 5.00534 19.7389 5.00534ZM39.2123 18.4576H36.2063V17.5318C35.3186 18.1512 34.2557 18.4446 33.0151 18.4446C31.8382 18.4446 30.7977 18.149 29.9052 17.549C29.0201 16.954 28.3367 16.1455 27.8548 15.1315C27.3729 14.1175 27.1351 12.9801 27.1351 11.725C27.1351 10.4555 27.3726 9.31384 27.8551 8.30648L27.8555 8.30561C28.3458 7.29072 29.0417 6.48574 29.9427 5.89864C30.8502 5.29985 31.9123 5.00534 33.1171 5.00534C34.1687 5.00534 35.0891 5.22715 35.8664 5.68202V0H39.2123V18.4576ZM53.3875 5.00534C54.6634 5.00534 55.7899 5.29011 56.7564 5.8702C57.7178 6.4473 58.4651 7.24684 58.9955 8.26266L59.0445 8.35784C59.5431 9.34546 59.7885 10.4703 59.7885 11.725C59.7885 13.0281 59.5231 14.1927 58.9838 15.2107L58.9836 15.2105C58.453 16.2189 57.7059 17.0143 56.745 17.5911L56.7436 17.592C55.7777 18.1638 54.6555 18.4446 53.3875 18.4446C52.1187 18.4446 50.996 18.1597 50.0299 17.5798C49.0688 17.0029 48.3213 16.2073 47.7907 15.1986L47.7901 15.1973L47.7895 15.1962C47.2666 14.1792 47.0091 13.0196 47.0091 11.725C47.0091 10.4076 47.2743 9.23868 47.8143 8.22726C48.3526 7.21913 49.1038 6.42731 50.0654 5.85801C51.0304 5.28668 52.141 5.00534 53.3875 5.00534ZM7.03517 0C7.20085 0 7.40944 0.00764142 7.65919 0.0226334C7.91622 0.0305294 8.15725 0.0540047 8.38166 0.0934353C9.36399 0.241995 10.1925 0.569408 10.8524 1.08771C11.5127 1.60048 12.0011 2.25094 12.315 3.03403L12.3728 3.17912C12.6528 3.90979 12.7905 5.99888 12.7906 6.86868C12.7906 7.78936 12.6337 8.63956 12.3154 9.41537L12.315 9.41638C11.9936 10.1918 11.5017 10.8377 10.8424 11.3501C10.1827 11.8687 9.35808 12.1967 8.38224 12.3455L8.3792 12.346C8.1584 12.3773 7.9162 12.4005 7.65311 12.4159C7.40137 12.4311 7.19467 12.4391 7.03517 12.4391H3.32309V18.4446H0V0H7.03517ZM45.1167 18.4446H41.7936V4.78252H45.1167V18.4446ZM33.5248 8.03343C32.8421 8.03343 32.3053 8.20072 31.8921 8.51395C31.4646 8.8314 31.1464 9.26313 30.9379 9.82306L30.9375 9.82422C30.7253 10.3871 30.6168 11.0195 30.6168 11.725C30.6168 12.4376 30.7214 13.0776 30.9262 13.6482L30.9665 13.7508C31.1746 14.2563 31.4732 14.6521 31.8594 14.9482C32.2574 15.2533 32.7748 15.4166 33.4341 15.4166C34.1231 15.4166 34.6439 15.2613 35.0239 14.9793C35.4226 14.6815 35.718 14.2649 35.9049 13.714L35.906 13.7108C36.0916 13.1833 36.193 12.57 36.205 11.8669L36.2063 11.725L36.205 11.5818C36.193 10.8722 36.0914 10.2598 35.9063 9.74022C35.7171 9.18246 35.4279 8.76983 35.0447 8.48058C34.6682 8.18999 34.1708 8.03343 33.5248 8.03343ZM19.7389 8.14616C19.051 8.14616 18.5104 8.30101 18.0962 8.58882C17.6815 8.87502 17.3692 9.27908 17.1619 9.81537L17.1615 9.81653C16.9512 10.3534 16.8422 10.9875 16.8422 11.725C16.8422 12.8604 17.1001 13.7332 17.5854 14.3728C18.0619 14.9838 18.7631 15.304 19.7389 15.304C20.7545 15.304 21.4628 14.9716 21.923 14.3436C22.4049 13.686 22.6582 12.8211 22.6582 11.725C22.6582 10.5891 22.4001 9.72061 21.9156 9.08907C21.4466 8.47157 20.7399 8.14617 19.7389 8.14616ZM53.3875 8.14616C52.6996 8.14616 52.1591 8.30102 51.7449 8.58882C51.3301 8.87502 51.0179 9.27908 50.8106 9.81537L50.81 9.81653C50.5998 10.3534 50.4908 10.9875 50.4908 11.725C50.4908 12.8603 50.7486 13.7331 51.2338 14.3727C51.7104 14.9838 52.4116 15.304 53.3875 15.304C54.4031 15.304 55.1113 14.9716 55.5715 14.3436C56.0535 13.686 56.3068 12.8211 56.3068 11.725C56.3068 10.589 56.0487 9.72061 55.5641 9.08907C55.0952 8.47156 54.3885 8.14616 53.3875 8.14616ZM3.32309 9.3096H6.92194C7.06339 9.3096 7.22519 9.30253 7.40793 9.28798C7.58 9.27429 7.73411 9.24719 7.87131 9.20819C8.28892 9.10422 8.58716 8.93066 8.79632 8.69807C9.03325 8.44191 9.19465 8.15911 9.28696 7.84424C9.39358 7.50431 9.44485 7.1813 9.44485 6.86868C9.44484 6.55606 9.39358 4.94596 9.28855 4.61155C9.19387 4.28194 9.03226 3.99598 8.79908 3.74408C8.58716 3.5083 8.28891 3.33488 7.88088 3.23338C7.73836 3.19312 7.58829 3.16972 7.41968 3.16301C7.22519 3.14774 7.06339 3.14082 6.92194 3.14082H3.32309V9.3096ZM21.0123 4.19127H18.2961L20.2887 0.0129956H23.0048L21.0123 4.19127ZM45.1167 3.15379H41.7936V0.0694119H45.1167V3.15379Z" fill="#202020"/></svg>`;

const TICKET_SVG = `<svg width="70" height="19" viewBox="0 0 70 19" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.96792 18.4138L6.06698 2.26953H0V0.0126195H14.3334V2.26953H8.26642L8.16736 18.4138H5.96792Z" fill="#202020"/><path d="M16.3007 2.39514V0.0126195H18.5001V2.39514H16.3007ZM16.2017 18.4138L16.3007 4.74685H18.5001L18.4011 18.4138H16.2017Z" fill="#202020"/><path d="M27.5826 18.4138C26.2317 18.4138 25.0825 18.1142 24.1352 17.515C23.1961 16.9076 22.4794 16.0744 21.9852 15.0155C21.4909 13.9567 21.2356 12.75 21.2191 11.3956C21.2356 10.0084 21.4951 8.78948 21.9975 7.7388C22.5083 6.67992 23.2373 5.85498 24.1846 5.26397C25.1319 4.67297 26.2729 4.37747 27.6073 4.37747C29.016 4.37747 30.2269 4.72222 31.2401 5.41173C32.2616 6.10123 32.9453 7.0452 33.2913 8.24362L31.1166 8.89619C30.8365 8.1246 30.3793 7.52539 29.745 7.09855C29.1189 6.67171 28.3982 6.4583 27.5826 6.4583C26.6683 6.4583 25.9145 6.67171 25.3214 7.09855C24.7283 7.51718 24.2876 8.09997 23.9993 8.84694C23.711 9.58569 23.5627 10.4353 23.5545 11.3956C23.5709 12.8732 23.9128 14.0675 24.58 14.9786C25.2555 15.8815 26.2564 16.333 27.5826 16.333C28.4558 16.333 29.1807 16.136 29.7574 15.742C30.334 15.3398 30.7706 14.7611 31.0671 14.0059L33.2913 14.5846C32.83 15.8241 32.1092 16.7721 31.1289 17.4288C30.1486 18.0855 28.9665 18.4138 27.5826 18.4138Z" fill="#202020"/><path d="M35.5536 18.4138L35.566 0.0126195H37.7902V11.1494L43.3876 4.74685H46.2419L40.3479 11.3956L47.1471 18.4138H44.0704L37.7902 11.6419V18.4138H35.5536Z" fill="#202020"/><path d="M53.458 18.4138C52.1483 18.4138 51.0032 18.1265 50.023 17.5519C49.0509 16.9691 48.2931 16.1606 47.7494 15.1264C47.2057 14.0839 46.9339 12.869 46.9339 11.4818C46.9339 10.0289 47.2016 8.77306 47.737 7.71418C48.2725 6.64709 49.018 5.82625 49.9735 5.25166C50.9373 4.66887 52.0659 4.37747 53.3592 4.37747C54.7019 4.37747 55.8428 4.68528 56.7819 5.30091C57.7292 5.91654 58.4377 6.79484 58.9072 7.93581C59.385 9.07677 59.5909 10.4353 59.525 12.0113H57.3009V11.2233C57.2762 9.5898 56.9426 8.37085 56.3 7.56643C55.6575 6.7538 54.7019 6.34748 53.4333 6.34748C52.0741 6.34748 51.0403 6.78253 50.3319 7.65262C49.6234 8.52271 49.2692 9.77038 49.2692 11.3956C49.2692 12.9634 49.6234 14.1783 50.3319 15.0402C51.0403 15.9021 52.0494 16.333 53.3592 16.333C54.2406 16.333 55.0067 16.1319 55.6575 15.742C56.3083 15.3275 56.819 14.7488 57.1897 13.9936L59.3026 14.72C58.7836 15.8938 58.0011 16.805 56.9549 17.4534C55.917 18.0937 54.7514 18.4138 53.458 18.4138ZM48.5278 12.0113V10.2506H58.3882V12.0113H48.5278Z" fill="#202020"/><path d="M69.4798 18.1919C68.689 18.3479 67.9064 18.4094 67.1321 18.3766C66.366 18.352 65.6823 18.2001 65.081 17.921C64.4796 17.6337 64.0224 17.043 63.7094 16.4438C63.4458 15.9185 63.3016 15.389 63.2769 14.8555C63.2604 14.3137 63.2522 13.7022 63.2522 13.0209V0H65.4516V12.9224C65.4516 13.4642 65.4558 13.9279 65.464 14.3137C65.4805 14.6995 65.567 15.032 65.7235 15.311C66.02 15.8364 66.4896 16.1442 67.1321 16.2345C67.7829 16.3248 68.5655 16.3002 69.4798 16.1606V18.1919ZM60.5462 6.5568V4.74685H69.4798V6.5568H60.5462Z" fill="#202020"/></svg>`;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReceiptPdfRegistrationRow {
  id: string;
  participantName: string;
  email?: string;
  ticketCategory?: string;
  ticketName: string;
  price: number; // cents
}

export interface ReceiptPdfData {
  orderNumber: string;
  issuedAt: Date;
  organization: {
    name: string;
    document?: string; // CNPJ/CPF raw digits
  };
  buyer: {
    name: string;
    document?: string;
  };
  event: {
    name: string;
    date: Date | string;
    location: string;
  };
  payment: {
    method: string; // PIX, CREDIT_CARD, BOLETO, FREE, etc.
    paidAt: Date;
    gateway?: string;
    transactionId?: string;
    txId?: string;
    e2eId?: string;
    voucherCode?: string;
    couponCode?: string;
  };
  financial: {
    subtotal: number;        // cents — ticket sum
    discount: number;        // cents — voucher + coupon
    voucherCode?: string;
    voucherPercent?: number; // e.g. 16.67
    serviceFee: number;      // cents (shown as "Inclusa" when 0 or already embedded)
    total: number;           // cents — final paid
  };
  registrations: ReceiptPdfRegistrationRow[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const C = {
  gray12:   '#202020',
  gray11:   '#646464',
  gray6:    '#D9D9D9',
  gray3:    '#F0F0F0',
  gray2:    '#F9F9F9',
  white:    '#FFFFFF',
  green11:  '#21835D',
  green12:  '#193B30',
  green3:   '#DAF1DB',
  green8:   '#46A758',
  greenPrimary: '#308737',
  greenPrimaryText: '#F5FBF5',
  amber12:  '#4F3422',
  pixColor: '#62B7AF',
} as const;

const PAGE_W = 595;
const PAGE_H = 842;
const ML = 40;
const MT = 32;
const CONTENT_W = PAGE_W - ML * 2;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const dt = new Date(d as string);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('pt-BR');
}

function fmtDateTime(d: Date): string {
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).replace(',', ' ·');
}

function fmtCurrency(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtDocument(raw: string | undefined): string {
  if (!raw) return '—';
  const d = raw.replace(/\D/g, '');
  if (d.length === 14) {
    return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  if (d.length === 11) {
    return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  }
  return raw;
}

function fmtPaymentMethod(method: string): string {
  const map: Record<string, string> = {
    PIX: 'Pix',
    CREDIT_CARD: 'Cartão de crédito',
    DEBIT_CARD: 'Cartão de débito',
    BOLETO: 'Boleto',
    FREE: 'Gratuito',
  };
  return map[method] ?? method;
}

function svgToPng(svgStr: string, w: number, h: number): Promise<Buffer> {
  return sharp(Buffer.from(svgStr))
    .resize(Math.round(w * 2), Math.round(h * 2))
    .png()
    .toBuffer();
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ReceiptPdfService {
  async generateReceiptPdf(data: ReceiptPdfData): Promise<Buffer> {
    const [vectorPng, podioPng, ticketPng] = await Promise.all([
      svgToPng(VECTOR_SVG, 29, 28),
      svgToPng(PODIO_SVG, 60, 19),
      svgToPng(TICKET_SVG, 70, 19),
    ]);

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const doc = new PDFDocument({
        margin: 0,
        size: 'A4',
        autoFirstPage: false,
        info: { Title: `Recibo — ${data.event.name}`, Creator: 'PódioTicket' },
      });

      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      let y = 0;

      const newPage = () => {
        doc.addPage();
        y = MT;
      };

      const ensureSpace = (needed: number) => {
        if (y + needed > PAGE_H - MT) newPage();
      };

      const hline = (yPos: number, x = ML, w = CONTENT_W, color = C.gray6) => {
        doc.save().strokeColor(color).lineWidth(0.5).moveTo(x, yPos).lineTo(x + w, yPos).stroke().restore();
      };

      // ── Header ─────────────────────────────────────────────────────────────
      const drawHeader = () => {
        doc.image(vectorPng, ML, y, { width: 29, height: 28 });
        doc.image(podioPng, ML + 35, y + 5, { width: 60, height: 19 });
        doc.image(ticketPng, ML + 100, y + 5, { width: 70, height: 19 });

        const pedidoLabel = 'Pedido: ';
        const pedidoW = doc.font('Helvetica').fontSize(10).widthOfString(pedidoLabel);
        doc.font('Helvetica').fontSize(10).fillColor(C.gray12).text(pedidoLabel, ML + CONTENT_W - 160, y + 2, { lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(C.gray12).text(`#${data.orderNumber}`, ML + CONTENT_W - 160 + pedidoW, y + 2, { lineBreak: false });
        doc.font('Helvetica').fontSize(9).fillColor(C.gray11).text(`Emitido em ${fmtDateTime(data.issuedAt)}`, ML + CONTENT_W - 160, y + 16, { width: 160, align: 'right', lineBreak: false });

        y += 36;
        hline(y);
        y += 20;
      };

      // ── Section badge ───────────────────────────────────────────────────────
      const drawSectionBadge = (num: string, label: string) => {
        ensureSpace(32);
        // Green square badge with number
        doc.save().roundedRect(ML, y, 28, 28, 4).fillColor(C.greenPrimary).fill().restore();
        doc.font('Helvetica-Bold').fontSize(13).fillColor(C.greenPrimaryText).text(num, ML, y + 7, { width: 28, align: 'center', lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(11).fillColor(C.gray12).text(label, ML + 36, y + 7, { lineBreak: false });
        y += 36;
      };

      // ── Info card row (label left, value right) ─────────────────────────────
      const drawKVRow = (label: string, value: string, x: number, w: number, yPos: number): number => {
        doc.font('Helvetica').fontSize(10).fillColor(C.gray11).text(label, x, yPos, { width: w / 2 - 4, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(C.gray12).text(value, x + w / 2, yPos, { width: w / 2, align: 'right', lineBreak: false });
        return yPos + 22;
      };

      // ── Render ─────────────────────────────────────────────────────────────
      newPage();

      // Header
      drawHeader();

      // Title
      doc.font('Helvetica-Bold').fontSize(14).fillColor(C.gray12).text('Recibo de pagamento', ML, y);
      y += 28;

      // ── Two-column cards: Organization | Buyer ──────────────────────────────
      {
        ensureSpace(140);
        const cardW = (CONTENT_W - 20) / 2;
        const cardStartY = y;
        const leftX = ML;
        const rightX = ML + cardW + 20;

        // measure content heights first
        const drawInfoCard = (x: number, w: number, title: string, rows: Array<[string, string]>) => {
          const rowH = 22;
          const totalH = 20 + 28 + 16 + rows.length * rowH + 16;
          // Card border
          doc.save().roundedRect(x, cardStartY, w, totalH, 8).strokeColor(C.gray6).lineWidth(0.5).stroke().restore();
          let cy = cardStartY + 20;
          // Title row with icon
          doc.save().roundedRect(x + 20, cy + 2, 36, 36, 18).fillColor(C.green12).fill().restore();
          doc.save().roundedRect(x + 20, cy + 2, 36, 36, 18).strokeColor(C.green8).lineWidth(0.5).stroke().restore();
          // Small check icon (simplified — just circle)
          doc.font('Helvetica-Bold').fontSize(12).fillColor(C.gray12).text(title, x + 64, cy + 10, { width: w - 84, lineBreak: false });
          cy += 46;
          hline(cy, x + 16, w - 32);
          cy += 12;
          rows.forEach(([label, value]) => {
            cy = drawKVRow(label, value, x + 16, w - 32, cy);
          });
          return cy + 4;
        };

        const orgRows: Array<[string, string]> = [
          ['CNPJ', fmtDocument(data.organization.document)],
          ['Evento', data.event.name],
          ['Data', `${fmtDate(data.event.date)} · ${data.event.location}`],
        ];

        const buyerRows: Array<[string, string]> = [
          ['CPF', fmtDocument(data.buyer.document)],
          ['Evento', data.event.name],
          ['Data', `${fmtDate(data.event.date)} · ${data.event.location}`],
        ];

        const leftBottom = drawInfoCard(leftX, cardW, data.organization.name, orgRows);
        const rightBottom = drawInfoCard(rightX, cardW, data.buyer.name, buyerRows);
        y = Math.max(leftBottom, rightBottom) + 20;
      }

      // ── Payment method row ──────────────────────────────────────────────────
      {
        ensureSpace(60);
        const rowH = 56;
        doc.save().roundedRect(ML, y, CONTENT_W, rowH, 8).fillColor(C.gray2).fill().restore();
        doc.save().roundedRect(ML, y, CONTENT_W, rowH, 8).strokeColor(C.gray6).lineWidth(0.5).stroke().restore();

        const methodLabel = fmtPaymentMethod(data.payment.method);
        const subLabel = data.payment.method === 'PIX' ? 'Pagamento instantâneo'
          : data.payment.method === 'BOLETO' ? 'Boleto bancário'
          : data.payment.method === 'FREE' ? 'Sem cobrança'
          : 'Pagamento com cartão';

        // Payment icon square
        doc.save().rect(ML + 16, y + 10, 36, 36).fillColor(C.pixColor).fill().restore();

        doc.font('Helvetica-Bold').fontSize(13).fillColor(C.gray12).text(methodLabel, ML + 60, y + 10, { lineBreak: false });
        doc.font('Helvetica').fontSize(10).fillColor(C.gray12).text(subLabel, ML + 60, y + 26, { lineBreak: false });

        // "Pago" badge
        const badgeW = 60;
        const badgeX = ML + CONTENT_W - badgeW - 12;
        doc.save().roundedRect(badgeX, y + 16, badgeW, 24, 4).fillColor(C.green11).fill().restore();
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#FBFEFB').text('Pago', badgeX, y + 22, { width: badgeW, align: 'center', lineBreak: false });

        y += rowH + 20;
      }

      // ── Section 1: Resumo financeiro ────────────────────────────────────────
      drawSectionBadge('1', 'Resumo financeiro');

      {
        ensureSpace(160);
        const cardX = ML;
        const cardY = y;
        const lines: Array<{ label: string; value: string; bold?: boolean }> = [];

        lines.push({ label: `Subtotal (${data.registrations.length} ingresso${data.registrations.length !== 1 ? 's' : ''})`, value: fmtCurrency(data.financial.subtotal) });

        if (data.financial.discount > 0) {
          const discountLabel = data.financial.voucherCode
            ? `Voucher ${data.financial.voucherCode}${data.financial.voucherPercent ? ` (-${data.financial.voucherPercent.toFixed(2)}%)` : ''}`
            : 'Desconto';
          lines.push({ label: discountLabel, value: `- ${fmtCurrency(data.financial.discount)}` });
        }

        lines.push({ label: 'Taxa de serviço', value: data.financial.serviceFee > 0 ? fmtCurrency(data.financial.serviceFee) : 'Inclusa' });
        lines.push({ label: 'Total pago', value: fmtCurrency(data.financial.total), bold: true });

        const rowH = 22;
        const dividerCount = lines.length - 1;
        const cardH = 20 + lines.length * rowH + dividerCount * 14 + 10;

        doc.save().roundedRect(cardX, cardY, CONTENT_W, cardH, 8).strokeColor(C.gray6).lineWidth(0.5).stroke().restore();

        let cy = cardY + 16;
        lines.forEach((line, i) => {
          if (i > 0) {
            cy += 6;
            hline(cy, cardX + 16, CONTENT_W - 32);
            cy += 8;
          }
          const font = line.bold ? 'Helvetica-Bold' : 'Helvetica';
          const size = line.bold ? 13 : 11;
          doc.font(font).fontSize(size).fillColor(C.gray12).text(line.label, cardX + 16, cy, { lineBreak: false });
          doc.font(font).fontSize(size).fillColor(C.gray12).text(line.value, cardX + 16, cy, { width: CONTENT_W - 32, align: 'right', lineBreak: false });
          cy += rowH;
        });

        y = cardY + cardH + 20;
      }

      // ── Section 2: Detalhes da transação ────────────────────────────────────
      drawSectionBadge('2', 'Detalhes da transação');

      {
        ensureSpace(200);
        const cardX = ML;
        const cardY = y;
        const txRows: Array<{ label: string; value: string; amber?: boolean }> = [];

        txRows.push({ label: 'Data da compra', value: fmtDateTime(data.payment.paidAt) });
        txRows.push({ label: 'Gateway', value: data.payment.gateway || 'PódioTicket' });

        if (data.financial.voucherCode || data.payment.voucherCode) {
          txRows.push({ label: 'Voucher utilizado', value: (data.financial.voucherCode || data.payment.voucherCode)!, amber: true });
        }
        if (data.payment.couponCode) {
          txRows.push({ label: 'Cupom utilizado', value: data.payment.couponCode, amber: true });
        }
        if (data.payment.txId) {
          txRows.push({ label: 'TxID', value: data.payment.txId });
        }
        if (data.payment.transactionId) {
          txRows.push({ label: 'ID da transação', value: data.payment.transactionId });
        }
        if (data.payment.e2eId) {
          txRows.push({ label: 'E2E ID (Pix)', value: data.payment.e2eId });
        }

        const rowH = 44;
        const cardH = txRows.length * rowH + 16;
        doc.save().roundedRect(cardX, cardY, CONTENT_W, cardH, 8).strokeColor(C.gray6).lineWidth(0.5).stroke().restore();

        let cy = cardY + 12;
        txRows.forEach((row, i) => {
          if (i > 0) {
            hline(cy, cardX + 1, CONTENT_W - 2);
            cy += 4;
          }
          const color = row.amber ? C.amber12 : C.gray12;
          doc.font('Helvetica').fontSize(10).fillColor(C.gray12).text(row.label, cardX + 16, cy, { lineBreak: false });
          doc.font('Helvetica-Bold').fontSize(10).fillColor(color).text(row.value, cardX + 16, cy + 16, { width: CONTENT_W - 32, lineBreak: false });
          cy += rowH;
        });

        y = cardY + cardH + 20;
      }

      // ── Section 3: Ingressos adquiridos ─────────────────────────────────────
      drawSectionBadge('3', 'Ingressos adquiridos');

      {
        ensureSpace(60 + data.registrations.length * 44);
        const cardX = ML;
        const cardY = y;
        const COL_ID = 110;
        const COL_VAL = 120;
        const COL_TICKET = (CONTENT_W - COL_ID - COL_VAL) / 2;
        const COL_PARTICIPANT = CONTENT_W - COL_ID - COL_VAL - COL_TICKET;
        const headerH = 36;
        const rowH = 44;
        const tableH = headerH + data.registrations.length * rowH;

        // Table border
        doc.save().roundedRect(cardX, cardY, CONTENT_W, tableH, 8).strokeColor(C.gray6).lineWidth(0.5).stroke().restore();

        // Header row
        doc.save().roundedRect(cardX, cardY, CONTENT_W, headerH, 8).fillColor(C.gray3).fill().restore();
        hline(cardY, cardX + 1, CONTENT_W - 2, C.gray6);
        hline(cardY + headerH, cardX + 1, CONTENT_W - 2, C.gray6);

        const headers = [
          { label: 'ID inscrição', x: cardX + 16, w: COL_ID - 16, align: 'left' as const },
          { label: 'Participante', x: cardX + COL_ID, w: COL_PARTICIPANT, align: 'left' as const },
          { label: 'Ticket', x: cardX + COL_ID + COL_PARTICIPANT, w: COL_TICKET, align: 'left' as const },
          { label: 'Valor', x: cardX + CONTENT_W - COL_VAL, w: COL_VAL - 16, align: 'right' as const },
        ];
        headers.forEach((h) => {
          doc.font('Helvetica-Bold').fontSize(9).fillColor(C.gray12).text(h.label, h.x, cardY + 12, { width: h.w, align: h.align, lineBreak: false });
        });

        // Data rows
        let ry = cardY + headerH;
        data.registrations.forEach((reg) => {
          hline(ry + rowH, cardX + 1, CONTENT_W - 2, C.gray6);

          // ID (shortened)
          const shortId = reg.id.slice(0, 8).toUpperCase();
          doc.font('Helvetica-Bold').fontSize(9).fillColor(C.gray12).text(shortId, cardX + 16, ry + 10, { width: COL_ID - 20, lineBreak: false });

          // Participant: name + email
          const partX = cardX + COL_ID;
          doc.font('Helvetica-Bold').fontSize(9).fillColor(C.gray12).text(reg.participantName, partX + 4, ry + 8, { width: COL_PARTICIPANT - 8, lineBreak: false });
          if (reg.email) {
            doc.font('Helvetica').fontSize(8).fillColor(C.gray11).text(reg.email, partX + 4, ry + 22, { width: COL_PARTICIPANT - 8, lineBreak: false });
          }

          // Ticket: category + name
          const tickX = cardX + COL_ID + COL_PARTICIPANT;
          if (reg.ticketCategory) {
            doc.font('Helvetica').fontSize(8).fillColor(C.gray11).text(reg.ticketCategory, tickX + 4, ry + 8, { width: COL_TICKET - 8, lineBreak: false });
          }
          doc.font('Helvetica-Bold').fontSize(9).fillColor(C.gray12).text(reg.ticketName, tickX + 4, ry + 22, { width: COL_TICKET - 8, lineBreak: false });

          // Price
          doc.font('Helvetica-Bold').fontSize(9).fillColor(C.gray12).text(fmtCurrency(reg.price), cardX + CONTENT_W - COL_VAL, ry + 15, { width: COL_VAL - 16, align: 'right', lineBreak: false });

          ry += rowH;
        });

        y = cardY + tableH + 12;

        // Summary bar (green)
        const total = data.registrations.reduce((s, r) => s + r.price, 0);
        doc.save().roundedRect(ML, y, CONTENT_W, 44, 8).fillColor(C.green3).fill().restore();
        doc.save().roundedRect(ML, y, CONTENT_W, 44, 8).strokeColor(C.green8).lineWidth(0.5).stroke().restore();
        doc.font('Helvetica').fontSize(10).fillColor(C.green12).text(`${data.registrations.length} ingresso${data.registrations.length !== 1 ? 's' : ''} vinculado${data.registrations.length !== 1 ? 's' : ''} a este pedido`, ML + 16, y + 14, { lineBreak: false });
        doc.font('Helvetica').fontSize(10).fillColor(C.green12).text('Subtotal: ', ML + CONTENT_W - 130, y + 14, { continued: true, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(C.green12).text(fmtCurrency(total), { lineBreak: false });

        y += 56;
      }

      // ── Declaration notice ──────────────────────────────────────────────────
      {
        ensureSpace(80);
        const gateway = data.payment.gateway || 'PódioTicket';
        const declText = `O pagamento referente ao pedido #${data.orderNumber} foi recebido e processado com sucesso pelo gateway ${gateway} em ${fmtDateTime(data.payment.paidAt)}. Este recibo é o comprovante oficial da transação. Para detalhes dos participantes (QR Code, dados pessoais e perguntas do organizador), consulte o PDF de ingressos enviado junto com este documento.`;

        const declHeight = Math.max(60, doc.font('Helvetica').fontSize(9).heightOfString(declText, { width: CONTENT_W - 60 }) + 24);
        ensureSpace(declHeight + 8);

        doc.font('Helvetica-Bold').fontSize(10).fillColor(C.amber12).text('Declaração: ', ML + 28, y + 8, { continued: true, lineBreak: false });
        doc.font('Helvetica').fontSize(9).fillColor(C.amber12).text(declText, { width: CONTENT_W - 36 });
        y = doc.y + 16;
      }

      // ── Footer divider + info ───────────────────────────────────────────────
      {
        ensureSpace(70);
        hline(y);
        y += 16;

        doc.font('Helvetica').fontSize(9).fillColor(C.gray11)
          .text('Pagamento processado pela plataforma ', ML, y, { continued: true, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(9).fillColor(C.gray11)
          .text('PódioTicket Ltda. ', { continued: true, lineBreak: false });
        doc.font('Helvetica').fontSize(9).fillColor(C.gray11)
          .text('CNPJ 65.174.909/0001-01', ML + CONTENT_W - 180, y, { lineBreak: false });
        y += 18;

        doc.font('Helvetica').fontSize(9).fillColor(C.gray11)
          .text('Suporte: suporte@podioticket.com.br', ML, y, { lineBreak: false });
        doc.font('Helvetica').fontSize(9).fillColor(C.gray11)
          .text('Documento gerado eletronicamente, sem necessidade de assinatura', ML, y, { width: CONTENT_W, align: 'right', lineBreak: false });
      }

      doc.end();
    });
  }
}
