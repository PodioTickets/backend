import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCouponDto, UpdateCouponDto, FilterCouponsDto, CouponStatus } from './dto/create-coupon.dto';

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, eventId: string, createCouponDto: CreateCouponDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    // Validar campos específicos por tipo
    this.validateCouponData(createCouponDto);

    // Verificar se o código já existe para este evento (apenas se fornecido)
    if (createCouponDto.code) {
      const existingCoupon = await prismaWrite.coupon.findUnique({
        where: {
          eventId_code: {
            eventId,
            code: createCouponDto.code.toUpperCase(),
          },
        },
      });

      if (existingCoupon) {
        throw new BadRequestException('Coupon code already exists for this event');
      }
    }

    // Converter appliesTo array para JSON string se necessário
    let appliesToValue: string | null = null;
    if (createCouponDto.appliesTo) {
      if (Array.isArray(createCouponDto.appliesTo)) {
        appliesToValue = JSON.stringify(createCouponDto.appliesTo);
      } else {
        appliesToValue = createCouponDto.appliesTo;
      }
    }

    // Converter expiryDate para Date se fornecido
    let expiryDateValue: Date | null = null;
    if (createCouponDto.expiryDate) {
      expiryDateValue = this.parseDate(createCouponDto.expiryDate);
    }

    // Verificar se o cupom está expirado
    let status = CouponStatus.ACTIVE;
    if (expiryDateValue && expiryDateValue < new Date()) {
      status = CouponStatus.EXPIRED;
    }

    const coupon = await prismaWrite.coupon.create({
      data: {
        ...createCouponDto,
        code: createCouponDto.code ? createCouponDto.code.toUpperCase() : null,
        eventId,
        status,
        expiryDate: expiryDateValue,
        appliesTo: appliesToValue,
        cpfList: createCouponDto.cpfList ? (createCouponDto.cpfList as any) : null,
        cpfListStatus: createCouponDto.cpfListStatus || 'DISABLED',
        minCartValue: createCouponDto.minCartValue != null ? createCouponDto.minCartValue : null,
        maxUsage: createCouponDto.maxUsage ?? null,
      },
    });

    // Converter appliesTo de JSON string para array quando necessário
    const transformedCoupon = {
      ...coupon,
      appliesTo: this.parseAppliesTo(coupon.appliesTo),
    };

    return {
      message: 'Coupon created successfully',
      data: { coupon: transformedCoupon },
    };
  }

  async findAll(eventId: string, filterDto: FilterCouponsDto = {}) {
    const prismaRead = this.prisma.getReadClient();

    const page = filterDto.page || 1;
    const limit = filterDto.limit || 10;
    const skip = (page - 1) * limit;

    const where: any = { eventId, deletedAt: null };
    if (filterDto.status) {
      where.status = filterDto.status;
    }

    const [coupons, total] = await Promise.all([
      prismaRead.coupon.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prismaRead.coupon.count({ where }),
    ]);

    // Converter appliesTo de JSON string para array quando necessário
    const transformedCoupons = coupons.map((coupon) => ({
      ...coupon,
      appliesTo: this.parseAppliesTo(coupon.appliesTo),
    }));

    const totalPages = Math.ceil(total / limit);

    return {
      message: 'Coupons fetched successfully',
      data: {
        coupons: transformedCoupons,
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
    const coupon = await prismaRead.coupon.findUnique({
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

    if (!coupon) {
      throw new NotFoundException('Coupon not found');
    }

    // Converter appliesTo de JSON string para array quando necessário
    const transformedCoupon = {
      ...coupon,
      appliesTo: this.parseAppliesTo(coupon.appliesTo),
    };

    return {
      message: 'Coupon fetched successfully',
      data: { coupon: transformedCoupon },
    };
  }

  async update(userId: string, eventId: string, couponId: string, updateCouponDto: UpdateCouponDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const coupon = await prismaWrite.coupon.findUnique({
      where: { id: couponId },
    });

    if (!coupon || coupon.eventId !== eventId) {
      throw new NotFoundException('Coupon not found');
    }

    // Limite não pode ser menor que o uso atual
    if (updateCouponDto.maxUsage != null && updateCouponDto.maxUsage < coupon.usageCount) {
      throw new BadRequestException(
        `O limite não pode ser menor que o uso atual (${coupon.usageCount})`,
      );
    }

    // Se o código está sendo atualizado, verificar se já existe
    if (updateCouponDto.code) {
      const existingCoupon = await prismaWrite.coupon.findUnique({
        where: {
          eventId_code: {
            eventId,
            code: updateCouponDto.code.toUpperCase(),
          },
        },
      });

      if (existingCoupon && existingCoupon.id !== couponId) {
        throw new BadRequestException('Coupon code already exists for this event');
      }
    }

    // Validar campos específicos por tipo
    if (updateCouponDto.couponType || updateCouponDto.type || updateCouponDto.value) {
      const mergedData = { ...coupon, ...updateCouponDto };
      this.validateCouponData(mergedData as any);
    }

    const updateData: any = { ...updateCouponDto };
    if (updateCouponDto.code) {
      updateData.code = updateCouponDto.code.toUpperCase();
    }
    if (updateCouponDto.appliesTo !== undefined) {
      if (Array.isArray(updateCouponDto.appliesTo)) {
        updateData.appliesTo = JSON.stringify(updateCouponDto.appliesTo);
      } else {
        updateData.appliesTo = updateCouponDto.appliesTo;
      }
    }
    if (updateCouponDto.cpfList) {
      updateData.cpfList = updateCouponDto.cpfList as any;
    }

    // Converter expiryDate para Date se fornecido
    if (updateCouponDto.expiryDate !== undefined) {
      updateData.expiryDate = updateCouponDto.expiryDate ? this.parseDate(updateCouponDto.expiryDate) : null;
    }

    // Atualizar status se necessário
    let status = updateCouponDto.status || coupon.status;
    if (updateData.expiryDate !== undefined) {
      const expiryDate = updateData.expiryDate || coupon.expiryDate;
      if (expiryDate && expiryDate < new Date()) {
        status = CouponStatus.EXPIRED;
      }
    }
    updateData.status = status;

    const updatedCoupon = await prismaWrite.coupon.update({
      where: { id: couponId },
      data: updateData,
    });

    // Converter appliesTo de JSON string para array quando necessário
    const transformedCoupon = {
      ...updatedCoupon,
      appliesTo: this.parseAppliesTo(updatedCoupon.appliesTo),
    };

    return {
      message: 'Coupon updated successfully',
      data: { coupon: transformedCoupon },
    };
  }

  async remove(userId: string, eventId: string, couponId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const coupon = await prismaWrite.coupon.findUnique({
      where: { id: couponId },
    });

    if (!coupon || coupon.eventId !== eventId) {
      throw new NotFoundException('Coupon not found');
    }

    if (coupon.usageCount > 0) {
      await prismaWrite.coupon.update({
        where: { id: couponId },
        data: { deletedAt: new Date() },
      });
    } else {
      await prismaWrite.coupon.delete({
        where: { id: couponId },
      });
    }

    return {
      message: 'Coupon deleted successfully',
    };
  }

  private validateCouponData(dto: CreateCouponDto | UpdateCouponDto) {
    // Validar código obrigatório para DISCOUNT
    if (dto.couponType === 'DISCOUNT' && !dto.code) {
      throw new BadRequestException('code is required for DISCOUNT coupon type');
    }

    // Validar valor máximo para PERCENTAGE
    if (dto.type === 'PERCENTAGE' && dto.value && dto.value > 100) {
      throw new BadRequestException('Percentage value cannot exceed 100');
    }

    // Validar campos obrigatórios para QUANTITY
    if (dto.couponType === 'QUANTITY') {
      if (!dto.minQuantity || dto.minQuantity <= 0) {
        throw new BadRequestException('minQuantity is required and must be greater than 0 for QUANTITY coupon type');
      }
    }

    // Validar campos obrigatórios para AGE — requer minAge ou maxAge (ou ageRule/ageValue legado)
    if (dto.couponType === 'AGE') {
      const hasNewFields = (dto as any).minAge != null || (dto as any).maxAge != null;
      const hasLegacyFields = dto.ageRule && dto.ageValue;
      if (!hasNewFields && !hasLegacyFields) {
        throw new BadRequestException('AGE coupon requires minAge/maxAge or ageRule/ageValue');
      }
    }

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
