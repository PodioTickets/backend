import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateVoucherDto,
  UpdateVoucherDto,
  FilterVouchersDto,
  VoucherStatus,
} from './dto/create-voucher.dto';

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

    // Criar múltiplos vouchers em lote
    const vouchers = await prismaWrite.voucher.createMany({
      data: codes.map((code) => ({
        name: createVoucherDto.name,
        code,
        eventId,
        appliesTo: appliesToValue,
        expiryDate: expiryDateValue,
        cpfList: createVoucherDto.cpfList ? (createVoucherDto.cpfList as any) : null,
        cpfListStatus: createVoucherDto.cpfListStatus || 'DISABLED',
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

    const where: any = { eventId };
    if (filterDto.status) {
      where.status = filterDto.status;
    }

    // Buscar todos os vouchers para agrupar
    const allVouchers = await prismaRead.voucher.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    // Agrupar vouchers por nome
    const groupsMap = new Map<string, any>();
    
    allVouchers.forEach((voucher) => {
      const name = voucher.name;
      if (!groupsMap.has(name)) {
        groupsMap.set(name, {
          id: voucher.id, // id do voucher mais antigo do grupo (representante estável)
          name,
          eventId: voucher.eventId,
          appliesTo: this.parseAppliesTo(voucher.appliesTo),
          expiryDate: voucher.expiryDate,
          cpfListStatus: voucher.cpfListStatus,
          cpfList: voucher.cpfList,
          totalCount: 0,
          activeCount: 0,
          usedCount: 0,
          expiredCount: 0,
          inactiveCount: 0,
          createdAt: voucher.createdAt,
          updatedAt: voucher.updatedAt,
        });
      }

      const group = groupsMap.get(name);
      group.totalCount++;

      switch (voucher.status) {
        case 'ACTIVE':
          group.activeCount++;
          break;
        case 'USED':
          group.usedCount++;
          break;
        case 'EXPIRED':
          group.expiredCount++;
          break;
        case 'INACTIVE':
          group.inactiveCount++;
          break;
      }

      // Atualizar id e createdAt para o voucher mais antigo do grupo
      if (voucher.createdAt < group.createdAt) {
        group.createdAt = voucher.createdAt;
        group.id = voucher.id;
      }

      // Atualizar updatedAt para o mais recente
      if (voucher.updatedAt > group.updatedAt) {
        group.updatedAt = voucher.updatedAt;
      }
    });

    // Converter Map para Array e ordenar por data de criação (mais recente primeiro)
    const groups = Array.from(groupsMap.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // Aplicar paginação nos grupos
    const total = groups.length;
    const paginatedGroups = groups.slice(skip, skip + limit);
    const totalPages = Math.ceil(total / limit);

    return {
      message: 'Voucher groups fetched successfully',
      data: {
        groups: paginatedGroups,
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

    const baseWhere = { eventId, name: groupName };
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
        select: { id: true, status: true, expiryDate: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Estatísticas do grupo completo (independente do filtro de status)
    const groupStats = allGroupVouchers.reduce(
      (acc, v) => {
        acc.totalCount++;
        if (v.status === 'ACTIVE') acc.availableCount++;
        else if (v.status === 'USED') acc.usedCount++;
        else if (v.status === 'EXPIRED') acc.expiredCount++;
        else if (v.status === 'INACTIVE') acc.inactiveCount++;
        return acc;
      },
      { totalCount: 0, availableCount: 0, usedCount: 0, expiredCount: 0, inactiveCount: 0 },
    );

    const firstVoucher = allGroupVouchers[0];
    const groupStatus =
      groupStats.availableCount > 0 ? 'ACTIVE'
      : groupStats.usedCount > 0 ? 'USED'
      : groupStats.expiredCount > 0 ? 'EXPIRED'
      : 'INACTIVE';

    const groupSummary = {
      name: groupName,
      status: groupStatus,
      expiryDate: firstVoucher?.expiryDate ?? null,
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

    // Não permitir atualizar vouchers que já foram utilizados
    if (voucher.status === VoucherStatus.USED) {
      throw new BadRequestException('Cannot update voucher that has been used');
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
    if (updateVoucherDto.cpfList) {
      updateData.cpfList = updateVoucherDto.cpfList as any;
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

    const updatedVoucher = await prismaWrite.voucher.update({
      where: { id: voucherId },
      data: updateData,
    });

    // Converter appliesTo de JSON string para array quando necessário
    const transformedVoucher = {
      ...updatedVoucher,
      appliesTo: this.parseAppliesTo(updatedVoucher.appliesTo),
    };

    return {
      message: 'Voucher updated successfully',
      data: { voucher: transformedVoucher },
    };
  }

  async remove(userId: string, eventId: string, voucherId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const voucher = await prismaWrite.voucher.findUnique({
      where: { id: voucherId },
    });

    if (!voucher || voucher.eventId !== eventId) {
      throw new NotFoundException('Voucher not found');
    }

    // Não permitir deletar vouchers que já foram utilizados
    if (voucher.status === VoucherStatus.USED) {
      throw new BadRequestException('Cannot delete voucher that has been used');
    }

    await prismaWrite.voucher.delete({
      where: { id: voucherId },
    });

    return {
      message: 'Voucher deleted successfully',
    };
  }

  private async generateUniqueCodes(eventId: string, quantity: number): Promise<string[]> {
    const prismaRead = this.prisma.getReadClient();
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
        const existing = await prismaRead.voucher.findUnique({
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
    // Validar CPF list
    if (dto.cpfListStatus === 'ENABLED' && (!dto.cpfList || dto.cpfList.length === 0)) {
      throw new BadRequestException('cpfList is required when cpfListStatus is ENABLED');
    }
  }

  private parseDate(dateString: string): Date {
    // Se for apenas data (YYYY-MM-DD), adicionar hora para fim do dia
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      return new Date(`${dateString}T23:59:59.999Z`);
    }
    
    // Caso contrário, tentar fazer parse direto
    return new Date(dateString);
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

    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
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
      throw new BadRequestException('User is not a member of this event\'s organization');
    }
  }
}
