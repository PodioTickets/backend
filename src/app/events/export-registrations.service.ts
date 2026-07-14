import { Injectable } from '@nestjs/common';
import * as XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import { ExportField, EXPORT_FIELDS } from './dto/export-registrations.dto';
import { formatCpfByCountry } from '../../common/utils/locale.util';
import { isChargeback } from '../../common/utils/refund.util';
import { DEFAULT_NO_INTEREST_VARIATION_NAME } from '../products/product.constants';

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
  modalidade: 'Modalidade',
  produtosEscolhidos: 'Produtos escolhidos',
  perguntasRespostas: 'Perguntas e respostas',
  dataPagamento: 'Data da compra',
  status: 'Status da compra',
  formaPagamento: 'Forma de pagamento',
  valorPago: 'Valor pago por ingresso',
};

function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso as string);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR');
}

/**
 * Data + hora de um INSTANTE REAL (data da compra = criação do pedido) no fuso de
 * BRASÍLIA (America/Sao_Paulo). ESPELHA o que o organizador vê no modal
 * (`formatDateBRT - formatTimeBRT`), ex.: "15/06/2026 - 22:03".
 *
 * `toLocaleDateString` sem `timeZone` usava o fuso do servidor (UTC em prod) e
 * ainda omitia a hora → data de dia errado perto da meia-noite e sem horário.
 * `Intl` com `timeZone` fixo resolve o instante corretamente em BRT.
 */
function formatPurchaseInstantBRT(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso as string);
  if (isNaN(d.getTime())) return '';
  const date = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  }).format(d);
  const time = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Sao_Paulo',
  }).format(d);
  return `${date} - ${time}`;
}

