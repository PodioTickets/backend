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
  type SearchEventsDto,
} from './dto/create-event.dto';
import {
  CreateEventTopicDto,
  UpdateEventTopicDto,
  CreateEventLocationDto,
} from './dto/event-topic.dto';
import { EventStatus } from '@prisma/client';
import { generateSlug, generateUniqueSlug } from '../../helpers/SlugHelper';

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Valida se uma string é um UUID válido
   */
  private isValidUUID(id: string): boolean {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
  }

  /**
   * Valida UUID e lança exceção se inválido
   */
  private validateUUID(id: string, fieldName: string = 'ID'): void {
    if (!this.isValidUUID(id)) {
      throw new BadRequestException(
        `Invalid ${fieldName} format. Expected UUID.`,
      );
    }
  }

  /**
   * Verifica se um slug já existe no banco de dados
   */
  private async slugExists(slug: string, excludeEventId?: string): Promise<boolean> {
    const prismaRead = this.prisma.getReadClient();
    const event = await prismaRead.event.findUnique({
      where: { slug },
      select: { id: true },
    });
    
    if (!event) return false;
    
    // Se estamos atualizando um evento, ignorar o próprio evento
    if (excludeEventId && event.id === excludeEventId) {
      return false;
    }
    
    return true;
  }

  /**
   * Gera um slug único para o evento
   */
  private async generateEventSlug(
    name: string,
    customSlug?: string,
    excludeEventId?: string,
  ): Promise<string> {
    const baseSlug = customSlug || name;
    return generateUniqueSlug(baseSlug, (slug) =>
      this.slugExists(slug, excludeEventId),
    );
  }

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

    // Gerar slug único
    const slug = await this.generateEventSlug(
      createEventDto.name,
      createEventDto.slug,
    );

    const event = await prismaWrite.event.create({
      data: {
        ...createEventDto,
        slug,
        organizerId: organizer.id,
        eventDate: new Date(createEventDto.eventDate),
        registrationStartDate: new Date(createEventDto.registrationStartDate),
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

    return {
      message: 'Event created successfully',
      data: { event },
    };
  }

  async search(searchDto: SearchEventsDto) {
    const {
      q,
      country,
      state,
      city,
      startDate,
      endDate,
      status,
      includePast = false,
      page = 1,
      limit = 20,
    } = searchDto;

    const where: any = {
      status: status || EventStatus.PUBLISHED,
    };

    if (q && q.trim().length > 0) {
      const searchTerm = q.trim();
      where.OR = [
        {
          name: {
            contains: searchTerm,
            mode: 'insensitive',
          },
        },
        {
          description: {
            contains: searchTerm,
            mode: 'insensitive',
          },
        },
        {
          location: {
            contains: searchTerm,
            mode: 'insensitive',
          },
        },
        {
          city: {
            contains: searchTerm,
            mode: 'insensitive',
          },
        },
        {
          state: {
            contains: searchTerm,
            mode: 'insensitive',
          },
        },
      ];
    }

    // Filtros de localização
    if (country) {
      where.country = country;
    }

    if (state) {
      where.state = state;
    }

    if (city) {
      where.city = city;
    }

    // Filtro de data
    if (startDate && endDate) {
      where.eventDate = {
        gte: new Date(startDate),
        lte: new Date(endDate),
      };
    } else if (!includePast) {
      // Por padrão, apenas eventos futuros
      where.eventDate = {
        gte: new Date(),
      };
    }

    // Usar read replica para performance
    const prismaRead = this.prisma.getReadClient();

    // Buscar eventos e total em paralelo
    const [events, total] = await Promise.all([
      prismaRead.event.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          description: true,
          bannerUrl: true,
          logoUrl: true,
          location: true,
          city: true,
          state: true,
          country: true,
          eventDate: true,
          registrationStartDate: true,
          registrationEndDate: true,
          status: true,
          createdAt: true,
          organizer: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          _count: {
            select: {
              registrations: true,
              modalities: true,
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
      message: 'Events search completed successfully',
      data: {
        events,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        query: q || null,
      },
    };
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

  /**
   * Busca eventos de um organizador de forma performática
   * Usa read replica e índice [organizerId, createdAt]
   */
  async findByOrganizer(
    userId: string,
    filterDto: {
      page?: number;
      limit?: number;
      status?: EventStatus;
      includePast?: boolean;
      startDate?: string;
      endDate?: string;
      name?: string;
    } = {},
  ) {
    const {
      page = 1,
      limit = 20,
      status,
      includePast = false,
      startDate,
      endDate,
      name,
    } = filterDto;

    const prismaRead = this.prisma.getReadClient();

    // Buscar organizerId do userId
    const organizer = await prismaRead.organizer.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!organizer) {
      throw new BadRequestException('User is not an organizer');
    }

    // Construir where clause otimizado para usar índice [organizerId, createdAt]
    const where: any = {
      organizerId: organizer.id, // Usa o índice
    };

    // Filtro por status
    if (status) {
      where.status = status;
    }

    // Filtro por data
    if (startDate && endDate) {
      where.eventDate = {
        gte: new Date(startDate),
        lte: new Date(endDate),
      };
    } else if (!includePast) {
      // Por padrão, apenas eventos futuros
      where.eventDate = {
        gte: new Date(),
      };
    }

    // Filtro por nome
    if (name) {
      where.name = {
        contains: name,
        mode: 'insensitive',
      };
    }

    // Query performática usando Promise.all para paralelizar
    const [events, total] = await Promise.all([
      prismaRead.event.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        select: {
          // Selecionar apenas campos necessários para performance
          id: true,
          name: true,
          description: true,
          bannerUrl: true,
          logoUrl: true,
          location: true,
          city: true,
          state: true,
          country: true,
          eventDate: true,
          registrationEndDate: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          // Contadores úteis sem carregar relações completas
          _count: {
            select: {
              registrations: true,
              modalities: true,
            },
          },
        },
        // Ordenar por createdAt desc para usar índice [organizerId, createdAt]
        orderBy: {
          createdAt: 'desc',
        },
      }),
      prismaRead.event.count({ where }),
    ]);

    return {
      message: 'Organizer events fetched successfully',
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
    this.validateUUID(id, 'event ID');

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
            template: {
              select: {
                id: true,
                code: true,
                label: true,
                icon: true,
              },
            },
          },
          where: { isActive: true },
          orderBy: { order: 'asc' },
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

  async findBySlug(slug: string) {
    if (!slug || slug.trim().length === 0) {
      throw new BadRequestException('Slug is required');
    }

    // Usar read replica para query de leitura
    const prismaRead = this.prisma.getReadClient();

    const event = await prismaRead.event.findUnique({
      where: { slug },
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
            template: {
              select: {
                id: true,
                code: true,
                label: true,
                icon: true,
              },
            },
          },
          where: { isActive: true },
          orderBy: { order: 'asc' },
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
    this.validateUUID(id, 'event ID');
    const prismaWrite = this.prisma.getWriteClient();

    const organizer = await prismaWrite.organizer.findUnique({
      where: { userId },
    });

    if (!organizer) throw new BadRequestException('User is not an organizer');

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
    
    // Gerar slug se o nome ou slug foi alterado
    if (updateEventDto.name || updateEventDto.slug) {
      const nameForSlug = updateEventDto.name || event.name;
      const customSlug = updateEventDto.slug;
      updateData.slug = await this.generateEventSlug(
        nameForSlug,
        customSlug,
        id,
      );
    }
    
    if (updateEventDto.eventDate) {
      updateData.eventDate = new Date(updateEventDto.eventDate);
    }
    if (updateEventDto.registrationStartDate) {
      updateData.registrationStartDate = new Date(
        updateEventDto.registrationStartDate,
      );
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
    this.validateUUID(id, 'event ID');

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
    this.validateUUID(topicId, 'topic ID');
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
    this.validateUUID(topicId, 'topic ID');
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
    this.validateUUID(locationId, 'location ID');
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
    this.validateUUID(locationId, 'location ID');
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
    this.validateUUID(eventId, 'event ID');

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
