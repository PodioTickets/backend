import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTicketCategoryDto, UpdateTicketCategoryDto } from './dto/create-ticket-category.dto';

@Injectable()
export class TicketCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, eventId: string, createCategoryDto: CreateTicketCategoryDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    // Se order não foi fornecido, usar o último order + 1
    if (createCategoryDto.order === undefined) {
      const lastCategory = await prismaWrite.ticketCategory.findFirst({
        where: { eventId },
        orderBy: { order: 'desc' },
      });
      createCategoryDto.order = lastCategory ? lastCategory.order + 1 : 0;
    }

    const category = await prismaWrite.ticketCategory.create({
      data: {
        name: createCategoryDto.name,
        order: createCategoryDto.order,
        eventId,
      },
    });

    return {
      message: 'Ticket category created successfully',
      data: { category },
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
      data: { categories },
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

    const updatedCategory = await prismaWrite.ticketCategory.update({
      where: { id: categoryId },
      data: updateCategoryDto,
    });

    return {
      message: 'Ticket category updated successfully',
      data: { category: updatedCategory },
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
