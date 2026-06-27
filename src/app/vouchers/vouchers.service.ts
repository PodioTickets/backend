import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateVoucherDto,
  UpdateVoucherDto,
  FilterVouchersDto,
  VoucherStatus,
} from './dto/create-voucher.dto';
import { buildDocumentList } from '../../common/utils/document.util';
import { brtDayEndUtc } from '../../common/utils/brt-date.util';

@Injectable()
export class VouchersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, eventId: string, createVoucherDto: CreateVoucherDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Validar campos específicos
    this.validateVoucherData(createVoucherDto);

    // Converter appliesTo array para JSON string se necessário
    let appliesToValue: string | null = null;
    if (createVoucherDto.appliesTo) {
      if (Array.isArray(createVoucherDto.appliesTo)) {
        appliesToValue = JSON.stringify(createVoucherDto.appliesTo);
      } else {
        appliesToValue = createVoucherDto.appliesTo;
      }
    }

    // Converter expiryDate para Date se fornecido
    let expiryDateValue: Date | null = null;
    if (createVoucherDto.expiryDate) {
      expiryDateValue = this.parseDate(createVoucherDto.expiryDate);
    }

    // Verificar se os vouchers estão expirados
    let status = VoucherStatus.ACTIVE;
    if (expiryDateValue && expiryDateValue < new Date()) {
      status = VoucherStatus.EXPIRED;
    }

    // Gerar códigos únicos para cada voucher
    const codes = await this.generateUniqueCodes(eventId, createVoucherDto.quantity);

    // Dual-write da lista de documentos elegíveis (ver Coupon).
    const documentListValue = buildDocumentList({
      documentList: createVoucherDto.documentList,
      cpfList: createVoucherDto.cpfList,
    });

    // Criar múltiplos vouchers em lote
    const vouchers = await prismaWrite.voucher.createMany({
      data: codes.map((code) => ({
        name: createVoucherDto.name,
        code,
        eventId,
        appliesTo: appliesToValue,
        expiryDate: expiryDateValue,
        cpfList: createVoucherDto.cpfList ? (createVoucherDto.cpfList as any) : null,
        documentList: (documentListValue as any) ?? null,
        cpfListStatus: createVoucherDto.cpfListStatus || 'DISABLED',
        applyToProducts: createVoucherDto.applyToProducts ?? false,
        status,
      })),
    });

    // Buscar os vouchers criados para retornar
    const createdVouchers = await prismaRead.voucher.findMany({
      where: {
        eventId,
        code: { in: codes },
      },
      orderBy: { createdAt: 'desc' },
      take: createVoucherDto.quantity,
    });

    // Converter appliesTo de JSON string para array quando necessário
    const transformedVouchers = createdVouchers.map((voucher) => ({
      ...voucher,
      appliesTo: this.parseAppliesTo(voucher.appliesTo),
    }));

    return {
      message: `${createVoucherDto.quantity} voucher(s) created successfully`,
      data: { vouchers: transformedVouchers },
    };
  }

  async findAll(eventId: string, filterDto: FilterVouchersDto = {}) {
    const prismaRead = this.prisma.getReadClient();

    const page = filterDto.page || 1;
    const limit = filterDto.limit || 20;
    const skip = (page - 1) * limit;
    const statusFilter = filterDto.status ?? null;

    // Agrupamento e paginação no Postgres em vez de carregar tudo e agrupar em JS.
    // Usa COUNT FILTER pra contar cada status num único scan da tabela.
    // Quando statusFilter é passado, filtra os vouchers antes do GROUP BY (semântica
    // mantida do código anterior: groups sem voucher daquele status não aparecem,
    // e contagens de outros statuses ficam zeradas — comportamento legado).
    //
    // REPRESENTANTE DO GRUPO: vouchers USED são congelados (imutáveis p/ auditoria) e
    // NÃO recebem a propagação de edições do lote. Se a config viesse do voucher mais
    // antigo e ele já tivesse sido usado, o grupo exibiria a config ANTIGA pra sempre.
    // Por isso a config/representante vem do voucher mais antigo NÃO-usado (boolean
    // ordena false < true); fallback: o mais antigo, quando todos já foram usados.
    type GroupRow = {
      name: string;
      representativeId: string;
      eventId: string;
      appliesTo: string | null;
      expiryDate: Date | null;
      cpfListStatus: string;
      cpfList: Prisma.JsonValue | null;
      applyToProducts: boolean;
      totalCount: number;
      activeCount: number;
      usedCount: number;
      expiredCount: number;
      inactiveCount: number;
      firstCreatedAt: Date;
      lastUpdatedAt: Date;
    };

    const eventIdParam = Prisma.sql`${eventId}::uuid`;
    const statusCondition = statusFilter
      ? Prisma.sql`AND status::text = ${statusFilter}`
      : Prisma.empty;

    const [groupRows, totalRows] = await Promise.all([
      prismaRead.$queryRaw<GroupRow[]>(Prisma.sql`
        SELECT
          name,
          (array_agg(id ORDER BY (status::text = 'USED') ASC, "createdAt" ASC))[1]::text       AS "representativeId",
          "eventId",
          (array_agg("appliesTo" ORDER BY (status::text = 'USED') ASC, "createdAt" ASC))[1]    AS "appliesTo",
          (array_agg("expiryDate" ORDER BY (status::text = 'USED') ASC, "createdAt" ASC))[1]   AS "expiryDate",
          (array_agg("cpfListStatus" ORDER BY (status::text = 'USED') ASC, "createdAt" ASC))[1]::text AS "cpfListStatus",
          (array_agg("cpfList" ORDER BY (status::text = 'USED') ASC, "createdAt" ASC))[1]      AS "cpfList",
          (array_agg("applyToProducts" ORDER BY (status::text = 'USED') ASC, "createdAt" ASC))[1] AS "applyToProducts",
          COUNT(*)::int                                           AS "totalCount",
          COUNT(*) FILTER (WHERE status::text = 'ACTIVE')::int    AS "activeCount",
          COUNT(*) FILTER (WHERE status::text = 'USED')::int      AS "usedCount",
          COUNT(*) FILTER (WHERE status::text = 'EXPIRED')::int   AS "expiredCount",
          COUNT(*) FILTER (WHERE status::text = 'INACTIVE')::int  AS "inactiveCount",
          MIN("createdAt") AS "firstCreatedAt",
          MAX("updatedAt") AS "lastUpdatedAt"
        FROM "Voucher"
        WHERE "eventId" = ${eventIdParam} AND "deletedAt" IS NULL
        ${statusCondition}
        GROUP BY name, "eventId"
        ORDER BY MIN("createdAt") DESC
        LIMIT ${limit} OFFSET ${skip}
      `),
      prismaRead.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT COUNT(DISTINCT name)::bigint AS count
        FROM "Voucher"
        WHERE "eventId" = ${eventIdParam} AND "deletedAt" IS NULL
        ${statusCondition}
      `),
    ]);

    const total = Number(totalRows[0]?.count ?? 0);

    const groups = groupRows.map((r) => ({
      id: r.representativeId,
      name: r.name,
      eventId: r.eventId,
      appliesTo: this.parseAppliesTo(r.appliesTo),
      expiryDate: r.expiryDate,
      cpfListStatus: r.cpfListStatus,
      cpfList: r.cpfList,
      applyToProducts: r.applyToProducts ?? false,
      totalCount: r.totalCount,
      activeCount: r.activeCount,
      usedCount: r.usedCount,
      expiredCount: r.expiredCount,
      inactiveCount: r.inactiveCount,
      createdAt: r.firstCreatedAt,
      updatedAt: r.lastUpdatedAt,
    }));

    const totalPages = Math.ceil(total / limit) || 0;

    return {
      message: 'Voucher groups fetched successfully',
      data: {
        groups,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      },
    };
  }

  async findGroupVouchers(eventId: string, groupName: string, filterDto: FilterVouchersDto = {}) {
    const prismaRead = this.prisma.getReadClient();

    const page = filterDto.page || 1;
    const limit = filterDto.limit || 20;
    const skip = (page - 1) * limit;

    const baseWhere = { eventId, name: groupName, deletedAt: null };
    const filteredWhere: any = { ...baseWhere };
    if (filterDto.status) {
      filteredWhere.status = filterDto.status;
    }

    // Busca em paralelo: lista paginada (com filtro) + todos do grupo (sem filtro, para stats)
    const [vouchers, total, allGroupVouchers] = await Promise.all([
      prismaRead.voucher.findMany({
        where: filteredWhere,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prismaRead.voucher.count({ where: filteredWhere }),
      prismaRead.voucher.findMany({
        where: baseWhere,
        select: { id: true, status: true, expiryDate: true, createdAt: true, appliesTo: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const now = new Date();
    // Config do grupo vem do voucher mais antigo NÃO-usado: vouchers USED são congelados
    // (não recebem propagação de edições do lote) — usar um deles como referência exibiria
    // a config antiga pra sempre. Fallback: o mais antigo, quando todos já foram usados.
    const firstVoucher =
      allGroupVouchers.find((v) => v.status !== 'USED') ?? allGroupVouchers[0];
    const groupExpiryDate = firstVoucher?.expiryDate ?? null;

    // Estatísticas do grupo completo (independente do filtro de status)
    const groupStats = allGroupVouchers.reduce(
      (acc, v) => {
        acc.totalCount++;
        const expiryDate = v.expiryDate ?? groupExpiryDate;
        const effectivelyExpired = v.status === 'ACTIVE' && expiryDate != null && expiryDate < now;
        if (v.status === 'ACTIVE' && !effectivelyExpired) acc.availableCount++;
        else if (v.status === 'USED') acc.usedCount++;
        else if (v.status === 'EXPIRED' || effectivelyExpired) acc.expiredCount++;
        else if (v.status === 'INACTIVE') acc.inactiveCount++;
        return acc;
      },
      { totalCount: 0, availableCount: 0, usedCount: 0, expiredCount: 0, inactiveCount: 0 },
    );

    const groupStatus =
      groupStats.availableCount > 0 ? 'ACTIVE'
      : groupStats.usedCount > 0 ? 'USED'
      : groupStats.expiredCount > 0 ? 'EXPIRED'
      : 'INACTIVE';

    const parsedAppliesTo = this.parseAppliesTo(firstVoucher?.appliesTo ?? null);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rawTicketId = Array.isArray(parsedAppliesTo) ? (parsedAppliesTo[0] ?? null) : (parsedAppliesTo ?? null);
    const linkedTicketId: string | null = rawTicketId && uuidRegex.test(rawTicketId) ? rawTicketId : null;
    let linkedTicket: { id: string; name: string; category: { id: string; name: string } | null; price: number | null } | null = null;
    if (linkedTicketId) {
      const ticket = await prismaRead.ticket.findUnique({
        where: { id: linkedTicketId },
        select: {
          id: true,
          name: true,
          category: { select: { id: true, name: true } },
          batches: {
            select: { id: true, price: true, quantity: true, availableQuantity: true, startDate: true, endDate: true, sortOrder: true, triggerType: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
      });
      if (ticket) {
        const batchIds = ticket.batches.map((b) => b.id);
        const soldRows = batchIds.length > 0
          ? await prismaRead.registrationTicket.groupBy({
              by: ['batchId'],
              where: { batchId: { in: batchIds }, registration: { status: { not: 'CANCELLED' } } },
              _count: { id: true },
            })
          : [];
        const soldMap = new Map(soldRows.map((s) => [s.batchId, s._count.id]));
        const batchesWithSold = ticket.batches.map((b) => ({ ...b, quantitySold: soldMap.get(b.id) ?? 0 }));
        const activePrice = this.resolveActiveBatchPrice(batchesWithSold);
        linkedTicket = {
          id: ticket.id,
          name: ticket.name,
          category: ticket.category ?? null,
          price: activePrice,
        };
      }
    }

    const groupSummary = {
      name: groupName,
      status: groupStatus,
      expiryDate: firstVoucher?.expiryDate ?? null,
      linkedTicket,
      ...groupStats,
    };

    const transformedVouchers = vouchers.map((voucher) => ({
      ...voucher,
      appliesTo: this.parseAppliesTo(voucher.appliesTo),
    }));

    const totalPages = Math.ceil(total / limit);

    return {
      message: 'Group vouchers fetched successfully',
      data: {
        group: groupSummary,
        vouchers: transformedVouchers,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      },
    };
  }

  async findOne(id: string) {
    const prismaRead = this.prisma.getReadClient();
    const voucher = await prismaRead.voucher.findUnique({
      where: { id },
      include: {
        event: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!voucher) {
      throw new NotFoundException('Voucher not found');
    }

    // Converter appliesTo de JSON string para array quando necessário
    const transformedVoucher = {
      ...voucher,
      appliesTo: this.parseAppliesTo(voucher.appliesTo),
    };

    return {
      message: 'Voucher fetched successfully',
      data: { voucher: transformedVoucher },
    };
  }

  async findByCode(code: string) {
    const prismaRead = this.prisma.getReadClient();
    const voucher = await prismaRead.voucher.findUnique({
      where: { code },
      include: {
        event: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!voucher) {
      throw new NotFoundException('Voucher not found');
    }

    // Converter appliesTo de JSON string para array quando necessário
    const transformedVoucher = {
      ...voucher,
      appliesTo: this.parseAppliesTo(voucher.appliesTo),
    };

    return {
      message: 'Voucher fetched successfully',
      data: { voucher: transformedVoucher },
    };
  }

  async update(userId: string, eventId: string, voucherId: string, updateVoucherDto: UpdateVoucherDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const voucher = await prismaWrite.voucher.findUnique({
      where: { id: voucherId },
    });

    if (!voucher || voucher.eventId !== eventId) {
      throw new NotFoundException('Voucher not found');
    }

    // Vouchers USED são imutáveis individualmente. Mas editar a CONFIG DO LOTE através de um
    // voucher já usado É permitido: não tocamos na linha usada (congelada) e aplicamos os campos
    // de grupo aos vouchers ACTIVE do lote (a propagação abaixo já exclui os USED). Só barramos
    // se NÃO houver nenhum voucher editável — aí não há o que alterar.
    const isUsedTarget = voucher.status === VoucherStatus.USED;
    if (isUsedTarget) {
      const editableSiblings = await prismaWrite.voucher.count({
        where: { eventId, name: voucher.name, deletedAt: null, status: { not: VoucherStatus.USED } },
      });
      if (editableSiblings === 0) {
        throw new BadRequestException('Todos os vouchers deste lote já foram utilizados — não há o que editar.');
      }
    }

    // Validar campos específicos
    if (updateVoucherDto.name || updateVoucherDto.appliesTo || updateVoucherDto.expiryDate) {
      const mergedData = { ...voucher, ...updateVoucherDto };
      this.validateVoucherData(mergedData as any);
    }

    const updateData: any = { ...updateVoucherDto };
    if (updateVoucherDto.appliesTo !== undefined) {
      if (Array.isArray(updateVoucherDto.appliesTo)) {
        updateData.appliesTo = JSON.stringify(updateVoucherDto.appliesTo);
      } else {
        updateData.appliesTo = updateVoucherDto.appliesTo;
      }
    }
    // Sincroniza documentList canônico quando cpfList OU documentList mudam
    // (ver Coupon.update — mesma estratégia de dual-write).
    // IMPORTANTE: a canônica é derivada APENAS do que veio no update — nunca do
    // documentList VELHO do banco. Antes, um update só-de-cpfList (front atual é
    // cliente legado) mantinha a canônica antiga (`buildDocumentList` prefere
    // documentList) → listas divergentes, e o checkout (que valida pela canônica)
    // considerava o CPF NOVO inelegível — o voucher "cobria" o slot errado.
    if (updateVoucherDto.cpfList !== undefined || updateVoucherDto.documentList !== undefined) {
      const merged = buildDocumentList({
        documentList: updateVoucherDto.documentList ?? null,
        cpfList: updateVoucherDto.cpfList ?? null,
      });
      updateData.documentList = (merged as any) ?? null;
      if (updateVoucherDto.cpfList !== undefined) {
        updateData.cpfList = updateVoucherDto.cpfList as any;
      }
    } else {
      delete updateData.documentList;
    }

    // Converter expiryDate para Date se fornecido
    if (updateVoucherDto.expiryDate !== undefined) {
      updateData.expiryDate = updateVoucherDto.expiryDate ? this.parseDate(updateVoucherDto.expiryDate) : null;
    }

    // Atualizar status se necessário
    let status = updateVoucherDto.status || voucher.status;
    if (updateData.expiryDate !== undefined) {
      const expiryDate = updateData.expiryDate || voucher.expiryDate;
      if (expiryDate && expiryDate < new Date()) {
        status = VoucherStatus.EXPIRED;
      }
    }
    updateData.status = status;

    // A linha do voucher só é atualizada quando o alvo é editável (ACTIVE/EXPIRED/INACTIVE).
    // Se o alvo está USED, ele permanece congelado e só a config de grupo é propagada abaixo.
    let updatedVoucher = voucher;
    if (!isUsedTarget) {
      updatedVoucher = await prismaWrite.voucher.update({
        where: { id: voucherId },
        data: updateData,
      });
    }

    // Propagar configurações de grupo para todos os outros vouchers do mesmo lote.
    // cpfList, cpfListStatus, appliesTo e expiryDate são atributos do grupo inteiro —
    // não faz sentido que vouchers do mesmo lote tenham valores divergentes.
    const groupSyncData: Record<string, any> = {};
    if (updateVoucherDto.cpfListStatus !== undefined) groupSyncData.cpfListStatus = updateData.cpfListStatus;
    if (updateVoucherDto.cpfList !== undefined || 'cpfList' in updateVoucherDto) {
      groupSyncData.cpfList = updateData.cpfList ?? null;
    }
    // documentList faz parte do grupo (mesma semântica de cpfList).
    if (updateVoucherDto.documentList !== undefined || updateVoucherDto.cpfList !== undefined) {
      groupSyncData.documentList = updateData.documentList ?? null;
    }
    if (updateVoucherDto.appliesTo !== undefined) groupSyncData.appliesTo = updateData.appliesTo;
    if (updateVoucherDto.expiryDate !== undefined) groupSyncData.expiryDate = updateData.expiryDate;
    // applyToProducts é atributo do lote inteiro (como appliesTo) — propaga p/ todo o grupo.
    if (updateVoucherDto.applyToProducts !== undefined) groupSyncData.applyToProducts = updateVoucherDto.applyToProducts;

    if (Object.keys(groupSyncData).length > 0) {
      await prismaWrite.voucher.updateMany({
        where: {
          eventId,
          name: voucher.name,
          id: { not: voucherId },
          deletedAt: null,
          status: { not: VoucherStatus.USED }, // vouchers usados são imutáveis
        },
        data: groupSyncData,
      });
    }

    // Resposta: se o alvo estava USED, devolve um voucher ACTIVE do lote (já com a config nova
    // propagada) — o alvo usado seguiu congelado e não representaria a config atualizada.
    let representative = updatedVoucher;
    if (isUsedTarget) {
      const sibling = await prismaWrite.voucher.findFirst({
        where: { eventId, name: voucher.name, deletedAt: null, status: { not: VoucherStatus.USED } },
        orderBy: { createdAt: 'asc' },
      });
      if (sibling) representative = sibling;
    }

    // Converter appliesTo de JSON string para array quando necessário
    const transformedVoucher = {
      ...representative,
      appliesTo: this.parseAppliesTo(representative.appliesTo),
    };

    return {
      message: 'Voucher updated successfully',
      data: { voucher: transformedVoucher },
    };
  }

  async remove(userId: string, eventId: string, voucherId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    // Identificar o grupo pelo ID do voucher representante
    const representative = await prismaWrite.voucher.findUnique({
      where: { id: voucherId },
      select: { id: true, eventId: true, name: true },
    });

    if (!representative || representative.eventId !== eventId) {
      throw new NotFoundException('Voucher group not found');
    }

    // Carregar todos os vouchers do grupo
    const groupVouchers = await prismaWrite.voucher.findMany({
      where: { eventId, name: representative.name, deletedAt: null },
      select: { id: true, status: true },
    });

    if (groupVouchers.length === 0) {
      throw new NotFoundException('Voucher group not found');
    }

    const hasSales = groupVouchers.some((v) => v.status === VoucherStatus.USED);

    if (hasSales) {
      // Soft-delete: marca com deletedAt apenas os não usados (usados ficam para auditoria)
      await prismaWrite.voucher.updateMany({
        where: {
          eventId,
          name: representative.name,
          deletedAt: null,
          status: { not: VoucherStatus.USED },
        },
        data: { deletedAt: new Date() },
      });
    } else {
      // Hard-delete: nenhum voucher do grupo foi utilizado
      await prismaWrite.voucher.deleteMany({
        where: { eventId, name: representative.name, deletedAt: null },
      });
    }

    return {
      message: hasSales
        ? 'Voucher group soft-deleted (group has sales)'
        : 'Voucher group deleted successfully',
    };
  }

  private async generateUniqueCodes(eventId: string, quantity: number): Promise<string[]> {
    // Fix #39: usa write client para verificar unicidade — a réplica pode estar defasada
    // e retornar 'não encontrado' para um código recém-inserido, causando duplicatas.
    const prismaWrite = this.prisma.getWriteClient();
    const codes: string[] = [];
    const maxAttempts = 1000; // Limite de tentativas para evitar loop infinito

    for (let i = 0; i < quantity; i++) {
      let attempts = 0;
      let code: string;
      let isUnique = false;

      while (!isUnique && attempts < maxAttempts) {
        // Gerar código aleatório: 8 caracteres alfanuméricos maiúsculos
        code = this.generateRandomCode();

        // Verificar se o código já existe
        const existing = await prismaWrite.voucher.findUnique({
          where: {
            eventId_code: {
              eventId,
              code,
            },
          },
        });

        if (!existing) {
          isUnique = true;
          codes.push(code);
        } else {
          attempts++;
        }
      }

      if (!isUnique) {
        throw new BadRequestException(`Failed to generate unique code after ${maxAttempts} attempts`);
      }
    }

    return codes;
  }

  private generateRandomCode(): string {
    // Gera código de 8 caracteres: letras maiúsculas e números
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  private validateVoucherData(dto: CreateVoucherDto | UpdateVoucherDto) {
    // Aceita documentList (novo) OU cpfList (legacy) — pelo menos um precisa
    // estar preenchido quando a restrição de documento está habilitada.
    if (dto.cpfListStatus === 'ENABLED') {
      const hasCpf = Array.isArray(dto.cpfList) && dto.cpfList.length > 0;
      const hasDocList = Array.isArray((dto as any).documentList) && (dto as any).documentList.length > 0;
      if (!hasCpf && !hasDocList) {
        throw new BadRequestException('documentList ou cpfList é obrigatório quando cpfListStatus = ENABLED');
      }
    }

    if (dto.appliesTo !== undefined && dto.appliesTo !== null) {
      if (dto.appliesTo === 'all') {
        throw new BadRequestException('appliesTo must be a single ticket ID, not "all"');
      }
      if (Array.isArray(dto.appliesTo) && dto.appliesTo.length > 1) {
        throw new BadRequestException('appliesTo must be a single ticket ID');
      }
    }
  }

  private parseDate(dateString: string): Date {
    // Dia civil (YYYY-MM-DD) → FIM do dia em BRT (America/Sao_Paulo, UTC-3 fixo).
    // Fim do dia em UTC (T23:59:59Z) expirava o voucher às 20:59 BRT — 3h cedo —
    // rejeitando compras feitas ainda no mesmo dia no Brasil. brtDayEndUtc resolve
    // como (dia+1)T02:59:59.999Z = 23:59:59.999 BRT do dia escolhido.
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      return brtDayEndUtc(dateString);
    }

    // Caso contrário, tentar fazer parse direto
    return new Date(dateString);
  }

  private resolveActiveBatchPrice(
    batches: Array<{ id: string; price: number; quantity: number; availableQuantity: number; startDate: Date | null; endDate: Date | null; sortOrder: number; triggerType: string; quantitySold: number }>,
  ): number | null {
    if (batches.length === 0) return null;
    const sorted = [...batches].sort((a, b) => a.sortOrder - b.sortOrder);
    const now = new Date();
    let activeIdx = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[activeIdx];
      const curr = sorted[i];
      if (curr.triggerType === 'AFTER_PREVIOUS_SOLD_OUT') {
        if (prev.quantitySold >= prev.quantity) activeIdx = i;
      } else {
        if (curr.startDate && now >= curr.startDate) activeIdx = i;
      }
    }
    return sorted[activeIdx].price;
  }

  private parseAppliesTo(appliesTo: string | null): string | string[] | null {
    if (!appliesTo) {
      return null;
    }
    // Tentar fazer parse do JSON, se falhar retorna a string original
    try {
      const parsed = JSON.parse(appliesTo);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      return appliesTo;
    } catch {
      return appliesTo;
    }
  }

  private async verifyOrganizerAccess(userId: string, eventId: string) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Admin/staff bypassa checagens de organização
    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (user?.role === 'ADMIN' || user?.role === 'PODIOGO_STAFF') return;

    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    // Verificar se o usuário é membro da organização do evento
    const member = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: event.organizationId,
          userId,
        },
      },
    });

    if (!member) {
      throw new BadRequestException('Usuário não é membro da organização deste evento');
    }
  }
}
