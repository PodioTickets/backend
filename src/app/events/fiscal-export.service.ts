import {
  BadRequestException,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import PDFDocument from 'pdfkit';

import { PrismaService } from '../../prisma/prisma.service';
import { OrganizerMemberAccessService } from '../organizations/organizer-member-access.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  FISCAL_EXPORT_FIELD_LABELS,
  FISCAL_EXPORT_FIELDS,
  FiscalExportField,
  FiscalExportFormat,
  FiscalExportQueryDto,
  FiscalOrdersQueryDto,
  FiscalPeriod,
  FiscalValueRange,
} from './dto/fiscal-export.dto';

/**
 * Quantas linhas (sem contar header) a exportação aceita antes de retornar 413.
 * Spec: soft cap 100k. Acima disso, instruir refinar filtros.
 */
const FISCAL_EXPORT_SOFT_CAP = 100_000;

/** Limite de IDs explicitos por chamada de export — evita URL gigantesca e query lenta. */
const FISCAL_EXPORT_MAX_ORDER_IDS = 1_000;

/** Page-size cap para a listagem (igual ao @Max do DTO; reforço defensivo). */
const FISCAL_LIST_MAX_LIMIT = 50;

const PERIOD_DAYS: Record<FiscalPeriod, number | null> = {
  [FiscalPeriod.LAST_7D]: 7,
  [FiscalPeriod.LAST_15D]: 15,
  [FiscalPeriod.LAST_30D]: 30,
  [FiscalPeriod.LAST_60D]: 60,
  [FiscalPeriod.ALL]: null,
};

/** Faixas em centavos. `[min, max)` — `max=null` significa sem teto. */
const VALUE_RANGES: Record<FiscalValueRange, [number, number | null] | null> = {
  [FiscalValueRange.ALL]: null,
  [FiscalValueRange.LT_100]: [0, 10_000],
  [FiscalValueRange.RANGE_100_500]: [10_000, 50_000],
  [FiscalValueRange.RANGE_500_1000]: [50_000, 100_000],
  [FiscalValueRange.GT_1000]: [100_000, null],
};

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  [PaymentMethod.PIX]: 'PIX',
  [PaymentMethod.CREDIT_CARD]: 'Cartão de crédito',
  [PaymentMethod.DEBIT_CARD]: 'Cartão de débito',
  [PaymentMethod.BOLETO]: 'Boleto',
  [PaymentMethod.CRYPTO]: 'Cripto',
};

/**
 * `displayId` é derivado do UUID — determinístico, sem migration nem sequence.
 * 5 dígitos numéricos a partir dos primeiros 8 hex chars (32 bits → mod 100000).
 * Probabilidade de colisão dentro de um evento é muito baixa; se precisar zero
 * colisão no futuro, basta substituir aqui sem mexer no contrato.
 */
export function buildFiscalDisplayId(orderId: string): string {
  const hex = orderId.replace(/-/g, '').slice(0, 8);
  const num = Number.parseInt(hex, 16);
  if (!Number.isFinite(num)) return '00000';
  return String(num % 100_000).padStart(5, '0');
}

@Injectable()
export class FiscalExportService {
  private readonly logger = new Logger(FiscalExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizerMemberAccess: OrganizerMemberAccessService,
    private readonly organizationsService: OrganizationsService,
  ) {}

  // ─── Endpoint 1: listagem ─────────────────────────────────────────────────

