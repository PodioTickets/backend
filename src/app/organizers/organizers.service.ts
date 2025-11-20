import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrganizerDto, UpdateOrganizerDto } from './dto/create-organizer.dto';
import { EmailService } from '../../common/services/email.service';
import { WhatsAppService } from '../../common/services/whatsapp.service';

@Injectable()
export class OrganizersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly whatsappService: WhatsAppService,
  ) {}

  async create(userId: string, createOrganizerDto: CreateOrganizerDto) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se o usuário já é organizador
    const existingOrganizer = await prismaRead.organizer.findUnique({
      where: { userId },
    });

    if (existingOrganizer) {
      throw new BadRequestException('User is already an organizer');
    }

    const organizer = await prismaWrite.organizer.create({
      data: {
        ...createOrganizerDto,
        userId,
      },
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
    });

    // Atualizar role do usuário
    await prismaWrite.user.update({
      where: { id: userId },
      data: { role: 'ORGANIZER' },
    });

    return {
      message: 'Organizer created successfully',
      data: { organizer },
    };
  }

  async findOne(userId: string) {
    const prismaRead = this.prisma.getReadClient();
    
    const organizer = await prismaRead.organizer.findUnique({
      where: { userId },
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
        events: {
          include: {
            _count: {
              select: {
                registrations: true,
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });

    if (!organizer) {
      throw new NotFoundException('Organizer not found');
    }

    return {
      message: 'Organizer fetched successfully',
      data: { organizer },
    };
  }

  async update(userId: string, updateOrganizerDto: UpdateOrganizerDto) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const organizer = await prismaRead.organizer.findUnique({
      where: { userId },
    });

    if (!organizer) {
      throw new NotFoundException('Organizer not found');
    }

    const updatedOrganizer = await prismaWrite.organizer.update({
      where: { userId },
      data: updateOrganizerDto,
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
    });

    return {
      message: 'Organizer updated successfully',
      data: { organizer: updatedOrganizer },
    };
  }

  async sendContactMessage(organizerId: string, contactData: {
    name: string;
    email: string;
    phone?: string;
    message: string;
    eventId?: string;
    userId?: string;
  }) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const organizer = await prismaRead.organizer.findUnique({
      where: { id: organizerId },
      include: {
        user: {
          select: {
            email: true,
            phone: true,
          },
        },
        events: {
          where: contactData.eventId ? { id: contactData.eventId } : undefined,
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!organizer) {
      throw new NotFoundException('Organizer not found');
    }

    const event = contactData.eventId ? organizer.events[0] : undefined;

    // Criar mensagem no banco
    const contactMessage = await prismaWrite.contactMessage.create({
      data: {
        organizerId,
        userId: contactData.userId,
        eventId: contactData.eventId,
        name: contactData.name,
        email: contactData.email,
        phone: contactData.phone,
        message: contactData.message,
      },
    });

    // Enviar email
    try {
      await this.emailService.sendContactMessageToOrganizer({
        organizerEmail: organizer.email,
        organizerName: organizer.name,
        userName: contactData.name,
        userEmail: contactData.email,
        userPhone: contactData.phone,
        eventName: event?.name,
        message: contactData.message,
      });
    } catch (error) {
      // Log error but don't fail the request
      console.error('Failed to send email:', error);
    }

    // Enviar WhatsApp se disponível
    if (organizer.user.phone) {
      try {
        await this.whatsappService.sendContactMessageToOrganizer({
          organizerPhone: organizer.user.phone,
          organizerName: organizer.name,
          userName: contactData.name,
          userEmail: contactData.email,
          userPhone: contactData.phone,
          eventName: event?.name,
          message: contactData.message,
        });
      } catch (error) {
        // Log error but don't fail the request
        console.error('Failed to send WhatsApp:', error);
      }
    }

    return {
      message: 'Message sent successfully',
      data: { contactMessage },
    };
  }
}