function formatCurrency(cents: number | null | undefined): string {
  if (cents == null) return '';
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Status exibido no export — ESPELHA a lista de inscrições (RegistrationRow):
 * Pago / Cancelado / Estornado / Chargeback / Pendente. Estorno e chargeback rebaixam a
 * inscrição p/ CANCELLED e marcam o Payment como REFUNDED; o tipo (REFUND vs CHARGEBACK)
 * vem do metadata (via `isChargeback`). Por isso NÃO basta o `registration.status`.
 */
function formatStatus(reg: any): string {
  const payment = reg.order?.payment ?? {};
  const pStatus: string | undefined = payment.status;
  if (pStatus === 'REFUNDED' || reg.status === 'REFUNDED' || reg.status === 'CHARGEBACK') {
    return isChargeback(payment.metadata) || reg.status === 'CHARGEBACK'
      ? 'Chargeback'
      : 'Estornado';
  }
  // Estado TERMINAL da inscrição tem precedência sobre o status do pagamento:
  // pedido GRATUITO cancelado mantém Payment.status=PAID (não há CANCELLED no
  // enum de pagamento), então sem este check o export mostrava "Pago" para uma
  // inscrição cancelada. Espelha a precedência da lista (RegistrationRow).
  if (reg.status === 'CANCELLED') return 'Cancelado';
  if (reg.status === 'CONFIRMED' || reg.status === 'COMPLETED' || pStatus === 'PAID') {
    return 'Pago';
  }
  if (pStatus === 'FAILED') return 'Cancelado';
  return 'Pendente';
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

/**
 * Formata a resposta de uma pergunta para o export. Múltipla escolha/seleção é
 * persistida como array JSON serializado (ex.: `["Teste aqui"]`, `["A","B"]`);
 * juntamos os valores escolhidos com vírgula. Texto cru passa direto. Espelha
 * `frontend/src/utils/questionAnswer.ts` (mas célula vazia = '' em vez de "—").
 */
function formatAnswer(answer: unknown): string {
  if (answer == null) return '';
  if (Array.isArray(answer)) return answer.join(', ');
  if (typeof answer === 'string') {
    const s = answer.trim();
    if (!s) return '';
    try {
      const parsed: unknown = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.join(', ');
    } catch {
      /* não é JSON — usa a string crua */
    }
    return s;
  }
  return String(answer);
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
      // Prefere o SNAPSHOT do ingresso (gravado na compra — preserva nome/categoria
      // mesmo após rename/exclusão do ingresso) e cai na relação VIVA como fallback
      // (legados sem snapshot). Mesma precedência da lista de inscrições.
      const labelFor = (rt: any): string => {
        const snap = rt?.ticketSnapshot ?? null;
        const live = rt?.ticket ?? null;
        if (!snap && !live) return '';
        const name = removerCorrida(snap?.name ?? live?.name ?? '');
        const categoryName = removerCorrida(
          snap?.category?.name ?? live?.category?.name ?? snap?.modality ?? live?.modality ?? '',
        );
        if (categoryName && name && categoryName !== name) {
          return `${categoryName} - ${name}`;
        }
        return name || categoryName;
      };
      // A inscrição tem os ingressos em `tickets` (RegistrationTicket[]). O código
      // lia `reg.ticket` (singular), que NÃO existe no include → coluna vazia.
      // Agora AGREGA os ingressos da inscrição (1 por participante no caso comum;
      // junta com "; " se houver mais de um).
      const regTickets = Array.isArray(reg.tickets) ? reg.tickets : [];
      const labels = regTickets
        .map((rt: any) => labelFor(rt))
        .filter((s: string) => s.length > 0);
      return labels.join('; ');
    }
    case 'modalidade': {
      // Modalidade + distância do ingresso (ex.: "Corrida 5KM"). `ticket.modality`
      // guarda o LABEL do template (não id) — ver TicketForm ao salvar; `distance`
      // é numérico e `distanceUnit` é "KM"/"M". Prefere o SNAPSHOT (preserva o valor
      // da compra após rename/exclusão) e cai na relação VIVA como fallback (legados).
      // Mesma precedência do campo "ingresso".
      const regTickets = Array.isArray(reg.tickets) ? reg.tickets : [];
      const modalidades = regTickets
        .map((rt: any) => {
          const snap = rt?.ticketSnapshot ?? null;
          const live = rt?.ticket ?? null;
          const modality = String(snap?.modality ?? live?.modality ?? '').trim();
          const distanceRaw = snap?.distance ?? live?.distance ?? null;
          const unit = String(snap?.distanceUnit ?? live?.distanceUnit ?? '').trim();
          // Distância só entra se houver valor (>0); unidade é opcional (default vazio).
          const distanceStr =
            distanceRaw != null && String(distanceRaw).trim() !== '' && Number(distanceRaw) !== 0
              ? `${String(distanceRaw).trim()}${unit}`
              : '';
          return [modality, distanceStr].filter(Boolean).join(' ');
        })
        .filter((s: string) => s.length > 0);
      // Dedup preservando ordem: no caso comum há 1 modalidade por inscrição, mas
      // inscrições multi-ingresso não devem repetir a mesma modalidade/distância.
      return Array.from(new Set(modalidades)).join('; ');
    }
    case 'produtosEscolhidos': {
      const products: any[] = reg.products ?? [];
      return products
        .map((p: any) => {
          const name = p.product?.name ?? '';
          const variation = p.variationName ?? p.variation?.name ?? '';
          // "Sem interesse" = opt-out de produto opcional → NÃO listar (mesma
          // convenção do PDF do comprovante/ingresso e do orders.service).
          if (variation === DEFAULT_NO_INTEREST_VARIATION_NAME) return '';
          return variation ? `${name} (${variation})` : name;
        })
        .filter(Boolean)
        .join('; ');
    }
    case 'perguntasRespostas': {
      const qas: any[] = reg.questionAnswers ?? [];
      return qas
        .filter((qa: any) => qa.question?.isActive !== false) // exclui perguntas soft-deletadas
        .map((qa: any) => `${qa.question?.question ?? ''}: ${formatAnswer(qa.answer)}`)
        .join(' | ');
    }
    case 'dataPagamento':
      // Data da compra = criação do pedido, em BRT com hora (igual ao modal do organizador).
      return formatPurchaseInstantBRT(order.purchaseDate);
    case 'status':
      return formatStatus(reg);
    case 'formaPagamento':
      // Pedido gratuito (total cobrado = 0) não tem forma de pagamento real: o
      // gateway pode ter registrado PIX/cartão no fluxo, mas nada foi cobrado.
      // Exibe "Gratuito" (espelha o modal, que esconde o método em pedido grátis).
      if (order.finalAmount === 0) return 'Gratuito';
      return formatPaymentMethod(payment.method);
    case 'valorPago':
      // Valor pago POR INGRESSO desta inscrição: ingresso + produtos adicionais −
      // cupom/voucher rateado, SEM taxa de serviço (reproduz o recibo). Calculado
      // no service (computeRegistrationPaidValues); fallback ao total do pedido só
      // se ausente (dado legado). 0 (grátis) é preservado.
      return formatCurrency(
        order.paidPerTicket != null ? order.paidPerTicket : order.finalAmount,
      );
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
      if (qa.question?.isActive === false) continue; // pergunta soft-deletada não vira coluna
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
/**
 * ID curto no MESMO formato dos painéis/telas (`utils/shortId.formatShortId`):
 * `#` + PRIMEIRO segmento do UUID (os 8 chars hex antes do primeiro "-").
 * Ex.: "41d2aba8-...." -> "#41d2aba8". Sem "-" (id curto/legado) → o id inteiro.
 */
function formatShortRegistrationId(id: string | null | undefined): string {
  if (!id) return '';
  const first = String(id).split('-')[0] || String(id);
  return `#${first}`;
}

/**
 * Achata o valor numa ÚNICA linha: quebras de linha/tab embutidas (ex.: resposta de
 * pergunta com Enter, endereço multilinha) viravam células de 2 linhas no Excel/CSV e
 * forçavam line-break no PDF. Normaliza p/ espaço e colapsa espaços repetidos.
 */
function oneLine(value: string): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function buildExpandedRows(
  registrations: any[],
  fields: ExportField[],
): { headers: string[]; rows: string[][] } {
  const hasPR = fields.includes('perguntasRespostas');
  const allQuestions = hasPR ? collectAllQuestions(registrations) : [];

  // Coluna fixa de ID (sempre 1ª), no mesmo formato curto da lista de inscrições.
  const headers: string[] = ['ID inscrição'];
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
    const row: string[] = [formatShortRegistrationId(reg.id)];
    for (const f of fields) {
      if (f === 'perguntasRespostas') {
        if (allQuestions.length === 0) {
          row.push('');
        } else {
          const answerMap = new Map<string, string>();
          for (const qa of (reg.questionAnswers ?? [])) {
            if (qa.question?.isActive === false) continue; // ignora resposta de pergunta deletada
            const q: string = qa.question?.question ?? '';
            if (q) answerMap.set(q, formatAnswer(qa.answer));
          }
          for (const q of allQuestions) {
            row.push(oneLine(answerMap.get(q) ?? ''));
          }
        }
      } else {
        row.push(oneLine(extractField(reg, f)));
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
