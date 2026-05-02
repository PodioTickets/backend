import { Injectable } from '@nestjs/common';
import * as XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import { ExportField, EXPORT_FIELDS } from './dto/export-registrations.dto';

/** Maps ExportField → human-readable column label */
const FIELD_LABELS: Record<ExportField, string> = {
  nome: 'Nome',
  email: 'E-mail',
  cpf: 'CPF',
  dataNascimento: 'Data de Nascimento',
  telefone: 'Telefone',
  sexo: 'Sexo',
  contatoEmergencia: 'Contato de emergência',
  endereco: 'Endereço de pagamento',
  ingresso: 'Ingresso',
  produtosEscolhidos: 'Produtos escolhidos',
  perguntasRespostas: 'Perguntas e respostas',
  dataPagamento: 'Data da compra',
  status: 'Status da compra',
  formaPagamento: 'Forma de pagamento',
  valorPago: 'Valor pago',
};

function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso as string);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR');
}

function formatCurrency(cents: number | null | undefined): string {
  if (cents == null) return '';
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatStatus(status: string | null | undefined): string {
  const map: Record<string, string> = {
    CONFIRMED: 'Confirmado',
    CANCELLED: 'Cancelado',
    PENDING: 'Pendente',
    COMPLETED: 'Concluído',
    CHARGEBACK: 'Chargeback',
    REFUNDED: 'Reembolsado',
  };
  return map[status ?? ''] ?? (status ?? '');
}

function formatPaymentMethod(method: string | null | undefined): string {
  const map: Record<string, string> = {
    CREDIT_CARD: 'Cartão de crédito',
    DEBIT_CARD: 'Cartão de débito',
    PIX: 'Pix',
    BOLETO: 'Boleto',
    FREE: 'Gratuito',
  };
  return map[method ?? ''] ?? (method ?? '');
}

/** Extract a single field value from a formatted registration row */
function extractField(reg: any, field: ExportField): string {
  const user = reg.user ?? {};
  const order = reg.order ?? {};
  const payment = order.payment ?? {};

  switch (field) {
    case 'nome':
      return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    case 'email':
      return user.email ?? '';
    case 'cpf':
      return user.documentNumber ?? '';
    case 'dataNascimento':
      return formatDate(user.dateOfBirth);
    case 'telefone':
      return user.phone ?? '';
    case 'sexo':
      return user.gender ?? '';
    case 'contatoEmergencia': {
      const ec = reg.emergencyContact ?? {};
      const parts = [ec.name, ec.phone].filter(Boolean);
      return parts.join(' | ');
    }
    case 'endereco': {
      const addr = order.billingAddress ?? {};
      const parts = [
        addr.street,
        addr.number,
        addr.complement,
        addr.neighborhood,
        addr.city,
        addr.state,
        addr.zipCode,
      ].filter(Boolean);
      return parts.join(', ');
    }
    case 'ingresso': {
      const ticket = reg.ticket ?? null;
      if (!ticket) return '';
      const categoryName = ticket.category?.name ?? ticket.modality ?? '';
      const ticketName = ticket.name ?? '';
      if (categoryName && ticketName && categoryName !== ticketName) {
        return `${categoryName} - ${ticketName}`;
      }
      return ticketName || categoryName;
    }
    case 'produtosEscolhidos': {
      const products: any[] = reg.products ?? [];
      return products
        .map((p: any) => {
          const name = p.product?.name ?? '';
          const variation = p.variationName ?? p.variation?.name ?? '';
          return variation ? `${name} (${variation})` : name;
        })
        .filter(Boolean)
        .join('; ');
    }
    case 'perguntasRespostas': {
      const qas: any[] = reg.questionAnswers ?? [];
      return qas
        .map((qa: any) => `${qa.question?.question ?? ''}: ${qa.answer ?? ''}`)
        .join(' | ');
    }
    case 'dataPagamento':
      // Data da compra = order creation date
      return formatDate(order.purchaseDate);
    case 'status':
      return formatStatus(reg.status);
    case 'formaPagamento':
      return formatPaymentMethod(payment.method);
    case 'valorPago':
      return formatCurrency(order.finalAmount);
    default:
      return '';
  }
}

function csvEscape(cell: string): string {
  const s = String(cell ?? '').replace(/"/g, '""');
  return /[,"\n\r]/.test(s) ? `"${s}"` : s;
}

function metadataLine(eventName: string, extractedAt: Date): string {
  return `${eventName} — Relatório gerado em ${extractedAt.toLocaleString('pt-BR')}`;
}

@Injectable()
export class ExportRegistrationsService {
  /** Parse the `fields` query param; fall back to all fields */
  parseFields(fieldsParam: string | undefined): ExportField[] {
    if (!fieldsParam) return [...EXPORT_FIELDS];
    const requested = fieldsParam.split(',').map((f) => f.trim()) as ExportField[];
    const valid = requested.filter((f) => (EXPORT_FIELDS as readonly string[]).includes(f));
    return valid.length > 0 ? valid : [...EXPORT_FIELDS];
  }

  /** Build a 2-D array of [headers, ...rows] (no metadata row) */
  private buildRows(registrations: any[], fields: ExportField[]): string[][] {
    const headers = fields.map((f) => FIELD_LABELS[f]);
    const rows = registrations.map((reg) => fields.map((f) => extractField(reg, f)));
    return [headers, ...rows];
  }

  /** TXT: CSV — first line = metadata, second = headers, rest = data */
  generateTxt(registrations: any[], fields: ExportField[], eventName: string): Buffer {
    const extractedAt = new Date();
    const meta = metadataLine(eventName, extractedAt);
    const dataRows = this.buildRows(registrations, fields);

    const lines = [
      csvEscape(meta), // single-cell first line
      ...dataRows.map((row) => row.map(csvEscape).join(',')),
    ];

    return Buffer.from('﻿' + lines.join('\r\n'), 'utf8'); // BOM + CRLF
  }

  /** Excel: row 0 = metadata (merged), row 1 = headers (bold), rows 2+ = data */
  generateExcel(registrations: any[], fields: ExportField[], eventName: string): Buffer {
    const extractedAt = new Date();
    const meta = metadataLine(eventName, extractedAt);
    const dataRows = this.buildRows(registrations, fields); // [headers, ...rows]

    // Prepend metadata row
    const allRows = [[meta, ...Array(fields.length - 1).fill('')], ...dataRows];

    const ws = XLSX.utils.aoa_to_sheet(allRows);

    // Merge metadata across all columns
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: fields.length - 1 } }];

    // Auto column widths (based on header + data rows, skip metadata row)
    const colWidths = fields.map((f, i) => {
      const maxLen = dataRows.reduce(
        (max, row) => Math.max(max, String(row[i] ?? '').length),
        FIELD_LABELS[f].length,
      );
      return { wch: Math.min(maxLen + 2, 60) };
    });
    ws['!cols'] = colWidths;

    // Style: metadata row bold, header row (row index 1) bold
    const styleRows = [0, 1];
    styleRows.forEach((r) => {
      fields.forEach((_, c) => {
        const cellRef = XLSX.utils.encode_cell({ r, c });
        if (ws[cellRef]) {
          ws[cellRef].s = { font: { bold: true } };
        }
      });
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inscrições');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  /** PDF: paginated table, metadata in footer of every page */
  generatePdf(registrations: any[], fields: ExportField[], eventName: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const extractedAt = new Date();
      const footerText = `${eventName}  •  Gerado em ${extractedAt.toLocaleString('pt-BR')}  •  ${registrations.length} inscrições`;

      const chunks: Buffer[] = [];
      const doc = new PDFDocument({ margin: 0, size: 'A4', layout: 'landscape', autoFirstPage: false });

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const MARGIN = 30;
      const FOOTER_H = 20;
      const pageW = 841.89 - MARGIN * 2; // A4 landscape width - margins
      const pageH = 595.28;              // A4 landscape height
      const usableH = pageH - MARGIN - FOOTER_H - 10; // top margin + footer space

      const headers = fields.map((f) => FIELD_LABELS[f]);
      const colW = Math.max(40, Math.floor(pageW / headers.length));
      const rowH = 18;
      const headerH = 22;
      const fontSize = fields.length > 10 ? 6 : fields.length > 7 ? 7 : 8;

      const TITLE_H = 20;

      const drawFooter = () => {
        doc
          .fontSize(7)
          .font('Helvetica')
          .fillColor('#646464')
          .text(footerText, MARGIN, pageH - FOOTER_H - 5, {
            width: pageW,
            align: 'center',
            lineBreak: false,
          });
        doc.fillColor('#000000');
      };

      const drawTitle = (yPos: number): number => {
        doc
          .font('Helvetica-Bold')
          .fontSize(10)
          .fillColor('#202020')
          .text(eventName, MARGIN, yPos + 4, {
            width: pageW,
            lineBreak: false,
            ellipsis: true,
          });
        doc.font('Helvetica').fillColor('#000000');
        return yPos + TITLE_H;
      };

      const drawHeader = (yPos: number): number => {
        doc.rect(MARGIN, yPos, pageW, headerH).fillColor('#202020').fill();
        doc.fillColor('#ffffff').fontSize(fontSize).font('Helvetica-Bold');
        headers.forEach((h, i) => {
          doc.text(h, MARGIN + i * colW + 3, yPos + 6, {
            width: colW - 4,
            lineBreak: false,
            ellipsis: true,
          });
        });
        doc.fillColor('#000000').font('Helvetica');
        return yPos + headerH;
      };

      const addPage = (): number => {
        doc.addPage();
        drawFooter();
        return drawTitle(MARGIN);
      };

      let y = addPage();
      y = drawHeader(y);

      registrations.forEach((reg, rowIdx) => {
        if (y + rowH > usableH) {
          y = addPage();
          y = drawHeader(y);
        }
        const bg = rowIdx % 2 === 0 ? '#F9F9F9' : '#FFFFFF';
        doc.rect(MARGIN, y, pageW, rowH).fillColor(bg).fill();
        doc.fillColor('#202020').fontSize(fontSize).font('Helvetica');
        fields.forEach((f, i) => {
          const val = extractField(reg, f);
          doc.text(val, MARGIN + i * colW + 3, y + 5, {
            width: colW - 6,
            lineBreak: false,
            ellipsis: true,
          });
        });
        doc.rect(MARGIN, y, pageW, rowH).strokeColor('#E0E0E0').lineWidth(0.5).stroke();
        y += rowH;
      });

      doc.end();
    });
  }
}
