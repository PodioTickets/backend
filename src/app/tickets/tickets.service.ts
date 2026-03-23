import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTicketDto, UpdateTicketDto, FilterTicketsDto } from './dto/create-ticket.dto';

@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, eventId: string, createTicketDto: CreateTicketDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Validações
    if (createTicketDto.batches.length === 0) {
      throw new BadRequestException('Ticket must have at least one batch');
    }

    // Validar ageLimit
    if (createTicketDto.ageLimit && !createTicketDto.ageLimit.min && !createTicketDto.ageLimit.max) {
      throw new BadRequestException('ageLimit must have at least min or max');
    }

    // Validar categoryId se fornecido
    if (createTicketDto.categoryId) {
      const category = await prismaRead.ticketCategory.findUnique({
        where: { id: createTicketDto.categoryId },
      });
      if (!category || category.eventId !== eventId) {
        throw new NotFoundException('Ticket category not found');
      }
    }

    // Validar kitId se fornecido
    if (createTicketDto.hasKit && createTicketDto.kitId) {
      const kit = await prismaRead.kit.findUnique({
        where: { id: createTicketDto.kitId },
      });
      if (!kit || kit.eventId !== eventId) {
        throw new NotFoundException('Kit not found');
      }
    }

    // Validar productIds se fornecido
    if (createTicketDto.hasKit && createTicketDto.productIds && createTicketDto.productIds.length > 0) {
      const products = await prismaRead.product.findMany({
        where: {
          id: { in: createTicketDto.productIds },
          eventId,
        },
      });
      if (products.length !== createTicketDto.productIds.length) {
        throw new NotFoundException('One or more products not found');
      }
    }

    // Criar ticket com batches
    const ticket = await prismaWrite.ticket.create({
      data: {
        name: createTicketDto.name,
        description: createTicketDto.description,
        categoryId: createTicketDto.categoryId,
        modality: createTicketDto.modality,
        distance: createTicketDto.distance,
        distanceUnit: createTicketDto.distanceUnit || 'KM',
        gender: createTicketDto.gender || 'all',
        ageLimitMin: createTicketDto.ageLimit?.min,
        ageLimitMax: createTicketDto.ageLimit?.max,
        hasKit: createTicketDto.hasKit || false,
        kitId: createTicketDto.kitId,
        eventId,
        batches: {
          create: createTicketDto.batches.map((b) => ({
            quantity: b.quantity,
            price: b.price,
            startDate: b.startDate ? new Date(b.startDate) : null,
            endDate: b.endDate ? new Date(b.endDate) : null,
          })),
        },
        products: createTicketDto.productIds
          ? {
              create: createTicketDto.productIds.map((productId) => ({
                productId,
              })),
            }
          : undefined,
      },
      include: {
        batches: true,
        products: {
          include: {
            product: true,
          },
        },
        category: true,
        kit: true,
      },
    });

    return {
      message: 'Ticket created successfully',
      data: { ticket },
    };
  }

  async findAll(eventId: string, filterDto: FilterTicketsDto = {}) {
    const prismaRead = this.prisma.getReadClient();

    const page = filterDto.page || 1;
    const limit = filterDto.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = { eventId, isActive: true };
    if (filterDto.categoryId) {
      where.categoryId = filterDto.categoryId;
    }

    const [tickets, total] = await Promise.all([
      prismaRead.ticket.findMany({
        where,
        skip,
        take: limit,
        include: {
          batches: {
            orderBy: { price: 'asc' },
          },
          products: {
            include: {
              product: {
                include: {
                  variations: true,
                },
              },
            },
          },
          category: true,
          kit: {
            include: {
              items: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prismaRead.ticket.count({ where }),
    ]);

    const batchIds = tickets.flatMap((t) => t.batches.map((b) => b.id));
    const soldByBatch =
      batchIds.length > 0
        ? await prismaRead.registrationTicket.groupBy({
            by: ['batchId'],
            where: { batchId: { in: batchIds } },
            _count: { id: true },
          })
        : [];
    const soldByBatchMap = new Map(
      soldByBatch.map((s) => [s.batchId, s._count.id]),
    );

    // Transformar para o formato esperado
    const transformedTickets = tickets.map((ticket) => ({
      ...ticket,
      price: ticket.batches[0]?.price || 0, // Preço do primeiro lote
      batches: ticket.batches.map((batch) => ({
        ...batch,
        quantitySold: soldByBatchMap.get(batch.id) ?? 0,
      })),
      ageLimit: {
        min: ticket.ageLimitMin,
        max: ticket.ageLimitMax,
      },
      productIds: ticket.products.map((tp) => tp.productId),
    }));

    const totalPages = Math.ceil(total / limit);

    return {
      message: 'Tickets fetched successfully',
      data: {
        tickets: transformedTickets,
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
    const ticket = await prismaRead.ticket.findUnique({
      where: { id },
      include: {
        batches: {
          orderBy: { price: 'asc' },
        },
        products: {
          include: {
            product: {
              include: {
                variations: true,
              },
            },
          },
        },
        category: true,
        kit: {
          include: {
            items: true,
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

    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }

    const batchIds = ticket.batches.map((b) => b.id);
    const soldByBatch =
      batchIds.length > 0
        ? await prismaRead.registrationTicket.groupBy({
            by: ['batchId'],
            where: {
              ticketId: id,
              batchId: { in: batchIds },
            },
            _count: { id: true },
          })
        : [];
    const soldByBatchMap = new Map(
      soldByBatch.map((s) => [s.batchId, s._count.id]),
    );

    const batchesWithSold = ticket.batches.map((batch) => ({
      ...batch,
      quantitySold: soldByBatchMap.get(batch.id) ?? 0,
    }));

    const transformed = {
      ...ticket,
      batches: batchesWithSold,
      ageLimit: {
        min: ticket.ageLimitMin,
        max: ticket.ageLimitMax,
      },
      productIds: ticket.products.map((tp) => tp.productId),
    };

    return {
      message: 'Ticket fetched successfully',
      data: { ticket: transformed },
    };
  }

  async update(userId: string, eventId: string, ticketId: string, updateTicketDto: UpdateTicketDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const ticket = await prismaRead.ticket.findUnique({
      where: { id: ticketId },
      include: {
        registrations: true,
      },
    });

    if (!ticket || ticket.eventId !== eventId) {
      throw new NotFoundException('Ticket not found');
    }

    // Validações similares ao create
    if (updateTicketDto.batches && updateTicketDto.batches.length === 0) {
      throw new BadRequestException('Ticket must have at least one batch');
    }

    if (updateTicketDto.ageLimit && !updateTicketDto.ageLimit.min && !updateTicketDto.ageLimit.max) {
      throw new BadRequestException('ageLimit must have at least min or max');
    }

    const updateData: any = {
      ...updateTicketDto,
      ageLimitMin: updateTicketDto.ageLimit?.min,
      ageLimitMax: updateTicketDto.ageLimit?.max,
    };
    delete updateData.batches;
    delete updateData.productIds;
    delete updateData.ageLimit;

    if (updateTicketDto.batches) {
      const existingBatches = await prismaRead.ticketBatch.findMany({
        where: { ticketId },
        select: { id: true },
      });
      const existingIds = new Set(existingBatches.map((b) => b.id));

      const soldAgg = await prismaRead.registrationTicket.groupBy({
        by: ['batchId'],
        where: { ticketId, batchId: { not: null } },
        _count: { id: true },
      });
      const soldByBatch = new Map<string, number>(
        soldAgg.map((r) => [r.batchId!, r._count.id]),
      );

      const seenDtoIds = new Set<string>();
      for (const b of updateTicketDto.batches) {
        if (b.id) {
          if (seenDtoIds.has(b.id)) {
            throw new BadRequestException(`Duplicate batch id: ${b.id}`);
          }
          seenDtoIds.add(b.id);
          if (!existingIds.has(b.id)) {
            throw new BadRequestException(
              `Batch id does not belong to this ticket: ${b.id}`,
            );
          }
        }
      }

      const dtoIdSet = new Set(
        updateTicketDto.batches
          .map((b) => b.id)
          .filter((id): id is string => Boolean(id)),
      );

      for (const eid of existingIds) {
        if (!dtoIdSet.has(eid)) {
          const sold = soldByBatch.get(eid) ?? 0;
          if (sold > 0) {
            throw new BadRequestException(
              `Cannot remove a batch that has sales (${sold} registration(s)). Include its id in batches to keep it.`,
            );
          }
        }
      }

      for (const b of updateTicketDto.batches) {
        const sold = b.id ? (soldByBatch.get(b.id) ?? 0) : 0;
        if (b.quantity < sold) {
          throw new BadRequestException(
            `Batch quantity cannot be less than the number already sold (${sold})`,
          );
        }
      }
    }

    // Atualizar products se fornecido
    if (updateTicketDto.productIds !== undefined) {
      // Validar productIds se fornecido
      if (updateTicketDto.productIds.length > 0) {
        // Usa prismaWrite para evitar problemas de réplica de leitura
        // Primeiro verifica se os produtos existem (independente do evento)
        const allProducts = await prismaWrite.product.findMany({
          where: {
            id: { in: updateTicketDto.productIds },
          },
          select: {
            id: true,
            eventId: true,
            name: true,
          },
        });
        
        // Verifica se todos os produtos foram encontrados
        const foundIds = allProducts.map(p => p.id);
        const missingIds = updateTicketDto.productIds.filter(id => !foundIds.includes(id));
        
        if (missingIds.length > 0) {
          throw new NotFoundException(`Products not found: ${missingIds.join(', ')}`);
        }
        
        // Verifica se todos os produtos pertencem ao mesmo evento
        const wrongEventProducts = allProducts.filter(p => p.eventId !== eventId);
        if (wrongEventProducts.length > 0) {
          const productNames = wrongEventProducts.map(p => p.name).join(', ');
          throw new BadRequestException(
            `Products do not belong to this event: ${productNames}`
          );
        }
      }
      
      // Remove products do updateData para atualizar separadamente
      // Isso evita problemas de constraint ao fazer delete + create na mesma operação
      updateData.products = undefined;
    }

    // Usa transação para garantir atomicidade
    const updatedTicket = await prismaWrite.$transaction(async (tx) => {
      // Atualizar produtos primeiro, se necessário
      if (updateTicketDto.productIds !== undefined) {
        // Deletar produtos existentes
        await tx.ticketProduct.deleteMany({
          where: { ticketId },
        });
        
        // Criar novos produtos se houver
        if (updateTicketDto.productIds.length > 0) {
          await tx.ticketProduct.createMany({
            data: updateTicketDto.productIds.map((productId) => ({
              ticketId,
              productId,
            })),
          });
        }
      }

      if (updateTicketDto.batches) {
        const stillExisting = await tx.ticketBatch.findMany({
          where: { ticketId },
          select: { id: true },
        });
        const stillIds = new Set(stillExisting.map((b) => b.id));
        const keepIds = new Set(
          updateTicketDto.batches
            .map((b) => b.id)
            .filter((id): id is string => Boolean(id)),
        );
        for (const eid of stillIds) {
          if (!keepIds.has(eid)) {
            await tx.ticketBatch.delete({ where: { id: eid } });
          }
        }
        for (const b of updateTicketDto.batches) {
          const data = {
            quantity: b.quantity,
            price: b.price,
            startDate: b.startDate ? new Date(b.startDate) : null,
            endDate: b.endDate ? new Date(b.endDate) : null,
          };
          if (b.id) {
            await tx.ticketBatch.update({
              where: { id: b.id },
              data,
            });
          } else {
            await tx.ticketBatch.create({
              data: { ...data, ticketId },
            });
          }
        }
      }

      // Atualizar o ticket
      return await tx.ticket.update({
        where: { id: ticketId },
        data: updateData,
        include: {
          batches: true,
          products: {
            include: {
              product: true,
            },
          },
          category: true,
          kit: true,
        },
      });
    });

    const batchIdsAfter = updatedTicket.batches.map((b) => b.id);
    const soldAfterUpdate =
      batchIdsAfter.length > 0
        ? await prismaRead.registrationTicket.groupBy({
            by: ['batchId'],
            where: { ticketId, batchId: { in: batchIdsAfter } },
            _count: { id: true },
          })
        : [];
    const soldAfterMap = new Map(
      soldAfterUpdate.map((s) => [s.batchId!, s._count.id]),
    );

    const transformed = {
      ...updatedTicket,
      batches: updatedTicket.batches.map((batch) => ({
        ...batch,
        quantitySold: soldAfterMap.get(batch.id) ?? 0,
      })),
      ageLimit: {
        min: updatedTicket.ageLimitMin,
        max: updatedTicket.ageLimitMax,
      },
      productIds: updatedTicket.products.map((tp) => tp.productId),
    };

    return {
      message: 'Ticket updated successfully',
      data: { ticket: transformed },
    };
  }

  async remove(userId: string, eventId: string, ticketId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const ticket = await prismaWrite.ticket.findUnique({
      where: { id: ticketId },
      include: {
        registrations: true,
      },
    });

    if (!ticket || ticket.eventId !== eventId) {
      throw new NotFoundException('Ticket not found');
    }

    // Validar se o ingresso já foi vendido
    if (ticket.registrations.length > 0) {
      throw new BadRequestException('Cannot delete ticket that has been sold');
    }

    await prismaWrite.ticket.delete({
      where: { id: ticketId },
    });

    return {
      message: 'Ticket deleted successfully',
    };
  }

  async duplicate(userId: string, eventId: string, ticketId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Buscar o ticket original com todas as relações
    const originalTicket = await prismaRead.ticket.findUnique({
      where: { id: ticketId },
      include: {
        batches: true,
        products: true,
      },
    });

    if (!originalTicket || originalTicket.eventId !== eventId) {
      throw new NotFoundException('Ticket not found');
    }

    // Criar novo ticket com os mesmos dados, mas com novo nome (adicionando "Cópia")
    const duplicatedTicket = await prismaWrite.ticket.create({
      data: {
        name: `${originalTicket.name} (Cópia)`,
        categoryId: originalTicket.categoryId,
        modality: originalTicket.modality,
        distance: originalTicket.distance,
        distanceUnit: originalTicket.distanceUnit,
        gender: originalTicket.gender,
        ageLimitMin: originalTicket.ageLimitMin,
        ageLimitMax: originalTicket.ageLimitMax,
        hasKit: originalTicket.hasKit,
        kitId: originalTicket.kitId,
        eventId: originalTicket.eventId,
        isActive: originalTicket.isActive,
        batches: {
          create: originalTicket.batches.map((batch) => ({
            quantity: batch.quantity,
            price: batch.price,
            startDate: batch.startDate,
            endDate: batch.endDate,
          })),
        },
        products: originalTicket.products.length > 0
          ? {
              create: originalTicket.products.map((tp) => ({
                productId: tp.productId,
              })),
            }
          : undefined,
      },
      include: {
        batches: true,
        products: {
          include: {
            product: true,
          },
        },
        category: true,
        kit: true,
      },
    });

    const transformed = {
      ...duplicatedTicket,
      ageLimit: {
        min: duplicatedTicket.ageLimitMin,
        max: duplicatedTicket.ageLimitMax,
      },
      productIds: duplicatedTicket.products.map((tp) => tp.productId),
    };

    return {
      message: 'Ticket duplicated successfully',
      data: { ticket: transformed },
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
