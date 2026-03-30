import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto, FilterProductsDto, ProductVariationDto } from './dto/create-product.dto';
import { OrganizationsService } from '../organizations/organizations.service';
import { Prisma } from '@prisma/client';
import {
  summarizeProductUpdateForAudit,
  type ProductBeforeAudit,
  type ProductVariationAuditSnapshot,
} from './product-audit.helpers';

const DEFAULT_NO_INTEREST_VARIATION_NAME = 'Sem interesse';

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizationsService: OrganizationsService,
  ) {}

  /**
   * Para produtos não obrigatórios, garante que exista a variação padrão "Sem interesse".
   */
  private ensureDefaultNoInterestVariation(
    isRequired: boolean,
    variations: ProductVariationDto[],
  ): ProductVariationDto[] {
    if (isRequired) return variations;
    const hasNoInterest = variations.some(
      (v) => v.name.trim().toLowerCase() === DEFAULT_NO_INTEREST_VARIATION_NAME.toLowerCase(),
    );
    if (hasNoInterest) return variations;
    return [
      { name: DEFAULT_NO_INTEREST_VARIATION_NAME, price: 0, stock: 0 },
      ...variations,
    ];
  }

  async create(
    userId: string,
    eventId: string,
    createProductDto: CreateProductDto,
    clientIp?: string | null,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();
    const isRequired = createProductDto.isRequired ?? false;
    const variations = this.ensureDefaultNoInterestVariation(
      isRequired,
      createProductDto.variations,
    );

    // Validações
    if (variations.length === 0) {
      throw new BadRequestException('Product must have at least one variation');
    }

    if (createProductDto.isRequired && variations.length < 2) {
      throw new BadRequestException('Required products must have at least 2 variations');
    }

    const product = await prismaWrite.product.create({
      data: {
        name: createProductDto.name,
        image: createProductDto.image,
        isIncludedInTicket: createProductDto.isIncludedInTicket ?? false,
        basePrice: Math.round(createProductDto.basePrice ?? 0), // entrada já em centavos (INT)
        isRequired: createProductDto.isRequired ?? false,
        variationType: createProductDto.variationType,
        eventId,
        variations: {
          create: variations.map((v) => ({
            name: v.name,
            price: Math.round(v.price ?? 0), // entrada já em centavos (INT)
            stock: v.stock ?? 0,
          })),
        },
      },
      include: {
        variations: true,
      },
    });

    const eventRecord = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true, name: true },
    });
    if (eventRecord) {
      await this.organizationsService.recordOrganizationAuditLog({
        organizationId: eventRecord.organizationId,
        actorUserId: userId,
        ip: clientIp ?? null,
        action: `Criou o produto "${product.name}" do evento "${eventRecord.name}"`,
        metadata: {
          kind: 'PRODUCT_CREATE',
          eventId,
          productId: product.id,
          changes: [
            {
              field: 'produto',
              old: null,
              new: {
                id: product.id,
                name: product.name,
                image: product.image,
                isIncludedInTicket: product.isIncludedInTicket,
                basePrice: product.basePrice,
                isRequired: product.isRequired,
                variationType: product.variationType,
                variations: product.variations.map((v) => ({
                  name: v.name,
                  price: v.price,
                  stock: v.stock,
                })),
              },
            },
          ],
        } as Prisma.InputJsonValue,
      });
    }

    return {
      message: 'Product created successfully',
      data: { product },
    };
  }

  async findAll(eventId: string, filterDto: FilterProductsDto = {}) {
    const prismaRead = this.prisma.getReadClient();

    const page = filterDto.page || 1;
    const limit = filterDto.limit || 20;
    const skip = (page - 1) * limit;

    const [products, total] = await Promise.all([
      prismaRead.product.findMany({
        where: { eventId },
        skip,
        take: limit,
        include: {
          variations: {
            orderBy: { name: 'asc' },
          },
        },
        // Ordem estável para integração/UI: nome, depois id (desempate).
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      prismaRead.product.count({ where: { eventId } }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      message: 'Products fetched successfully',
      data: {
        products,
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
    const product = await prismaRead.product.findUnique({
      where: { id },
      include: {
        variations: {
          orderBy: { name: 'asc' },
        },
        event: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return {
      message: 'Product fetched successfully',
      data: { product },
    };
  }

  async update(
    userId: string,
    eventId: string,
    productId: string,
    updateProductDto: UpdateProductDto,
    clientIp?: string | null,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const product = await prismaWrite.product.findUnique({
      where: { id: productId },
      include: {
        tickets: true,
        variations: {
          select: { id: true, name: true, price: true, stock: true },
          orderBy: { name: 'asc' },
        },
      },
    });

    if (!product || product.eventId !== eventId) {
      throw new NotFoundException('Product not found');
    }

    // Não permitir atualizar produtos vinculados a ingressos vendidos
    // TODO: Verificar se há registrations com esses tickets

    const updateData: Record<string, unknown> = { ...updateProductDto };
    delete updateData.variations;
    for (const k of Object.keys(updateData)) {
      if (updateData[k] === undefined) {
        delete updateData[k];
      }
    }

    if (updateData.basePrice !== undefined) {
      updateData.basePrice = Math.round(Number(updateData.basePrice));
    }

    const scalarOnlyForAudit = { ...updateData };
    let newVariationsSnapshot: ProductVariationAuditSnapshot[] | null = null;

    if (updateProductDto.variations) {
      const isRequired = updateProductDto.isRequired ?? product.isRequired;
      const variations = this.ensureDefaultNoInterestVariation(
        isRequired,
        updateProductDto.variations,
      );

      if (variations.length === 0) {
        throw new BadRequestException('Product must have at least one variation');
      }

      if (updateProductDto.isRequired && variations.length < 2) {
        throw new BadRequestException('Required products must have at least 2 variations');
      }

      newVariationsSnapshot = variations.map((v) => ({
        name: v.name,
        price: Math.round(v.price ?? 0),
        stock: v.stock ?? 0,
      }));

      await prismaWrite.productVariation.deleteMany({
        where: { productId },
      });

      updateData.variations = {
        create: variations.map((v) => ({
          name: v.name,
          price: Math.round(v.price ?? 0),
          stock: v.stock ?? 0,
        })),
      };
    }

    const { labels: auditLabels, changes: auditChanges } =
      summarizeProductUpdateForAudit(
        product as unknown as ProductBeforeAudit,
        scalarOnlyForAudit,
        updateProductDto,
        newVariationsSnapshot,
      );

    const updatedProduct = await prismaWrite.product.update({
      where: { id: productId },
      data: updateData as Prisma.ProductUpdateInput,
      include: {
        variations: true,
      },
    });

    const eventRecord = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true, name: true },
    });
    if (eventRecord) {
      await this.organizationsService.recordOrganizationAuditLog({
        organizationId: eventRecord.organizationId,
        actorUserId: userId,
        ip: clientIp ?? null,
        action: `Editou o produto "${updatedProduct.name}" do evento "${eventRecord.name}"`,
        metadata: {
          kind: 'PRODUCT_UPDATE',
          eventId,
          productId,
          fieldsEdited: auditLabels,
          changes: auditChanges,
        } as Prisma.InputJsonValue,
      });
    }

    return {
      message: 'Product updated successfully',
      data: { product: updatedProduct },
    };
  }

  async remove(
    userId: string,
    eventId: string,
    productId: string,
    clientIp?: string | null,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const product = await prismaWrite.product.findUnique({
      where: { id: productId },
      include: {
        tickets: true,
        kitItems: true,
        variations: { orderBy: { name: 'asc' } },
      },
    });

    if (!product || product.eventId !== eventId) {
      throw new NotFoundException('Product not found');
    }

    // Validar se o produto está vinculado a ingressos ou kits
    if (product.tickets.length > 0 || product.kitItems.length > 0) {
      throw new BadRequestException('Cannot delete product that is linked to tickets or kits');
    }

    const eventRecord = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true, name: true },
    });
    if (eventRecord) {
      await this.organizationsService.recordOrganizationAuditLog({
        organizationId: eventRecord.organizationId,
        actorUserId: userId,
        ip: clientIp ?? null,
        action: `Excluiu o produto "${product.name}" do evento "${eventRecord.name}"`,
        metadata: {
          kind: 'PRODUCT_DELETE',
          eventId,
          productId,
          changes: [
            {
              field: 'produto',
              old: {
                id: product.id,
                name: product.name,
                image: product.image,
                isIncludedInTicket: product.isIncludedInTicket,
                basePrice: product.basePrice,
                isRequired: product.isRequired,
                variationType: product.variationType,
                variations: product.variations.map((v) => ({
                  name: v.name,
                  price: v.price,
                  stock: v.stock,
                })),
              },
              new: null,
            },
          ],
        } as Prisma.InputJsonValue,
      });
    }

    await prismaWrite.product.delete({
      where: { id: productId },
    });

    return {
      message: 'Product deleted successfully',
    };
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
