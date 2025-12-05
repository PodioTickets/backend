import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateEventDto,
  UpdateEventDto,
  FilterEventsDto,
} from './dto/create-event.dto';
import {
  CreateEventTopicDto,
  UpdateEventTopicDto,
  CreateEventLocationDto,
} from './dto/event-topic.dto';
import { EventStatus } from '@prisma/client';

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, createEventDto: CreateEventDto) {
    // Verificar se o usuário é organizador - usar write client
    const prismaWrite = this.prisma.getWriteClient();

    const organizer = await prismaWrite.organizer.findUnique({
      where: { userId },
    });

    if (!organizer) {
      throw new BadRequestException('User is not an organizer');
    }

    // Verificar se já existe um evento com o mesmo nome, data e organizador
    const eventDate = new Date(createEventDto.eventDate);
    const existingEvent = await prismaWrite.event.findFirst({
      where: {
        organizerId: organizer.id,
        name: createEventDto.name,
        eventDate: {
          gte: new Date(eventDate.getTime() - 24 * 60 * 60 * 1000), // 1 dia antes
          lte: new Date(eventDate.getTime() + 24 * 60 * 60 * 1000), // 1 dia depois
        },
      },
    });

    if (existingEvent) {
      throw new BadRequestException(
        'An event with the same name and date already exists for this organizer',
      );
    }

    const event = await prismaWrite.event.create({
      data: {
        ...createEventDto,
        organizerId: organizer.id,
        eventDate: new Date(createEventDto.eventDate),
        registrationEndDate: new Date(createEventDto.registrationEndDate),
      },
      include: {
        organizer: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
      },
    });

    // Criar tópicos padrão
    await this.createDefaultTopics(event.id);

    return {
      message: 'Event created successfully',
      data: { event },
    };
  }

  private async createDefaultTopics(eventId: string) {
    const defaultTopics = [
      {
        title: 'Descrição do Evento',
        content: '',
        isDefault: true,
        isEnabled: true,
        order: 1,
      },
      {
        title: 'KIT',
        content: '',
        isDefault: true,
        isEnabled: true,
        order: 2,
      },
      {
        title: 'PREMIAÇÃO',
        content: '',
        isDefault: true,
        isEnabled: true,
        order: 3,
      },
      {
        title: 'REGULAMENTO',
        content: '',
        isDefault: true,
        isEnabled: true,
        order: 4,
      },
    ];

    // Usar write client para criação
    const prismaWrite = this.prisma.getWriteClient();

    await prismaWrite.eventTopic.createMany({
      data: defaultTopics.map((topic) => ({
        ...topic,
        eventId,
      })),
    });
  }

  async findAll(filterDto: FilterEventsDto, userId?: string) {
    const {
      page = 1,
      limit = 10,
      country,
      state,
      city,
      name,
      startDate,
      endDate,
      thisWeek,
      thisMonth,
      status,
      includeDraft,
      includePast,
    } = filterDto;

    const where: any = {};

    // Se não especificar status e não for includeDraft, mostrar apenas PUBLISHED
    // Se for includeDraft e userId for fornecido, mostrar eventos do organizador também
    if (includeDraft && userId) {
      // Buscar eventos do organizador ou eventos publicados
      const prismaRead = this.prisma.getReadClient();
      const organizer = await prismaRead.organizer.findUnique({
        where: { userId },
      });

      if (organizer) {
        where.OR = [
          { status: EventStatus.PUBLISHED },
          { organizerId: organizer.id },
        ];
      } else {
        where.status = status || EventStatus.PUBLISHED;
      }
    } else {
      where.status = status || EventStatus.PUBLISHED;
    }

    // Por padrão, mostrar apenas eventos futuros
    // Se includeDraft=true e userId for fornecido, mostrar todos os eventos do organizador (incluindo passados)
    // Se includePast=true, mostrar eventos passados também
    if (!includeDraft || !userId) {
      if (!includePast) {
        where.eventDate = {
          gte: new Date(), // Apenas eventos futuros
        };
      }
      // Se includePast=true, não filtrar por data (mostrar todos)
    }

    if (country) {
      where.country = country;
    }

    if (state) {
      where.state = state;
    }

    if (city) {
      where.city = city;
    }

    if (name) {
      where.name = {
        contains: name,
        mode: 'insensitive',
      };
    }

    if (thisWeek) {
      const today = new Date();
      const nextWeek = new Date(today);
      nextWeek.setDate(today.getDate() + 7);
      // Se já tiver eventDate definido, combinar com AND
      if (where.eventDate) {
        where.AND = [
          { eventDate: where.eventDate },
          {
            eventDate: {
              gte: today,
              lte: nextWeek,
            },
          },
        ];
        delete where.eventDate;
      } else {
        where.eventDate = {
          gte: today,
          lte: nextWeek,
        };
      }
    }

    if (thisMonth) {
      const today = new Date();
      const nextMonth = new Date(today);
      nextMonth.setMonth(today.getMonth() + 1);
      // Se já tiver eventDate definido, combinar com AND
      if (where.eventDate) {
        where.AND = [
          ...(where.AND || []),
          {
            eventDate: {
              gte: today,
              lte: nextMonth,
            },
          },
        ];
        delete where.eventDate;
      } else {
        where.eventDate = {
          gte: today,
          lte: nextMonth,
        };
      }
    }

    if (startDate && endDate) {
      // Se já tiver eventDate definido, combinar com AND
      if (where.eventDate) {
        where.AND = [
          ...(where.AND || []),
          {
            eventDate: {
              gte: new Date(startDate),
              lte: new Date(endDate),
            },
          },
        ];
        delete where.eventDate;
      } else {
        where.eventDate = {
          gte: new Date(startDate),
          lte: new Date(endDate),
        };
      }
    }

    // Usar read client para operações de leitura
    const prismaRead = this.prisma.getReadClient();

    const [events, total] = await Promise.all([
      prismaRead.event.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          organizer: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: {
          eventDate: 'asc',
        },
      }),
      prismaRead.event.count({ where }),
    ]);

    return {
      message: 'Events fetched successfully',
      data: {
        events,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  async findOne(id: string) {
    // Usar read replica para query de leitura
    const prismaRead = this.prisma.getReadClient();

    const event = await prismaRead.event.findUnique({
      where: { id },
      include: {
        organizer: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
              },
            },
          },
        },
        topics: {
          where: { isEnabled: true },
          orderBy: { order: 'asc' },
        },
        locations: {
          orderBy: { createdAt: 'asc' },
        },
        modalities: {
          include: {
            group: true,
          },
          where: { isActive: true },
          orderBy: [{ group: { order: 'asc' } }, { order: 'asc' }],
        },
        kits: {
          where: { isActive: true },
          include: {
            items: {
              where: { isActive: true },
            },
          },
        },
        questions: {
          where: { isRequired: true },
          orderBy: { order: 'asc' },
        },
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    return {
      message: 'Event fetched successfully',
      data: { event },
    };
  }

  async update(userId: string, id: string, updateEventDto: UpdateEventDto) {
    // Verificar se o usuário é organizador e dono do evento
    const prismaWrite = this.prisma.getWriteClient();
    
    const organizer = await prismaWrite.organizer.findUnique({
      where: { userId },
    });

    if (!organizer) {
      throw new BadRequestException('User is not an organizer');
    }

    const event = await prismaWrite.event.findUnique({
      where: { id },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.organizerId !== organizer.id) {
      throw new BadRequestException('User is not the organizer of this event');
    }

    const updateData: any = { ...updateEventDto };
    if (updateEventDto.eventDate) {
      updateData.eventDate = new Date(updateEventDto.eventDate);
    }
    if (updateEventDto.registrationEndDate) {
      updateData.registrationEndDate = new Date(
        updateEventDto.registrationEndDate,
      );
    }

    const updatedEvent = await prismaWrite.event.update({
      where: { id },
      data: updateData,
      include: {
        organizer: true,
      },
    });

    return {
      message: 'Event updated successfully',
      data: { event: updatedEvent },
    };
  }

  async remove(userId: string, id: string) {
    const prismaWrite = this.prisma.getWriteClient();
    
    const organizer = await prismaWrite.organizer.findUnique({
      where: { userId },
    });

    if (!organizer) {
      throw new BadRequestException('User is not an organizer');
    }

    const event = await prismaWrite.event.findUnique({
      where: { id },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.organizerId !== organizer.id) {
      throw new BadRequestException('User is not the organizer of this event');
    }

    await prismaWrite.event.delete({
      where: { id },
    });

    return {
      message: 'Event deleted successfully',
    };
  }

  // Event Topics
  async createTopic(
    userId: string,
    eventId: string,
    createTopicDto: CreateEventTopicDto,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    
    const topic = await prismaWrite.eventTopic.create({
      data: {
        ...createTopicDto,
        eventId,
      },
    });

    return {
      message: 'Topic created successfully',
      data: { topic },
    };
  }

  async updateTopic(
    userId: string,
    eventId: string,
    topicId: string,
    updateTopicDto: UpdateEventTopicDto,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    
    const topic = await prismaWrite.eventTopic.findUnique({
      where: { id: topicId },
    });

    if (!topic || topic.eventId !== eventId) {
      throw new NotFoundException('Topic not found');
    }

    const updatedTopic = await prismaWrite.eventTopic.update({
      where: { id: topicId },
      data: updateTopicDto,
    });

    return {
      message: 'Topic updated successfully',
      data: { topic: updatedTopic },
    };
  }

  async deleteTopic(userId: string, eventId: string, topicId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    
    const topic = await prismaWrite.eventTopic.findUnique({
      where: { id: topicId },
    });

    if (!topic || topic.eventId !== eventId) {
      throw new NotFoundException('Topic not found');
    }

    if (topic.isDefault) {
      throw new BadRequestException(
        'Cannot delete default topics. Disable them instead.',
      );
    }

    await prismaWrite.eventTopic.delete({
      where: { id: topicId },
    });

    return {
      message: 'Topic deleted successfully',
    };
  }

  // Event Locations
  async createLocation(
    userId: string,
    eventId: string,
    createLocationDto: CreateEventLocationDto,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    
    const location = await prismaWrite.eventLocation.create({
      data: {
        ...createLocationDto,
        eventId,
      },
    });

    return {
      message: 'Location created successfully',
      data: { location },
    };
  }

  async updateLocation(
    userId: string,
    eventId: string,
    locationId: string,
    updateLocationDto: CreateEventLocationDto,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    
    const location = await prismaWrite.eventLocation.findUnique({
      where: { id: locationId },
    });

    if (!location || location.eventId !== eventId) {
      throw new NotFoundException('Location not found');
    }

    const updatedLocation = await prismaWrite.eventLocation.update({
      where: { id: locationId },
      data: updateLocationDto,
    });

    return {
      message: 'Location updated successfully',
      data: { location: updatedLocation },
    };
  }

  async deleteLocation(userId: string, eventId: string, locationId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    
    const location = await prismaWrite.eventLocation.findUnique({
      where: { id: locationId },
    });

    if (!location || location.eventId !== eventId) {
      throw new NotFoundException('Location not found');
    }

    await prismaWrite.eventLocation.delete({
      where: { id: locationId },
    });

    return {
      message: 'Location deleted successfully',
    };
  }

  private async verifyOrganizerAccess(userId: string, eventId: string) {
    // Verificações de acesso críticas devem usar write client para consistência
    const prismaWrite = this.prisma.getWriteClient();

    const organizer = await prismaWrite.organizer.findUnique({
      where: { userId },
    });

    if (!organizer) {
      throw new BadRequestException('User is not an organizer');
    }

    const event = await prismaWrite.event.findUnique({
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
