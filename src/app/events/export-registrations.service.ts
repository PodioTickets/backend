import { Injectable } from '@nestjs/common';
import * as XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import { ExportField, EXPORT_FIELDS } from './dto/export-registrations.dto';
import { formatCpfByCountry } from '../../common/utils/locale.util';

/** Maps ExportField → human-readable column label */
const FIELD_LABELS: Record<ExportField, string> = {
  nome: 'Nome',
  email: 'E-mail',
  cpf: 'Documento',
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
    case 'cpf': {
      // Doc cru: participante (guest/terceiro) tem prioridade sobre user.
      const rawDoc = reg.participantCpf
        ?? reg.participantDocumentNumber
        ?? user.documentNumber
        ?? '';
      if (!rawDoc) return '';
      // Nacionalidade pra decidir se formata como CPF (BR) ou deixa cru.
      // Mesma prioridade do PDF: snapshot → billingCountry → user.country.
      const country =
        (reg.receiptSnapshot as any)?.participant?.country
        ?? order.billingCountry
        ?? user.country
        ?? null;
      const documentType =
        (reg.receiptSnapshot as any)?.participant?.documentType
        ?? reg.participantDocumentType
        ?? user.documentType
        ?? null;
      return formatCpfByCountry(rawDoc, country, documentType);
    }
    case 'dataNascimento':
      return formatDate(user.dateOfBirth);
    case 'telefone':
      return user.phone ?? '';
    case 'sexo': {
      const generoMap: Record<string, string> = {
        MALE: 'Masculino',
        FEMALE: 'Feminino',
        OTHER: 'Outro',
        PREFER_NOT_TO_SAY: 'Prefiro não informar',
      };
      return generoMap[user.gender ?? ''] ?? (user.gender ?? '');
    }
    case 'contatoEmergencia': {
      const ec = reg.emergencyContact ?? {};
      const parts = [ec.name, ec.phone].filter(Boolean);
      return parts.join(' | ');
    }
    case 'endereco': {
      const addr = order.billingAddress ?? {};
      const partes: string[] = [];
      const cidadeEstado: string[] = [];
      if (addr.city) cidadeEstado.push(addr.city);
      if (addr.stateUf) cidadeEstado.push(addr.stateUf);
      if (cidadeEstado.length) partes.push(cidadeEstado.join(' - '));
      if (addr.neighborhood) partes.push(addr.neighborhood);
      const logradouro = [addr.street, addr.number, addr.complement].filter(Boolean).join(', ');
      if (logradouro) partes.push(logradouro);
      if (addr.postalCode) {
        const cep = String(addr.postalCode).replace(/\D/g, '');
        partes.push(cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep);
      }
      return partes.join(', ');
    }
    case 'ingresso': {
      const removerCorrida = (s: string) =>
        s.replace(/\bcorrida\b/gi, '').replace(/\s{2,}/g, ' ').trim();
      const ticket = reg.ticket ?? null;
      if (!ticket) return '';
      const categoryName = removerCorrida(ticket.category?.name ?? ticket.modality ?? '');
      const ticketName = removerCorrida(ticket.name ?? '');
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

/** Coleta perguntas únicas em ordem de aparecimento entre todas as inscrições */
function collectAllQuestions(registrations: any[]): string[] {
  const seen = new Set<string>();
  const questions: string[] = [];
  for (const reg of registrations) {
    for (const qa of (reg.questionAnswers ?? [])) {
      const q: string = qa.question?.question ?? '';
      if (q && !seen.has(q)) {
        seen.add(q);
        questions.push(q);
      }
    }
  }
  return questions;
}

/**
 * Expande fields/headers/rows substituindo 'perguntasRespostas' por uma coluna
 * por pergunta única, preenchendo a resposta correspondente em cada linha.
 */
function buildExpandedRows(
  registrations: any[],
  fields: ExportField[],
): { headers: string[]; rows: string[][] } {
  const hasPR = fields.includes('perguntasRespostas');
  const allQuestions = hasPR ? collectAllQuestions(registrations) : [];

  const headers: string[] = [];
  for (const f of fields) {
    if (f === 'perguntasRespostas') {
      if (allQuestions.length === 0) {
        headers.push(FIELD_LABELS['perguntasRespostas']);
      } else {
        headers.push(...allQuestions);
      }
    } else {
      headers.push(FIELD_LABELS[f]);
    }
  }

  const rows = registrations.map((reg) => {
    const row: string[] = [];
    for (const f of fields) {
      if (f === 'perguntasRespostas') {
        if (allQuestions.length === 0) {
          row.push('');
        } else {
          const answerMap = new Map<string, string>();
          for (const qa of (reg.questionAnswers ?? [])) {
            const q: string = qa.question?.question ?? '';
            if (q) answerMap.set(q, qa.answer ?? '');
          }
          for (const q of allQuestions) {
            row.push(answerMap.get(q) ?? '');
          }
        }
      } else {
        row.push(extractField(reg, f));
      }
    }
    return row;
  });

  return { headers, rows };
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

  /** TXT: CSV — first line = metadata, second = headers, rest = data */
  generateTxt(registrations: any[], fields: ExportField[], eventName: string): Buffer {
    const extractedAt = new Date();
    const meta = metadataLine(eventName, extractedAt);
    const { headers, rows } = buildExpandedRows(registrations, fields);

    const lines = [
      csvEscape(meta),
      [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n'),
    ].join('\r\n');

    return Buffer.from('﻿' + lines, 'utf8'); // BOM + CRLF
  }

  /** Excel: row 0 = metadata (merged), row 1 = headers (bold), rows 2+ = data */
  generateExcel(registrations: any[], fields: ExportField[], eventName: string): Buffer {
    const extractedAt = new Date();
    const meta = metadataLine(eventName, extractedAt);
    const { headers, rows } = buildExpandedRows(registrations, fields);
    const totalCols = headers.length;

    // Linha de metadata + cabeçalhos + dados
    const allRows = [
      [meta, ...Array(totalCols - 1).fill('')],
      headers,
      ...rows,
    ];

    const ws = XLSX.utils.aoa_to_sheet(allRows);

    // Merge metadata across all columns
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } }];

    // Auto column widths (baseado em header + dados)
    const colWidths = headers.map((h, i) => {
      const maxLen = rows.reduce(
        (max, row) => Math.max(max, String(row[i] ?? '').length),
        h.length,
      );
      return { wch: Math.min(maxLen + 2, 60) };
    });
    ws['!cols'] = colWidths;

    // Style: metadata row bold, header row (row index 1) bold
    [0, 1].forEach((r) => {
      headers.forEach((_, c) => {
        const cellRef = XLSX.utils.encode_cell({ r, c });
        if (ws[cellRef]) ws[cellRef].s = { font: { bold: true } };
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

      const { headers, rows: expandedRows } = buildExpandedRows(registrations, fields);
      const colW = Math.max(40, Math.floor(pageW / headers.length));
      const ROW_H_MIN = 18;
      const fontSize = headers.length > 10 ? 6 : headers.length > 7 ? 7 : 8;

      // headerH dinâmico: calcula a altura do header mais alto e adiciona padding
      doc.font('Helvetica-Bold').fontSize(fontSize);
      const headerH = Math.max(
        22,
        ...headers.map((h) => doc.heightOfString(h, { width: colW - 6 }) + 12),
      );
      doc.font('Helvetica');

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
            lineBreak: true,
          });
        const renderedBottom = doc.y;
        doc.font('Helvetica').fillColor('#000000');
        return Math.max(yPos + TITLE_H, renderedBottom + 4);
      };

      const drawHeader = (yPos: number): number => {
        doc.rect(MARGIN, yPos, pageW, headerH).fillColor('#202020').fill();
        doc.fillColor('#ffffff').fontSize(fontSize).font('Helvetica-Bold');
        headers.forEach((h, i) => {
          doc.text(h, MARGIN + i * colW + 3, yPos + 6, {
            width: colW - 6,
            lineBreak: true,
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

      expandedRows.forEach((cells, rowIdx) => {
        // Calcular altura dinâmica da linha com base no conteúdo mais alto
        doc.font('Helvetica').fontSize(fontSize);
        const alturas = cells.map((val) =>
          doc.heightOfString(String(val || ''), { width: colW - 6 }) + 18,
        );
        const thisRowH = Math.max(ROW_H_MIN, ...alturas);

        if (y + thisRowH > usableH) {
          y = addPage();
          y = drawHeader(y);
        }
        const bg = rowIdx % 2 === 0 ? '#F9F9F9' : '#FFFFFF';
        doc.rect(MARGIN, y, pageW, thisRowH).fillColor(bg).fill();
        doc.fillColor('#202020').fontSize(fontSize).font('Helvetica');
        cells.forEach((val, i) => {
          doc.text(val, MARGIN + i * colW + 3, y + 5, {
            width: colW - 6,
            lineBreak: true,
          });
        });
        doc.rect(MARGIN, y, pageW, thisRowH).strokeColor('#E0E0E0').lineWidth(0.5).stroke();
        y += thisRowH;
      });

      doc.end();
    });
  }
}
