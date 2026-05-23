import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCouponDto, UpdateCouponDto, FilterCouponsDto, CouponStatus } from './dto/create-coupon.dto';
import { buildDocumentList } from '../../common/utils/document.util';

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, eventId: string, createCouponDto: CreateCouponDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    // Validar campos específicos por tipo
    this.validateCouponData(createCouponDto);

    // Cupons AGE não podem ter intervalos sobrepostos no mesmo evento
    if (createCouponDto.couponType === 'AGE') {
      await this.assertNoAgeOverlap(eventId, createCouponDto as any);
    }

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
        throw new BadRequestException('Código do cupom já existe para este evento');
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

    // Dual-write: grava documentList (shape novo) e mantém cpfList em
    // paralelo durante a transição. buildDocumentList prefere documentList
    // do DTO e auto-converte cpfList quando só este vem (cliente legado).
    const documentList = buildDocumentList({
      documentList: createCouponDto.documentList,
      cpfList: createCouponDto.cpfList,
    });

    const coupon = await prismaWrite.coupon.create({
      data: {
        ...createCouponDto,
        code: createCouponDto.code ? createCouponDto.code.toUpperCase() : null,
        eventId,
        status,
        expiryDate: expiryDateValue,
        appliesTo: appliesToValue,
        cpfList: createCouponDto.cpfList ? (createCouponDto.cpfList as any) : null,
        documentList: (documentList as any) ?? null,
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
      throw new NotFoundException('Cupom não encontrado');
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

  /**
   * Preview público de cupom pelo código. Usado pelo checkout antes de
   * aplicar — só retorna os campos necessários pro front exibir a
   * sinalização ("R$ 50 OFF", "10% OFF"). Não vaza:
   *   - cpfList/documentList (PII de elegíveis)
   *   - usageCount/maxUsage (timing pra esgotar cupom)
   *   - minCartValue, ageRule, minAge/maxAge (config interna)
   *   - note (texto interno do organizador)
   *
   * Erros:
   *   - 404 Evento não encontrado
   *   - 404 Cupom não encontrado (não existe, ou soft-deleted)
   *   - 422 Cupom expirado (por data OU status EXPIRED)
   *   - 422 Cupom inativo (status INACTIVE)
   *   - 422 Cupom esgotado (atingiu maxUsage)
   *
   * Performance: lookup direto na unique key `(eventId, code)` — uma
   * query indexada. Evento checado em paralelo (Promise.all) pra cortar
   * latência em metade quando ambos existem.
   *
   * Segurança: rota pública. Rate-limit é aplicado no controller via
   * `@Throttle` (preview é alvo natural pra brute-force de códigos).
   * Code é uppercased antes do lookup pra match case-insensitive.
   */
  async previewByCode(eventId: string, rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    const prismaRead = this.prisma.getReadClient();

    const [event, coupon] = await Promise.all([
      prismaRead.event.findUnique({
        where: { id: eventId },
        select: { id: true },
      }),
      prismaRead.coupon.findUnique({
        where: { eventId_code: { eventId, code } },
        select: {
          code: true,
          value: true,
          type: true,
          couponType: true,
          applyToProducts: true,
          status: true,
          expiryDate: true,
          usageCount: true,
          maxUsage: true,
          deletedAt: true,
        },
      }),
    ]);

    if (!event) {
      throw new NotFoundException({
        code: 'EVENT_NOT_FOUND',
        message: 'Evento não encontrado',
      });
    }

    // Soft-delete tratado como inexistente (consistente com leitura admin).
    if (!coupon || coupon.deletedAt) {
      throw new NotFoundException({
        code: 'COUPON_NOT_FOUND',
        message: 'Cupom não encontrado',
      });
    }

    // Expiração: confiar tanto na data quanto no status. O status pode
    // estar desatualizado se o cron de expiração ainda não rodou (ou se
    // foi expirado manualmente pelo organizador).
    const now = new Date();
    if (
      coupon.status === 'EXPIRED' ||
      (coupon.expiryDate && coupon.expiryDate < now)
    ) {
      throw new UnprocessableEntityException({
        code: 'COUPON_EXPIRED',
        message: 'Cupom expirado',
      });
    }

    if (coupon.status === 'INACTIVE') {
      throw new UnprocessableEntityException({
        code: 'COUPON_INACTIVE',
        message: 'Cupom inativo',
      });
    }

    if (coupon.maxUsage != null && coupon.usageCount >= coupon.maxUsage) {
      throw new UnprocessableEntityException({
        code: 'COUPON_USAGE_LIMIT_REACHED',
        message: 'Cupom esgotado',
      });
    }

    return {
      message: 'Coupon preview fetched successfully',
      data: {
        code: coupon.code,
        value: coupon.value,
        type: coupon.type,
        couponType: coupon.couponType,
        applyToProducts: coupon.applyToProducts,
      },
    };
  }

  async update(userId: string, eventId: string, couponId: string, updateCouponDto: UpdateCouponDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const coupon = await prismaWrite.coupon.findUnique({
      where: { id: couponId },
    });

    if (!coupon || coupon.eventId !== eventId) {
      throw new NotFoundException('Cupom não encontrado');
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
        throw new BadRequestException('Código do cupom já existe para este evento');
      }
    }

    // Validar campos específicos por tipo
    if (updateCouponDto.couponType || updateCouponDto.type || updateCouponDto.value) {
      const mergedData = { ...coupon, ...updateCouponDto };
      this.validateCouponData(mergedData as any);
    }

    // Cupons AGE: verificar sobreposição de faixa etária (excluindo o próprio cupom)
    const effectiveType = updateCouponDto.couponType ?? coupon.couponType;
    if (effectiveType === 'AGE') {
      const merged = { ...coupon, ...updateCouponDto };
      await this.assertNoAgeOverlap(eventId, merged as any, couponId);
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
    // Update da lista de documentos: aceita documentList (novo) e/ou
    // cpfList (legacy). Quando qualquer um dos dois é informado, recalcula
    // o documentList canônico mantendo cpfList em paralelo.
    if (updateCouponDto.cpfList !== undefined || updateCouponDto.documentList !== undefined) {
      const merged = buildDocumentList({
        documentList: updateCouponDto.documentList ?? (coupon.documentList as any),
        cpfList: updateCouponDto.cpfList ?? (coupon.cpfList as any),
      });
      updateData.documentList = (merged as any) ?? null;
      if (updateCouponDto.cpfList !== undefined) {
        updateData.cpfList = updateCouponDto.cpfList as any;
      }
    } else {
      // Sem mudança em listas — não persistir o `documentList` cru do spread
      // (ele já entrou via `{ ...updateCouponDto }` se o cliente mandou).
      delete updateData.documentList;
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
      throw new NotFoundException('Cupom não encontrado');
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

  private async assertNoAgeOverlap(
    eventId: string,
    dto: { minAge?: number | null; maxAge?: number | null },
    excludeId?: string,
  ): Promise<void> {
    const prismaRead = this.prisma.getReadClient();
    const newMin = dto.minAge ?? 0;
    const newMax = dto.maxAge ?? Infinity;

    const existingAge = await prismaRead.coupon.findMany({
      where: {
        eventId,
        couponType: 'AGE',
        deletedAt: null,
        status: { not: 'EXPIRED' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true, minAge: true, maxAge: true },
    });

    for (const existing of existingAge) {
      const eMin = existing.minAge ?? 0;
      const eMax = existing.maxAge ?? Infinity;
      // Duas faixas se sobrepõem quando: newMin <= eMax E newMax >= eMin
      if (newMin <= eMax && newMax >= eMin) {
        const eMaxLabel = existing.maxAge != null ? String(existing.maxAge) : '∞';
        const newMaxLabel = dto.maxAge != null ? String(dto.maxAge) : '∞';
        throw new BadRequestException(
          `Faixa etária ${newMin}–${newMaxLabel} anos sobrepõe o cupom existente ${eMin}–${eMaxLabel} anos`,
        );
      }
    }
  }

  private validateCouponData(dto: CreateCouponDto | UpdateCouponDto) {
    // Validar código obrigatório para DISCOUNT
    if (dto.couponType === 'DISCOUNT' && !dto.code) {
      throw new BadRequestException('code is required for DISCOUNT coupon type');
    }

    // Validar valor máximo para PERCENTAGE
    if (dto.type === 'PERCENTAGE' && dto.value && dto.value > 100) {
      throw new BadRequestException('Valor percentual não pode exceder 100');
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

    // Validar lista de documentos quando habilitada: aceita cpfList (legacy)
    // OU documentList (novo, internacionalizado). Pelo menos um precisa
    // estar preenchido.
    if (dto.cpfListStatus === 'ENABLED') {
      const hasCpf = Array.isArray(dto.cpfList) && dto.cpfList.length > 0;
      const hasDocList = Array.isArray((dto as any).documentList) && (dto as any).documentList.length > 0;
      if (!hasCpf && !hasDocList) {
        throw new BadRequestException('documentList ou cpfList é obrigatório quando cpfListStatus = ENABLED');
      }
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