  async getFiscalOrders(
    userId: string,
    eventId: string,
    queryDto: FiscalOrdersQueryDto,
  ) {
    await this.organizerMemberAccess.assertCanAccessEvent(userId, eventId, 'financial');

    const page = queryDto.page ?? 1;
    const limit = Math.min(queryDto.limit ?? 10, FISCAL_LIST_MAX_LIMIT);
    const period = queryDto.period ?? FiscalPeriod.LAST_30D;
    const valueRange = queryDto.valueRange ?? FiscalValueRange.ALL;

    const where = this.buildOrderWhere({
      eventId,
      period,
      valueRange,
      search: queryDto.search,
    });

    const prismaRead = this.prisma.getReadClient();
    const [total, orders] = await Promise.all([
      prismaRead.order.count({ where }),
      prismaRead.order.findMany({
        where,
        select: {
          id: true,
          finalAmount: true,
          createdAt: true,
          user: {
            select: {
              firstName: true,
              lastName: true,
              documentNumberClean: true,
              avatarUrl: true,
            },
          },
          payment: {
            select: { paymentDate: true },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const mapped = orders.map((o) => ({
      id: o.id,
      displayId: buildFiscalDisplayId(o.id),
      buyer: {
        name: `${o.user.firstName ?? ''} ${o.user.lastName ?? ''}`.trim(),
        cpf: o.user.documentNumberClean ?? '',
        avatarUrl: o.user.avatarUrl ?? null,
      },
      purchaseDate: (o.payment?.paymentDate ?? o.createdAt).toISOString(),
      amount: o.finalAmount,
    }));

    return {
      message: 'Fiscal orders fetched successfully',
      data: {
        orders: mapped,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      },
    };
  }

  // ─── Endpoint 2: exportação ───────────────────────────────────────────────

  async exportFiscalData(
    userId: string,
    eventId: string,
    queryDto: FiscalExportQueryDto,
    clientIp: string | null,
  ): Promise<{
    buffer: Buffer;
    contentType: string;
    extension: 'txt' | 'xlsx' | 'pdf';
    filename: string;
  }> {
    await this.organizerMemberAccess.assertCanAccessEvent(userId, eventId, 'financial');

    const format = queryDto.format ?? FiscalExportFormat.TXT;
    const selectedFields = this.resolveSelectedFields(queryDto.fields);

    const prismaRead = this.prisma.getReadClient();

    // Validação cedo do evento (para audit log + filename + cabeçalho do PDF).
    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        organizationId: true,
        organizerFeePercent: true,
      },
    });
    if (!event) {
      throw new BadRequestException('Evento não encontrado');
    }

    // Validação IDOR de `orderIds` antes de carregar dados completos.
    if (queryDto.orderIds && queryDto.orderIds.length > 0) {
      if (queryDto.orderIds.length > FISCAL_EXPORT_MAX_ORDER_IDS) {
        throw new BadRequestException(
          `orderIds excede o limite de ${FISCAL_EXPORT_MAX_ORDER_IDS}`,
        );
      }
      const found = await prismaRead.order.findMany({
        where: { id: { in: queryDto.orderIds }, eventId },
        select: { id: true },
      });
      if (found.length !== queryDto.orderIds.length) {
        // Não vazar quais IDs estão fora — IDOR defense in depth.
        throw new BadRequestException(
          'Um ou mais orderIds não pertencem ao evento informado',
        );
      }
    }

    const where = queryDto.orderIds && queryDto.orderIds.length > 0
      ? { id: { in: queryDto.orderIds }, eventId, status: OrderStatus.PAID }
      : this.buildOrderWhere({
        eventId,
        period: queryDto.period ?? FiscalPeriod.LAST_30D,
        valueRange: queryDto.valueRange ?? FiscalValueRange.ALL,
        search: queryDto.search,
      });

    const total = await prismaRead.order.count({ where });
    if (total > FISCAL_EXPORT_SOFT_CAP) {
      throw new PayloadTooLargeException(
        `Exportação excede o limite de ${FISCAL_EXPORT_SOFT_CAP} pedidos. Refine os filtros.`,
      );
    }

    // Carrega apenas o necessário para os campos selecionados — payload mínimo no DB.
    const orders = await prismaRead.order.findMany({
      where,
      select: this.buildOrderSelect(selectedFields),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const rows = orders.map((o) =>
      this.buildExportRow(o as any, selectedFields, event.organizerFeePercent ?? 0),
    );

    const headers = ['ID do pedido', ...selectedFields.map((f) => FISCAL_EXPORT_FIELD_LABELS[f])];

    const today = new Date().toISOString().slice(0, 10);
    const filenameBase = `dados-fiscais-${eventId}-${today}`;

    let buffer: Buffer;
    let contentType: string;
    let extension: 'txt' | 'xlsx' | 'pdf';

    if (format === FiscalExportFormat.XLSX) {
      buffer = this.renderXlsx(headers, rows);
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      extension = 'xlsx';
    } else if (format === FiscalExportFormat.PDF) {
      buffer = await this.renderPdf(event.name, headers, rows);
      contentType = 'application/pdf';
      extension = 'pdf';
    } else {
      buffer = this.renderTxtCsv(headers, rows);
      contentType = 'text/csv; charset=utf-8';
      extension = 'txt';
    }

    // Audit log fire-and-forget — falha não bloqueia o download.
    this.organizationsService
      .recordOrganizationAuditLog({
        organizationId: event.organizationId,
        actorUserId: userId,
        ip: clientIp,
        action: `Exportou dados fiscais do evento "${event.name}" (${total} pedidos, ${format.toUpperCase()})`,
        metadata: {
          kind: 'event.financial.fiscal_export',
          eventId: event.id,
          format,
          rowCount: total,
          fields: selectedFields,
          filters: {
            period: queryDto.period ?? FiscalPeriod.LAST_30D,
            valueRange: queryDto.valueRange ?? FiscalValueRange.ALL,
            hasSearch: !!queryDto.search,
            hasOrderIds: !!(queryDto.orderIds && queryDto.orderIds.length > 0),
          },
        },
      })
      .catch((err) => {
        this.logger.warn(`Failed to record fiscal export audit: ${err?.message ?? err}`);
      });

    return {
      buffer,
      contentType,
      extension,
      filename: `${filenameBase}.${extension}`,
    };
  }

  // ─── Filtros ──────────────────────────────────────────────────────────────

  private buildOrderWhere(params: {
    eventId: string;
    period: FiscalPeriod;
    valueRange: FiscalValueRange;
    search?: string;
  }): Prisma.OrderWhereInput {
    const { eventId, period, valueRange, search } = params;

    const where: Prisma.OrderWhereInput = {
      eventId,
      status: OrderStatus.PAID,
      payment: {
        // Inclui PAID e chargebacks (REFUNDED com refundType=CHARGEBACK; spec §2.74).
        // Refunds plenos (refundType=REFUND ou ausente) ficam de fora.
        OR: [
          { status: PaymentStatus.PAID },
          {
            status: PaymentStatus.REFUNDED,
            metadata: { path: ['refundType'], equals: 'CHARGEBACK' },
          },
        ],
      },
    };

    const days = PERIOD_DAYS[period];
    if (days !== null) {
      const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      // `paymentDate` é o proxy de paidAt — pode ser null em estados muito antigos;
      // a condição filtra naturalmente esses casos via `gte`.
      where.payment = {
        ...(where.payment as Prisma.PaymentWhereInput),
        paymentDate: { gte: start },
      };
    }

    const range = VALUE_RANGES[valueRange];
    if (range) {
      const [min, max] = range;
      where.finalAmount = max === null ? { gte: min } : { gte: min, lt: max };
    }

    if (search && search.trim().length > 0) {
      const term = search.trim();
      const cpfDigits = term.replace(/\D/g, '');
      const or: Prisma.OrderWhereInput[] = [
        // Nome do comprador — match em first/last/concatenação.
        { user: { firstName: { contains: term, mode: 'insensitive' } } },
        { user: { lastName: { contains: term, mode: 'insensitive' } } },
      ];
      if (cpfDigits.length >= 3) {
        or.push({ user: { documentNumberClean: { contains: cpfDigits } } });
      }
      // Busca por UUID completo (o front pode oferecer copy do `id` interno em
      // "Detalhes do pedido"). `id` é coluna UUID — Prisma não suporta
      // startsWith/contains nesse tipo, então aceitamos só match exato.
      // Busca por `displayId` (5 dígitos derivados) ficaria de fora; se virar
      // necessidade, exige coluna materializada + índice.
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRe.test(term)) {
        or.push({ id: term.toLowerCase() });
      }
      where.AND = [{ OR: or }];
    }

    return where;
  }

  // ─── Select por field selecionado ─────────────────────────────────────────

  private buildOrderSelect(fields: FiscalExportField[]): Prisma.OrderSelect {
    const needsUser = fields.some((f) =>
      ['name', 'email', 'cpf', 'birthDate', 'phone', 'gender', 'address'].includes(f),
    );
    // Payment é sempre necessário (status/refundType compõem o cálculo de fee/netAmount/status).
    const needsRegistrations = fields.includes('ticket');
    const needsProducts = fields.includes('products');

    return {
      id: true,
      finalAmount: true,
      totalAmount: true,
      serviceFee: true,
      createdAt: true,
      user: needsUser
        ? {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            documentNumber: true,
            documentNumberClean: true,
            dateOfBirth: true,
            phone: true,
            gender: true,
            country: true,
            state: true,
            city: true,
          },
        }
        : false,
      payment: {
        select: {
          status: true,
          method: true,
          paymentDate: true,
          metadata: true,
        },
      },
      // Endereço de cobrança vem do próprio Order (snapshot de checkout).
      billingCountry: true,
      billingPostalCode: true,
      billingStateUf: true,
      billingStreet: true,
      billingNumber: true,
      billingComplement: true,
      billingNeighborhood: true,
      billingCity: true,
      registrations: (needsRegistrations || needsProducts)
        ? {
          select: {
            tickets: needsRegistrations
              ? {
                select: {
                  ticketSnapshot: true,
                  ticket: { select: { name: true } },
                },
              }
              : false,
            products: needsProducts
              ? {
                select: {
                  quantity: true,
                  productSnapshot: true,
                  product: { select: { name: true } },
                  variation: { select: { name: true } },
                },
              }
              : false,
          },
        }
        : false,
    } as Prisma.OrderSelect;
  }

  // ─── Row builders ─────────────────────────────────────────────────────────

  private buildExportRow(
    order: any,
    fields: FiscalExportField[],
    organizerFeePercent: number,
  ): { id: string; cells: string[] } {
    const refundType = (order.payment?.metadata as any)?.refundType ?? null;

    const grossCents = order.finalAmount ?? 0;
    const participantFee = order.serviceFee ?? 0;
    const platformFeeCents = Math.round(
      Math.max(0, grossCents - participantFee) * (organizerFeePercent / 100),
    );
    const feeCents = participantFee + platformFeeCents;
    const netCents = grossCents - feeCents;

    const cells = fields.map((field) => {
      switch (field) {
        case 'name':
          return `${order.user?.firstName ?? ''} ${order.user?.lastName ?? ''}`.trim();
        case 'email':
          return order.user?.email ?? '';
        case 'cpf':
          return this.formatCpf(order.user?.documentNumberClean, order.user?.documentNumber);
        case 'birthDate':
          return this.formatDateBR(order.user?.dateOfBirth);
        case 'phone':
          return order.user?.phone ?? '';
        case 'gender':
          return this.translateGender(order.user?.gender);
        case 'address':
          return this.formatAddress(order);
        case 'ticket':
          return this.formatTickets(order);
        case 'products':
          return this.formatProducts(order);
        case 'paymentDate':
          return this.formatDateTimeBR(order.payment?.paymentDate ?? order.createdAt);
        case 'paymentMethod':
          return order.payment?.method
            ? PAYMENT_METHOD_LABELS[order.payment.method as PaymentMethod] ?? String(order.payment.method)
            : '';
        case 'amountPaid':
          return this.formatBRL(grossCents);
        case 'fee':
          return this.formatBRL(feeCents);
        case 'netAmount':
          return this.formatBRL(netCents);
        case 'status':
          return this.statusLabel(order.payment?.status, refundType);
        default:
          return '';
      }
    });

    return { id: `#${buildFiscalDisplayId(order.id)}`, cells };
  }

  // ─── Field helpers ────────────────────────────────────────────────────────

  private resolveSelectedFields(input: string[] | undefined): FiscalExportField[] {
    if (!input || input.length === 0) return [...FISCAL_EXPORT_FIELDS];
    const set = new Set<FiscalExportField>();
    for (const f of input) {
      if ((FISCAL_EXPORT_FIELDS as readonly string[]).includes(f)) {
        set.add(f as FiscalExportField);
      }
    }
    if (set.size === 0) return [...FISCAL_EXPORT_FIELDS];
    // Ordem canônica (FISCAL_EXPORT_FIELDS), não a ordem do input.
    return FISCAL_EXPORT_FIELDS.filter((f) => set.has(f));
  }

  private formatCpf(clean?: string | null, formatted?: string | null): string {
    if (clean && clean.length === 11) {
      return `${clean.slice(0, 3)}.${clean.slice(3, 6)}.${clean.slice(6, 9)}-${clean.slice(9, 11)}`;
    }
    return formatted ?? clean ?? '';
  }

  private formatDateBR(value?: Date | string | null): string {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  /** Converte UTC → America/Sao_Paulo (UTC-3, sem DST desde 2019). */
  private formatDateTimeBR(value?: Date | string | null): string {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const offsetMs = -3 * 60 * 60 * 1000;
    const local = new Date(d.getTime() + offsetMs);
    const dd = String(local.getUTCDate()).padStart(2, '0');
    const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = local.getUTCFullYear();
    const hh = String(local.getUTCHours()).padStart(2, '0');
    const mi = String(local.getUTCMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  }

  private formatBRL(cents: number): string {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const reais = Math.floor(abs / 100);
    const centavos = abs % 100;
    return `${sign}${reais.toLocaleString('pt-BR')},${String(centavos).padStart(2, '0')}`;
  }

  private translateGender(gender?: string | null): string {
    if (!gender) return '';
    const g = String(gender).toUpperCase();
    if (g === 'MALE') return 'Masculino';
    if (g === 'FEMALE') return 'Feminino';
    if (g === 'OTHER') return 'Outro';
    return String(gender);
  }

  private formatAddress(order: any): string {
    const parts: string[] = [];
    const street = order.billingStreet;
    const number = order.billingNumber;
    if (street) parts.push(number ? `${street}, ${number}` : street);
    if (order.billingComplement) parts.push(order.billingComplement);
    if (order.billingNeighborhood) parts.push(order.billingNeighborhood);
    const city = order.billingCity;
    const uf = order.billingStateUf;
    if (city || uf) parts.push([city, uf].filter(Boolean).join('/'));
    if (order.billingPostalCode) parts.push(`CEP ${order.billingPostalCode}`);
    return parts.join(', ');
  }

  private formatTickets(order: any): string {
    const names: string[] = [];
    for (const reg of order.registrations ?? []) {
      for (const t of reg.tickets ?? []) {
        const snapshotName = (t.ticketSnapshot as any)?.name as string | undefined;
        const name = snapshotName ?? t.ticket?.name;
        if (name) names.push(name);
      }
    }
    return names.join('; ');
  }

  private formatProducts(order: any): string {
    const items: string[] = [];
    for (const reg of order.registrations ?? []) {
      for (const p of reg.products ?? []) {
        const snapshot = p.productSnapshot as any;
        const productName = snapshot?.name ?? p.product?.name ?? '';
        const variationName = snapshot?.variationName ?? p.variation?.name ?? null;
        if (!productName) continue;
        const base = variationName ? `${productName} (${variationName})` : productName;
        items.push(p.quantity && p.quantity > 1 ? `${p.quantity}x ${base}` : base);
      }
    }
    return items.join('; ');
  }

  private statusLabel(paymentStatus: PaymentStatus | undefined, refundType: string | null): string {
    if (!paymentStatus) return '';
    if (paymentStatus === PaymentStatus.PAID) return 'Pago';
    if (paymentStatus === PaymentStatus.REFUNDED) {
      return refundType === 'CHARGEBACK' ? 'Chargeback' : 'Estornado';
    }
    if (paymentStatus === PaymentStatus.PENDING) return 'Pendente';
    if (paymentStatus === PaymentStatus.FAILED) return 'Falhou';
    return String(paymentStatus);
  }

  // ─── Renderers ────────────────────────────────────────────────────────────

  /**
   * TXT = CSV separado por vírgula (spec §3 atualizada). Inclui BOM UTF-8
   * para abrir corretamente no Excel pt-BR. Escape RFC 4180:
   * - se o campo contém `,`, `"` ou `\n`, envolver em `"..."`.
   * - `"` interno vira `""`.
   */
  private renderTxtCsv(headers: string[], rows: { id: string; cells: string[] }[]): Buffer {
    const escape = (v: string) => {
      if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
      return v;
    };
    const lines: string[] = [];
    lines.push(headers.map(escape).join(','));
    for (const r of rows) {
      lines.push([r.id, ...r.cells].map(escape).join(','));
    }
    return Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
  }

  private renderXlsx(headers: string[], rows: { id: string; cells: string[] }[]): Buffer {
    const aoa: string[][] = [headers];
    for (const r of rows) aoa.push([r.id, ...r.cells]);
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    // Largura das colunas — heurística simples baseada no maior valor por coluna.
    const colWidths = headers.map((h, idx) => {
      const maxData = rows.reduce((max, r) => {
        const v = idx === 0 ? r.id : r.cells[idx - 1] ?? '';
        return Math.max(max, v.length);
      }, h.length);
      return { wch: Math.min(48, Math.max(10, maxData + 2)) };
    });
    (sheet as any)['!cols'] = colWidths;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Dados fiscais');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  private async renderPdf(
    eventName: string,
    headers: string[],
    rows: { id: string; cells: string[] }[],
  ): Promise<Buffer> {
    return await new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 32 });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const exportedAt = new Date();
        const exportedAtLabel = this.formatDateTimeBR(exportedAt);

        doc.fontSize(14).text('Dados fiscais', { align: 'left' });
        doc.fontSize(10).fillColor('#555').text(`Evento: ${eventName}`);
        doc.text(`Exportado em: ${exportedAtLabel}`);
        doc.text(`Total de pedidos: ${rows.length}`);
        doc.moveDown(0.5);
        doc.fillColor('#000');

        // Para PDF, exibimos a tabela como pares "header: valor" por linha — A4 retrato não
        // comporta 15+ colunas legíveis. Mantém a leitura humana sem cortar dados.
        doc.fontSize(8);
        for (const r of rows) {
          if (doc.y > doc.page.height - 60) {
            doc.addPage();
          }
          doc.fontSize(9).fillColor('#000').text(`Pedido ${r.id}`, { underline: true });
          doc.fontSize(8).fillColor('#222');
          headers.slice(1).forEach((label, idx) => {
            const value = r.cells[idx] ?? '';
            if (value === '') return;
            doc.text(`${label}: ${value}`);
          });
          doc.moveDown(0.5);
        }

        if (rows.length === 0) {
          doc.fontSize(11).fillColor('#666').text('Nenhum pedido encontrado para os filtros aplicados.');
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}
