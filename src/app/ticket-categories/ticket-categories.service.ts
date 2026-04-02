import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateTicketCategoryDto,
  UpdateTicketCategoryDto,
  ReorderTicketCategoriesDto,
} from './dto/create-ticket-category.dto';

@Injectable()
export class TicketCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** JSON da API usa `sortOrder`; no Prisma o campo do modelo é `order` (@map "sortOrder" no DB). */
  private categoryToApi<T extends { order: number }>(
    c: T,
  ): Omit<T, 'order'> & { sortOrder: number } {
    const { order, ...rest } = c;
    return { ...rest, sortOrder: order } as Omit<T, 'order'> & { sortOrder: number };
  }

  async create(userId: string, eventId: string, createCategoryDto: CreateTicketCategoryDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    let nextOrder = createCategoryDto.sortOrder;
    if (nextOrder === undefined) {
      const lastCategory = await prismaWrite.ticketCategory.findFirst({
        where: { eventId },
        orderBy: { order: 'desc' },
      });
      nextOrder = lastCategory ? lastCategory.order + 1 : 0;
    }

    const category = await prismaWrite.ticketCategory.create({
      data: {
        name: createCategoryDto.name,
        description: createCategoryDto.description,
        order: nextOrder,
        eventId,
      },
    });

    return {
      message: 'Ticket category created successfully',
      data: { category: this.categoryToApi(category) },
    };
  }

  async findAll(eventId: string) {
    const prismaRead = this.prisma.getReadClient();

    const categories = await prismaRead.ticketCategory.findMany({
      where: { eventId },
      orderBy: { order: 'asc' },
      include: {
        tickets: {
          where: { isActive: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return {
      message: 'Ticket categories fetched successfully',
      data: { categories: categories.map((c) => this.categoryToApi(c)) },
    };
  }

  async update(
    userId: string,
    eventId: string,
    categoryId: string,
    updateCategoryDto: UpdateTicketCategoryDto,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const category = await prismaWrite.ticketCategory.findUnique({
      where: { id: categoryId },
    });

    if (!category || category.eventId !== eventId) {
      throw new NotFoundException('Ticket category not found');
    }

    const data: Prisma.TicketCategoryUpdateInput = {};
    if (updateCategoryDto.name !== undefined) {
      data.name = updateCategoryDto.name;
    }
    if (updateCategoryDto.description !== undefined) {
      data.description = updateCategoryDto.description;
    }
    if (updateCategoryDto.sortOrder !== undefined) {
      data.order = updateCategoryDto.sortOrder;
    }

    const updatedCategory = await prismaWrite.ticketCategory.update({
      where: { id: categoryId },
      data,
    });

    return {
      message: 'Ticket category updated successfully',
      data: { category: this.categoryToApi(updatedCategory) },
    };
  }

  async reorder(
    userId: string,
    eventId: string,
    dto: ReorderTicketCategoriesDto,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const existing = await prismaWrite.ticketCategory.findMany({
      where: { eventId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((c) => c.id));
    const incoming = dto.categoryIds;

    if (incoming.length !== existingIds.size) {
      throw new BadRequestException(
        'categoryIds must list every event ticket category exactly once (same length as current categories)',
      );
    }
    if (new Set(incoming).size !== incoming.length) {
      throw new BadRequestException('categoryIds must not contain duplicates');
    }
    for (const id of incoming) {
      if (!existingIds.has(id)) {
        throw new BadRequestException(
          `Category ${id} does not belong to this event`,
        );
      }
    }

    await prismaWrite.$transaction(
      incoming.map((id, index) =>
        prismaWrite.ticketCategory.update({
          where: { id },
          data: { order: index },
        }),
      ),
    );

    const categories = await prismaRead.ticketCategory.findMany({
      where: { eventId },
      orderBy: { order: 'asc' },
      include: {
        tickets: {
          where: { isActive: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return {
      message: 'Ticket categories reordered successfully',
      data: { categories: categories.map((c) => this.categoryToApi(c)) },
    };
  }

  async remove(userId: string, eventId: string, categoryId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const category = await prismaWrite.ticketCategory.findUnique({
      where: { id: categoryId },
      include: {
        tickets: true,
      },
    });

    if (!category || category.eventId !== eventId) {
      throw new NotFoundException('Ticket category not found');
    }

    // Validar se há ingressos associados à categoria
    if (category.tickets.length > 0) {
      throw new BadRequestException('Cannot delete category with associated tickets');
    }

    await prismaWrite.ticketCategory.delete({
      where: { id: categoryId },
    });

    return {
      message: 'Ticket category deleted successfully',
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
