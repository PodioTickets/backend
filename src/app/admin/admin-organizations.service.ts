import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheRedisService } from '../../common/services/cache-redis.service';

@Injectable()
export class AdminOrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheRedisService,
  ) {}

  async getOrganizations(params: {
    page: number;
    limit: number;
    search?: string;
    isActive?: boolean;
  }) {
    const { page, limit, search, isActive } = params;
    const skip = (page - 1) * limit;

    const prismaRead = this.prisma.getReadClient();

    const where: any = {};
    if (isActive !== undefined) where.isActive = isActive;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { tradeName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { document: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [organizations, total] = await Promise.all([
      prismaRead.organization.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          tradeName: true,
          email: true,
          logoUrl: true,
          document: true,
          phone: true,
          city: true,
          state: true,
          isActive: true,
          createdAt: true,
          _count: {
            select: { events: true, members: true },
          },
        },
      }),
      prismaRead.organization.count({ where }),
    ]);

    return {
      message: 'Organizations fetched successfully',
      data: {
        organizations,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  async getOrganization(id: string) {
    const prismaRead = this.prisma.getReadClient();

    const organization = await prismaRead.organization.findUnique({
      where: { id },
      include: {
        members: {
          select: {
            id: true,
            role: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                avatarUrl: true,
                role: true,
                isActive: true,
              },
            },
          },
        },
        pixKeys: {
          select: {
            id: true,
            key: true,
            keyType: true,
            isDefault: true,
            bankName: true,
            accountHolderName: true,
            accountHolderDocument: true,
            createdAt: true,
          },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        },
        _count: {
          select: { events: true, members: true },
        },
      },
    });

    if (!organization) throw new NotFoundException('Organization not found');

    return {
      message: 'Organization fetched successfully',
      data: { organization },
    };
  }

  async updateOrganization(
    id: string,
    dto: UpdateOrganizationDto & { pixKeyType?: string; pix?: string; pixKeys?: { key: string; keyType: string; isDefault?: boolean; bankName?: string; accountHolderName?: string; accountHolderDocument?: string }[] },
  ) {
    const existing = await this.prisma.getReadClient().organization.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Organization not found');

    // Extrair campos que não pertencem ao model Organization
    const { pixKeyType: _pixKeyType, pix: _pix, pixKeys, ...data } = dto as any;

    const w = this.prisma.getWriteClient();

    const [updated] = await Promise.all([
      w.organization.update({
        where: { id },
        data,
        select: {
          id: true,
          name: true,
          tradeName: true,
          email: true,
          logoUrl: true,
          document: true,
          phone: true,
          whatsapp: true,
          siteUrl: true,
          instagram: true,
          description: true,
          zipCode: true,
          street: true,
          number: true,
          neighborhood: true,
          city: true,
          state: true,
          ownerName: true,
          bankName: true,
          bankCode: true,
          agency: true,
          account: true,
          accountType: true,
          accountHolderName: true,
          accountHolderDocument: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      // Substituição completa das chaves PIX quando enviadas
      pixKeys != null
        ? w.$transaction(async (tx: any) => {
            await tx.organizationPixKey.deleteMany({ where: { organizationId: id } });
            if ((pixKeys as any[]).length > 0) {
              // Garantir no máximo um isDefault=true
              const hasDefault = (pixKeys as any[]).some((k: any) => k.isDefault);
              await tx.organizationPixKey.createMany({
                data: (pixKeys as any[]).map((k: any, i: number) => ({
                  organizationId: id,
                  key: k.key,
                  keyType: k.keyType,
                  isDefault: hasDefault ? !!k.isDefault : i === 0,
                  bankName: k.bankName ?? null,
                  accountHolderName: k.accountHolderName ?? null,
                  accountHolderDocument: k.accountHolderDocument ?? null,
                })),
              });
            }
          })
        : Promise.resolve(),
    ]);

    const savedPixKeys = await this.prisma.getReadClient().organizationPixKey.findMany({
      where: { organizationId: id },
      select: { id: true, key: true, keyType: true, isDefault: true, bankName: true, accountHolderName: true, accountHolderDocument: true, createdAt: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    // Invalida cache de sessão dos organizadores quando a org é desativada
    if (data.isActive === false) {
      const members = await this.prisma.getReadClient().organizationMember.findMany({
        where: { organizationId: id },
        select: { userId: true },
      });
      const keys = members.map((m) => `organizer_active:${m.userId}`);
      if (keys.length > 0) await this.cache.del(keys);
    }

    return {
      message: 'Organization updated successfully',
      data: { organization: { ...updated, pixKeys: savedPixKeys } },
    };
  }

  async updateMember(
    organizationId: string,
    memberUserId: string,
    dto: { role?: string; permissions?: string[]; eventIds?: string[] },
  ) {
    const w = this.prisma.getWriteClient();
    const r = this.prisma.getReadClient();

    const member = await r.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: memberUserId } },
    });
    if (!member) throw new NotFoundException('Member not found');

    const data: any = {};
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.permissions !== undefined) data.permissions = dto.permissions;

    const updated = await w.organizationMember.update({
      where: { organizationId_userId: { organizationId, userId: memberUserId } },
      data,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
      },
    });

    if (dto.role === 'OWNER' || dto.role === 'MANAGER') {
      await w.user.update({
        where: { id: memberUserId },
        data: { role: 'ORGANIZER', accountType: 'ORGANIZER' },
      });
    }

    return { message: 'Member updated successfully', data: { member: updated } };
  }

  async getMember(organizationId: string, memberUserId: string) {
    const prismaRead = this.prisma.getReadClient();

    const row = await prismaRead.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: memberUserId } },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            lastLoginAt: true,
            mfaEnabled: true,
            isActive: true,
          },
        },
        eventAccesses: { select: { eventId: true } },
      },
    });

    if (!row) throw new NotFoundException('Member not found');

    return {
      message: 'Member retrieved successfully',
      data: { member: row },
    };
  }
}

export interface UpdateOrganizationDto {
  name?: string;
  tradeName?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  siteUrl?: string;
  instagram?: string;
  description?: string;
  zipCode?: string;
  street?: string;
  number?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  ownerName?: string;
  bankName?: string;
  bankCode?: string;
  agency?: string;
  account?: string;
  accountType?: string;
  accountHolderName?: string;
  accountHolderDocument?: string;
  isActive?: boolean;
}
