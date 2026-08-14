import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateTicketCategoryDto,
  UpdateTicketCategoryDto,
  ReorderTicketCategoriesDto,
} from './dto/create-ticket-category.dto';
import { stripDeletedCategoryFromKitSelectionDisplay } from '../events/kit-selection-display.prune';
import { OrganizationAuditService } from '../../common/services/organization-audit.service';

@Injectable()
export class TicketCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OrganizationAuditService,
  ) {}

  /** JSON da API usa `sortOrder`; no Prisma o campo do modelo é `order` (@map "sortOrder" no DB). */
  private categoryToApi<T extends { order: number }>(
    c: T,
  ): Omit<T, 'order'> & { sortOrder: number } {
    const { order, ...rest } = c;
    return { ...rest, sortOrder: order } as Omit<T, 'order'> & { sortOrder: number };
  }

  async create(
    userId: string,
    eventId: string,
    createCategoryDto: CreateTicketCategoryDto,
    clientIp?: string | null,
  ) {
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

    await this.auditService.recordForEvent(eventId, {
      actorUserId: userId,
      ip: clientIp,
      kind: 'TICKET_CATEGORY_CREATE',
      action: (ev) => `Criou a categoria "${category.name}" no evento "${ev}"`,
      extra: { categoryId: category.id },
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
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
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
    clientIp?: string | null,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const category = await prismaWrite.ticketCategory.findUnique({
      where: { id: categoryId },
    });

    if (!category || category.eventId !== eventId) {
      throw new NotFoundException('Categoria de ingresso não encontrada');
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

    await this.auditService.recordForEvent(eventId, {
      actorUserId: userId,
      ip: clientIp,
      kind: 'TICKET_CATEGORY_UPDATE',
      action: (ev) => `Editou a categoria "${updatedCategory.name}" no evento "${ev}"`,
      extra: { categoryId, fieldsEdited: Object.keys(updateCategoryDto) },
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
    clientIp?: string | null,
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
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    await this.auditService.recordForEvent(eventId, {
      actorUserId: userId,
      ip: clientIp,
      kind: 'TICKET_CATEGORY_REORDER',
      action: (ev) => `Reordenou as categorias do evento "${ev}"`,
      extra: { categoryIds: incoming },
    });

    return {
      message: 'Ticket categories reordered successfully',
      data: { categories: categories.map((c) => this.categoryToApi(c)) },
    };
  }

  async remove(
    userId: string,
    eventId: string,
    categoryId: string,
    clientIp?: string | null,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const category = await prismaWrite.ticketCategory.findUnique({
      where: { id: categoryId },
      include: {
        tickets: true,
      },
    });

    if (!category || category.eventId !== eventId) {
      throw new NotFoundException('Categoria de ingresso não encontrada');
    }

    // Validar se há ingressos associados à categoria
    if (category.tickets.length > 0) {
      throw new BadRequestException('Não é possível excluir categoria com ingressos associados');
    }

    // Hard delete + limpeza de kitSelectionDisplay na mesma tx: o categoryId
    // pode estar como chave em primaryKitProductByCategoryId e quebraria a
    // validação no próximo PATCH /events/:id se ficasse órfão.
    await prismaWrite.$transaction(async (tx) => {
      const ev = await tx.event.findUnique({
        where: { id: eventId },
        select: { kitSelectionDisplay: true },
      });
      if (ev?.kitSelectionDisplay != null) {
        const { next, changed } = stripDeletedCategoryFromKitSelectionDisplay(
          ev.kitSelectionDisplay,
          categoryId,
        );
        if (changed) {
          await tx.event.update({
            where: { id: eventId },
            data: { kitSelectionDisplay: next },
          });
        }
      }
      await tx.ticketCategory.delete({ where: { id: categoryId } });
    });

    await this.auditService.recordForEvent(eventId, {
      actorUserId: userId,
      ip: clientIp,
      kind: 'TICKET_CATEGORY_DELETE',
      action: (ev) => `Excluiu a categoria "${category.name}" do evento "${ev}"`,
      extra: { categoryId },
    });

    return {
      message: 'Ticket category deleted successfully',
    };
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
