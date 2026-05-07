import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AdminOrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

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

  async updateOrganization(id: string, dto: UpdateOrganizationDto) {
    const existing = await this.prisma.getReadClient().organization.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Organization not found');

    const updated = await this.prisma.getWriteClient().organization.update({
      where: { id },
      data: dto,
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
        pix: true,
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
    });

    return {
      message: 'Organization updated successfully',
      data: { organization: updated },
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
  pix?: string;
  bankName?: string;
  bankCode?: string;
  agency?: string;
  account?: string;
  accountType?: string;
  accountHolderName?: string;
  accountHolderDocument?: string;
  isActive?: boolean;
}
