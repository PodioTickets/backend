import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateKitDto, UpdateKitDto, CreateKitItemDto, UpdateKitItemDto } from './dto/create-kit.dto';

@Injectable()
export class KitsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, eventId: string, createKitDto: CreateKitDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    // Usar write client para criação
    const prismaWrite = this.prisma.getWriteClient();

    const kit = await prismaWrite.kit.create({
      data: {
        name: createKitDto.name,
        description: createKitDto.description,
        isActive: createKitDto.isActive ?? true,
        eventId,
        items: createKitDto.items
          ? {
              create: createKitDto.items.map((item) => ({
                name: item.name,
                description: item.description,
                productId: item.productId,
                sizes: item.sizes as any,
                isActive: item.isActive ?? true,
              })),
            }
          : undefined,
      },
      include: {
        items: true,
      },
    });

    return {
      message: 'Kit created successfully',
      data: { kit },
    };
  }

  async findAll(eventId: string) {
    // Em produção, usar read replica para leitura
    const prismaRead = this.prisma.getReadClient();
    
    const kits = await prismaRead.kit.findMany({
      where: {
        eventId,
        isActive: true,
      },
      include: {
        items: {
          where: { isActive: true },
          include: {
            product: true,
          },
        },
      },
    });

    return {
      message: 'Kits fetched successfully',
      data: { kits },
    };
  }

  async findOne(id: string) {
    // Em produção, usar read replica para leitura
    const prismaRead = this.prisma.getReadClient();
    
    const kit = await prismaRead.kit.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: true,
          },
        },
        event: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!kit) {
      throw new NotFoundException('Kit not found');
    }

    return {
      message: 'Kit fetched successfully',
      data: { kit },
    };
  }

  async update(userId: string, eventId: string, kitId: string, updateKitDto: UpdateKitDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const kit = await prismaWrite.kit.findUnique({
      where: { id: kitId },
    });

    if (!kit || kit.eventId !== eventId) {
      throw new NotFoundException('Kit not found');
    }

    const updatedKit = await prismaWrite.kit.update({
      where: { id: kitId },
      data: updateKitDto,
    });

    return {
      message: 'Kit updated successfully',
      data: { kit: updatedKit },
    };
  }

  async remove(userId: string, eventId: string, kitId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const kit = await prismaWrite.kit.findUnique({
      where: { id: kitId },
      include: {
        items: {
          include: {
            registrations: true,
          },
        },
      },
    });

    if (!kit || kit.eventId !== eventId) {
      throw new NotFoundException('Kit not found');
    }

    const hasRegistrations = kit.items.some((item) => item.registrations.length > 0);
    if (hasRegistrations) {
      throw new BadRequestException('Cannot delete kit with registered items');
    }

    await prismaWrite.kit.delete({
      where: { id: kitId },
    });

    return {
      message: 'Kit deleted successfully',
    };
  }

  // Kit Items
  async createItem(userId: string, eventId: string, kitId: string, createItemDto: CreateKitItemDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const kit = await prismaWrite.kit.findUnique({
      where: { id: kitId },
    });

    if (!kit || kit.eventId !== eventId) {
      throw new NotFoundException('Kit not found');
    }

    // Validar productId se fornecido
    if (createItemDto.productId) {
      const product = await prismaRead.product.findUnique({
        where: { id: createItemDto.productId },
      });
      if (!product || product.eventId !== eventId) {
        throw new NotFoundException('Product not found or does not belong to this event');
      }
    }

    const item = await prismaWrite.kitItem.create({
      data: {
        name: createItemDto.name,
        description: createItemDto.description,
        productId: createItemDto.productId,
        kitId,
        sizes: createItemDto.sizes as any,
        isActive: createItemDto.isActive ?? true,
      },
      include: {
        product: true,
      },
    });

    return {
      message: 'Kit item created successfully',
      data: { item },
    };
  }

  async updateItem(userId: string, eventId: string, kitId: string, itemId: string, updateItemDto: UpdateKitItemDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const item = await prismaWrite.kitItem.findUnique({
      where: { id: itemId },
    });

    if (!item || item.kitId !== kitId) {
      throw new NotFoundException('Kit item not found');
    }

    // Validar productId se fornecido
    if (updateItemDto.productId !== undefined) {
      if (updateItemDto.productId) {
        const product = await prismaRead.product.findUnique({
          where: { id: updateItemDto.productId },
        });
        if (!product || product.eventId !== eventId) {
          throw new NotFoundException('Product not found or does not belong to this event');
        }
      }
    }

    const updateData: any = { ...updateItemDto };
    if (updateItemDto.sizes) {
      updateData.sizes = updateItemDto.sizes as any;
    }

    const updatedItem = await prismaWrite.kitItem.update({
      where: { id: itemId },
      data: updateData,
      include: {
        product: true,
      },
    });

    return {
      message: 'Kit item updated successfully',
      data: { item: updatedItem },
    };
  }

  async removeItem(userId: string, eventId: string, kitId: string, itemId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const item = await prismaWrite.kitItem.findUnique({
      where: { id: itemId },
      include: {
        registrations: true,
      },
    });

    if (!item || item.kitId !== kitId) {
      throw new NotFoundException('Kit item not found');
    }

    if (item.registrations.length > 0) {
      throw new BadRequestException('Cannot delete kit item with registrations');
    }

    await prismaWrite.kitItem.delete({
      where: { id: itemId },
    });

    return {
      message: 'Kit item deleted successfully',
    };
  }

  async checkStock(kitItemId: string, size: string, quantity: number) {
    // Leitura de estoque - usar read replica
    const prismaRead = this.prisma.getReadClient();
    
    const item = await prismaRead.kitItem.findUnique({
      where: { id: kitItemId },
    });

    if (!item) {
      throw new NotFoundException('Kit item not found');
    }

    const sizes = item.sizes as Array<{ size: string; stock: number }>;
    const sizeStock = sizes.find((s) => s.size === size);

    if (!sizeStock) {
      throw new BadRequestException(`Size ${size} not available for this item`);
    }

    if (sizeStock.stock < quantity) {
      throw new BadRequestException(`Insufficient stock. Available: ${sizeStock.stock}, Requested: ${quantity}`);
    }

    return true;
  }

  async updateStock(kitItemId: string, size: string, quantity: number) {
    const prismaWrite = this.prisma.getWriteClient();

    const item = await prismaWrite.kitItem.findUnique({
      where: { id: kitItemId },
    });

    if (!item) {
      throw new NotFoundException('Kit item not found');
    }

    const sizes = item.sizes as Array<{ size: string; stock: number }>;
    const sizeIndex = sizes.findIndex((s) => s.size === size);

    if (sizeIndex === -1) {
      throw new BadRequestException(`Size ${size} not found`);
    }

    sizes[sizeIndex].stock -= quantity;

    await prismaWrite.kitItem.update({
      where: { id: kitItemId },
      data: {
        sizes: sizes as any,
      },
    });
  }

  private async verifyOrganizerAccess(userId: string, eventId: string) {
    // Verificações de acesso críticas devem usar write client para consistência
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

