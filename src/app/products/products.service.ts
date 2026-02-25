import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto, FilterProductsDto } from './dto/create-product.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, eventId: string, createProductDto: CreateProductDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    // Validações
    if (createProductDto.variations.length === 0) {
      throw new BadRequestException('Product must have at least one variation');
    }

    if (createProductDto.isRequired && createProductDto.variations.length < 2) {
      throw new BadRequestException('Required products must have at least 2 variations');
    }

    const product = await prismaWrite.product.create({
      data: {
        name: createProductDto.name,
        image: createProductDto.image,
        isIncludedInTicket: createProductDto.isIncludedInTicket ?? false,
        basePrice: createProductDto.basePrice ?? 0,
        isRequired: createProductDto.isRequired ?? false,
        eventId,
        variations: {
          create: createProductDto.variations.map((v) => ({
            name: v.name,
            price: v.price,
            stock: v.stock ?? 0,
          })),
        },
      },
      include: {
        variations: true,
      },
    });

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
        orderBy: { createdAt: 'desc' },
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

  async update(userId: string, eventId: string, productId: string, updateProductDto: UpdateProductDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const product = await prismaWrite.product.findUnique({
      where: { id: productId },
      include: {
        tickets: true,
      },
    });

    if (!product || product.eventId !== eventId) {
      throw new NotFoundException('Product not found');
    }

    // Não permitir atualizar produtos vinculados a ingressos vendidos
    // TODO: Verificar se há registrations com esses tickets

    const updateData: any = { ...updateProductDto };
    delete updateData.variations;

    if (updateProductDto.variations) {
      // Validar variações
      if (updateProductDto.variations.length === 0) {
        throw new BadRequestException('Product must have at least one variation');
      }

      if (updateProductDto.isRequired && updateProductDto.variations.length < 2) {
        throw new BadRequestException('Required products must have at least 2 variations');
      }

      // Deletar variações antigas e criar novas
      await prismaWrite.productVariation.deleteMany({
        where: { productId },
      });

      updateData.variations = {
        create: updateProductDto.variations.map((v) => ({
          name: v.name,
          price: v.price,
          stock: v.stock ?? 0,
        })),
      };
    }

    const updatedProduct = await prismaWrite.product.update({
      where: { id: productId },
      data: updateData,
      include: {
        variations: true,
      },
    });

    return {
      message: 'Product updated successfully',
      data: { product: updatedProduct },
    };
  }

  async remove(userId: string, eventId: string, productId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const product = await prismaWrite.product.findUnique({
      where: { id: productId },
      include: {
        tickets: true,
        kitItems: true,
      },
    });

    if (!product || product.eventId !== eventId) {
      throw new NotFoundException('Product not found');
    }

    // Validar se o produto está vinculado a ingressos ou kits
    if (product.tickets.length > 0 || product.kitItems.length > 0) {
      throw new BadRequestException('Cannot delete product that is linked to tickets or kits');
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
