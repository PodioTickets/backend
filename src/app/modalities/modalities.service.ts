import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateModalityDto,
  UpdateModalityDto,
} from './dto/create-modality.dto';

@Injectable()
export class ModalitiesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Busca todos os templates de modalidades disponíveis
   */
  async findAllTemplates() {
    const prismaRead = this.prisma.getReadClient();

    const templates = await prismaRead.modalityTemplate.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        label: 'asc',
      },
    });

    return {
      message: 'Modality templates fetched successfully',
      data: { templates },
    };
  }

  /**
   * Cria uma modalidade para um evento
   */
  async create(
    userId: string,
    eventId: string,
    createModalityDto: CreateModalityDto,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Se templateId foi fornecido, verificar se existe
    if (createModalityDto.templateId) {
      const template = await prismaRead.modalityTemplate.findUnique({
        where: { id: createModalityDto.templateId },
      });

      if (!template) {
        throw new NotFoundException('Modality template not found');
      }
    }

    const modality = await prismaWrite.modality.create({
      data: {
        name: createModalityDto.name,
        description: createModalityDto.description,
        price: createModalityDto.price,
        maxParticipants: createModalityDto.maxParticipants,
        isActive: createModalityDto.isActive ?? true,
        order: createModalityDto.order ?? 0,
        eventId,
        templateId: createModalityDto.templateId,
      },
      include: {
        template: true,
      },
    });

    return {
      message: 'Modality created successfully',
      data: { modality },
    };
  }

  /**
   * Busca todas as modalidades de um evento
   */
  async findAll(eventId: string) {
    const prismaRead = this.prisma.getReadClient();

    const modalities = await prismaRead.modality.findMany({
      where: {
        eventId,
        isActive: true,
      },
      include: {
        template: {
          select: {
            id: true,
            code: true,
            label: true,
            icon: true,
          },
        },
      },
      orderBy: {
        order: 'asc',
      },
    });

    return {
      message: 'Modalities fetched successfully',
      data: { modalities },
    };
  }

  /**
   * Busca uma modalidade específica
   */
  async findOne(id: string) {
    const prismaRead = this.prisma.getReadClient();

    const modality = await prismaRead.modality.findUnique({
      where: { id },
      include: {
        template: {
          select: {
            id: true,
            code: true,
            label: true,
            icon: true,
          },
        },
        event: {
          select: {
            id: true,
            name: true,
            eventDate: true,
          },
        },
      },
    });

    if (!modality) {
      throw new NotFoundException('Modality not found');
    }

    return {
      message: 'Modality fetched successfully',
      data: { modality },
    };
  }

  async update(
    userId: string,
    eventId: string,
    modalityId: string,
    updateModalityDto: UpdateModalityDto,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const modality = await prismaWrite.modality.findUnique({
      where: { id: modalityId },
    });

    if (!modality || modality.eventId !== eventId) {
      throw new NotFoundException('Modality not found');
    }

    const updatedModality = await prismaWrite.modality.update({
      where: { id: modalityId },
      data: updateModalityDto,
    });

    return {
      message: 'Modality updated successfully',
      data: { modality: updatedModality },
    };
  }

  async remove(userId: string, eventId: string, modalityId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const modality = await prismaWrite.modality.findUnique({
      where: { id: modalityId },
      include: {
        registrations: true,
      },
    });

    if (!modality || modality.eventId !== eventId) {
      throw new NotFoundException('Modality not found');
    }

    if (modality.registrations.length > 0) {
      throw new BadRequestException(
        'Cannot delete modality with registrations',
      );
    }

    await prismaWrite.modality.delete({
      where: { id: modalityId },
    });

    return {
      message: 'Modality deleted successfully',
    };
  }

  private async verifyOrganizerAccess(userId: string, eventId: string) {
    // Verificações de acesso críticas devem usar write client para consistência
    const prismaRead = this.prisma.getReadClient();
    const prismaWrite = this.prisma.getWriteClient();

    const organizer = await prismaWrite.organizer.findUnique({
      where: { userId },
    });

    if (!organizer) {
      throw new BadRequestException('User is not an organizer');
    }

    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.organizerId !== organizer.id) {
      throw new BadRequestException('User is not the organizer of this event');
    }
  }
}
