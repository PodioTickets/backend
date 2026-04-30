import { Injectable } from '@nestjs/common';
import * as XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import { ExportField, EXPORT_FIELDS } from './dto/export-registrations.dto';

/** Maps ExportField → human-readable column label */
const FIELD_LABELS: Record<ExportField, string> = {
  nome: 'Nome',
  email: 'E-mail',
  cpf: 'CPF',
  dataNascimento: 'Data de nascimento',
  telefone: 'Telefone',
  sexo: 'Sexo',
  contatoEmergencia: 'Contato de emergência',
  endereco: 'Endereço',
  ingresso: 'Ingresso',
  produtosEscolhidos: 'Produtos escolhidos',
  perguntasRespostas: 'Perguntas e respostas',
  dataPagamento: 'Data de pagamento',
  status: 'Status',
  formaPagamento: 'Forma de pagamento',
  valorPago: 'Valor pago',
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
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
      const parts = [addr.street, addr.number, addr.complement, addr.neighborhood, addr.city, addr.state, addr.zipCode].filter(Boolean);
      return parts.join(', ');
    }
    case 'ingresso': {
      const ticket = reg.ticket ?? reg.tickets?.[0]?.ticket ?? null;
      if (!ticket) return '';
      const name = ticket.name ?? ticket.modality ?? '';
      const dist = ticket.distance ? ` ${ticket.distance}${ticket.distanceUnit ? ' ' + ticket.distanceUnit : ''}` : '';
      return `${name}${dist}`.trim();
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
      return formatDate(payment.paymentDate ?? payment.createdAt);
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

@Injectable()
export class ExportRegistrationsService {
  /** Parse the `fields` query param; fall back to all fields */
  parseFields(fieldsParam: string | undefined): ExportField[] {
    if (!fieldsParam) return [...EXPORT_FIELDS];
    const requested = fieldsParam.split(',').map((f) => f.trim()) as ExportField[];
    return requested.filter((f) => (EXPORT_FIELDS as readonly string[]).includes(f));
  }

  /** Build a 2-D array of [headers, ...rows] */
  buildRows(registrations: any[], fields: ExportField[]): string[][] {
    const headers = fields.map((f) => FIELD_LABELS[f]);
    const rows = registrations.map((reg) => fields.map((f) => extractField(reg, f)));
    return [headers, ...rows];
  }

  /** TXT: CSV with comma delimiter */
  generateTxt(registrations: any[], fields: ExportField[]): Buffer {
    const rows = this.buildRows(registrations, fields);
    const csv = rows
      .map((row) =>
        row
          .map((cell) => {
            const escaped = String(cell ?? '').replace(/"/g, '""');
            return /[,"\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
          })
          .join(','),
      )
      .join('\r\n');
    return Buffer.from('﻿' + csv, 'utf8'); // BOM for Excel compatibility
  }

  /** Excel: .xlsx via SheetJS */
  generateExcel(registrations: any[], fields: ExportField[], eventName: string): Buffer {
    const rows = this.buildRows(registrations, fields);
    const ws = XLSX.utils.aoa_to_sheet(rows);

    // Auto column widths
    const colWidths = fields.map((f, i) => {
      const maxLen = rows.reduce((max, row) => Math.max(max, String(row[i] ?? '').length), FIELD_LABELS[f].length);
      return { wch: Math.min(maxLen + 2, 60) };
    });
    ws['!cols'] = colWidths;

    // Bold header row
    fields.forEach((_, i) => {
      const cellRef = XLSX.utils.encode_cell({ r: 0, c: i });
      if (ws[cellRef]) {
        ws[cellRef].s = { font: { bold: true } };
      }
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inscrições');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    return buf;
  }

  /** PDF: paginated table via pdfkit */
  generatePdf(registrations: any[], fields: ExportField[], eventName: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageW = doc.page.width - 60; // usable width (margins)
      const headers = fields.map((f) => FIELD_LABELS[f]);
      const colW = Math.max(50, Math.floor(pageW / headers.length));
      const rowH = 20;
      const headerH = 24;
      const fontSize = fields.length > 8 ? 7 : 8;

      // Title
      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .text(`Inscrições — ${eventName}`, 30, 30, { align: 'left' });
      doc
        .fontSize(9)
        .font('Helvetica')
        .text(`Gerado em ${new Date().toLocaleString('pt-BR')}  •  ${registrations.length} inscrições`, { align: 'left' });
      doc.moveDown(0.5);

      let y = doc.y;

      const drawHeader = (yPos: number) => {
        doc.rect(30, yPos, pageW, headerH).fillColor('#202020').fill();
        doc.fillColor('#ffffff').fontSize(fontSize).font('Helvetica-Bold');
        headers.forEach((h, i) => {
          doc.text(h, 30 + i * colW + 4, yPos + 7, { width: colW - 6, lineBreak: false, ellipsis: true });
        });
        doc.fillColor('#000000').font('Helvetica');
        return yPos + headerH;
      };

      y = drawHeader(y);

      registrations.forEach((reg, rowIdx) => {
        if (y + rowH > doc.page.height - 40) {
          doc.addPage();
          y = 30;
          y = drawHeader(y);
        }
        const bg = rowIdx % 2 === 0 ? '#F9F9F9' : '#FFFFFF';
        doc.rect(30, y, pageW, rowH).fillColor(bg).fill();
        doc.fillColor('#202020').fontSize(fontSize).font('Helvetica');
        fields.forEach((f, i) => {
          const val = extractField(reg, f);
          doc.text(val, 30 + i * colW + 4, y + 6, { width: colW - 8, lineBreak: false, ellipsis: true });
        });
        // row border
        doc.rect(30, y, pageW, rowH).strokeColor('#D9D9D9').stroke();
        y += rowH;
      });

      doc.end();
    });
  }
}
