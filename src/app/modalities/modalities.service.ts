import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateModalityGroupDto,
  UpdateModalityGroupDto,
  CreateModalityDto,
  UpdateModalityDto,
} from './dto/create-modality.dto';

@Injectable()
export class ModalitiesService {
  constructor(private readonly prisma: PrismaService) {}

  // Modality Groups
  async createGroup(
    userId: string,
    eventId: string,
    createGroupDto: CreateModalityGroupDto,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const group = await prismaWrite.modalityGroup.create({
      data: {
        ...createGroupDto,
        eventId,
      },
    });

    return {
      message: 'Modality group created successfully',
      data: { group },
    };
  }

  async updateGroup(
    userId: string,
    eventId: string,
    groupId: string,
    updateGroupDto: UpdateModalityGroupDto,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const group = await prismaWrite.modalityGroup.findUnique({
      where: { id: groupId },
    });

    if (!group || group.eventId !== eventId) {
      throw new NotFoundException('Modality group not found');
    }

    const updatedGroup = await prismaWrite.modalityGroup.update({
      where: { id: groupId },
      data: updateGroupDto,
    });

    return {
      message: 'Modality group updated successfully',
      data: { group: updatedGroup },
    };
  }

  async deleteGroup(userId: string, eventId: string, groupId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const group = await prismaWrite.modalityGroup.findUnique({
      where: { id: groupId },
      include: {
        modalities: true,
      },
    });

    if (!group || group.eventId !== eventId) {
      throw new NotFoundException('Modality group not found');
    }

    if (group.modalities.length > 0) {
      throw new BadRequestException(
        'Cannot delete group with modalities. Delete modalities first.',
      );
    }

    await prismaWrite.modalityGroup.delete({
      where: { id: groupId },
    });

    return {
      message: 'Modality group deleted successfully',
    };
  }

  // Modalities
  async create(
    userId: string,
    eventId: string,
    createModalityDto: CreateModalityDto,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se o grupo pertence ao evento
    const group = await prismaRead.modalityGroup.findUnique({
      where: { id: createModalityDto.groupId },
    });

    if (!group || group.eventId !== eventId) {
      throw new NotFoundException('Modality group not found');
    }

    const modality = await prismaWrite.modality.create({
      data: {
        ...createModalityDto,
        eventId,
      },
    });

    return {
      message: 'Modality created successfully',
      data: { modality },
    };
  }

  async findAll(eventId: string) {
    const prismaRead = this.prisma.getReadClient();

    const modalities = await prismaRead.modality.findMany({
      where: {
        eventId,
        isActive: true,
      },
      include: {
        group: true,
      },
      orderBy: [{ group: { order: 'asc' } }, { order: 'asc' }],
    });

    return {
      message: 'Modalities fetched successfully',
      data: { modalities },
    };
  }

  async findOne(id: string) {
    const prismaRead = this.prisma.getReadClient();

    const modality = await prismaRead.modality.findUnique({
      where: { id },
      include: {
        group: true,
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
