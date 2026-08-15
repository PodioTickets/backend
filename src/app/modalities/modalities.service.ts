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
import {
  CreateModalityGroupDto,
  UpdateModalityGroupDto,
} from './dto/create-modality-group.dto';
import { OrganizationAuditService } from '../../common/services/organization-audit.service';

@Injectable()
export class ModalitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OrganizationAuditService,
  ) {}

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
    clientIp?: string | null,
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

    // Se groupId foi fornecido, verificar se existe
    if (createModalityDto.groupId) {
      const group = await prismaRead.modalityGroup.findUnique({
        where: { id: createModalityDto.groupId },
      });

      if (!group || group.eventId !== eventId) {
        throw new NotFoundException('Modality group not found or does not belong to this event');
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
        groupId: createModalityDto.groupId,
      },
      include: {
        template: true,
        group: true,
      },
    });

    await this.auditService.recordForEvent(eventId, {
      actorUserId: userId,
      ip: clientIp,
      kind: 'MODALITY_CREATE',
      action: (ev) =>
        `Criou a modalidade "${modality.name}" no evento "${ev}"`,
      extra: { modalityId: modality.id },
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
    clientIp?: string | null,
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

    await this.auditService.recordForEvent(eventId, {
      actorUserId: userId,
      ip: clientIp,
      kind: 'MODALITY_UPDATE',
      action: (ev) =>
        `Editou a modalidade "${updatedModality.name}" no evento "${ev}"`,
      extra: {
        modalityId,
        fieldsEdited: Object.keys(updateModalityDto),
      },
    });

    return {
      message: 'Modality updated successfully',
      data: { modality: updatedModality },
    };
  }

  async remove(
    userId: string,
    eventId: string,
    modalityId: string,
    clientIp?: string | null,
  ) {
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

    await this.auditService.recordForEvent(eventId, {
      actorUserId: userId,
      ip: clientIp,
      kind: 'MODALITY_DELETE',
      action: (ev) =>
        `Excluiu a modalidade "${modality.name}" do evento "${ev}"`,
      extra: { modalityId },
    });

    return {
      message: 'Modality deleted successfully',
    };
  }

  private async verifyOrganizerAccess(userId: string, eventId: string) {
    // Verificações de acesso críticas devem usar write client para consistência
    const prismaRead = this.prisma.getReadClient();
    const prismaWrite = this.prisma.getWriteClient();

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

  // Modality Groups methods
  async createGroup(
    userId: string,
    eventId: string,
    createGroupDto: CreateModalityGroupDto,
    clientIp?: string | null,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    // Se order não foi fornecido, usar o último order + 1
    if (createGroupDto.order === undefined) {
      const lastGroup = await prismaWrite.modalityGroup.findFirst({
        where: { eventId },
        orderBy: { order: 'desc' },
      });
      createGroupDto.order = lastGroup ? lastGroup.order + 1 : 0;
    }

    const group = await prismaWrite.modalityGroup.create({
      data: {
        name: createGroupDto.name,
        order: createGroupDto.order,
        eventId,
      },
    });

    await this.auditService.recordForEvent(eventId, {
      actorUserId: userId,
      ip: clientIp,
      kind: 'MODALITY_GROUP_CREATE',
      action: (ev) => `Criou o grupo "${group.name}" no evento "${ev}"`,
      extra: { groupId: group.id },
    });

    return {
      message: 'Modality group created successfully',
      data: { group },
    };
  }

  async findAllGroups(eventId: string) {
    const prismaRead = this.prisma.getReadClient();

    const groups = await prismaRead.modalityGroup.findMany({
      where: { eventId },
      orderBy: { order: 'asc' },
      include: {
        modalities: {
          where: { isActive: true },
          orderBy: { order: 'asc' },
        },
      },
    });

    return {
      message: 'Modality groups fetched successfully',
      data: { groups },
    };
  }

  async updateGroup(
    userId: string,
    eventId: string,
    groupId: string,
    updateGroupDto: UpdateModalityGroupDto,
    clientIp?: string | null,
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

    await this.auditService.recordForEvent(eventId, {
      actorUserId: userId,
      ip: clientIp,
      kind: 'MODALITY_GROUP_UPDATE',
      action: (ev) => `Editou o grupo "${updatedGroup.name}" no evento "${ev}"`,
      extra: {
        groupId,
        fieldsEdited: Object.keys(updateGroupDto),
      },
    });

    return {
      message: 'Modality group updated successfully',
      data: { group: updatedGroup },
    };
  }

  async removeGroup(
    userId: string,
    eventId: string,
    groupId: string,
    clientIp?: string | null,
  ) {
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

    // Validar se há modalidades associadas ao grupo
    if (group.modalities.length > 0) {
      throw new BadRequestException('Cannot delete group with associated modalities');
    }

    await prismaWrite.modalityGroup.delete({
      where: { id: groupId },
    });

    await this.auditService.recordForEvent(eventId, {
      actorUserId: userId,
      ip: clientIp,
      kind: 'MODALITY_GROUP_DELETE',
      action: (ev) => `Excluiu o grupo "${group.name}" do evento "${ev}"`,
      extra: { groupId },
    });

    return {
      message: 'Modality group deleted successfully',
    };
  }
}
