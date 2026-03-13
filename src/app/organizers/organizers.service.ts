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

    // Verificar se o usuário já é organizador (já tem uma organização como OWNER)
    const existingMember = await prismaRead.organizationMember.findFirst({
      where: {
        userId,
        role: 'OWNER',
      },
    });

    if (existingMember) {
      throw new BadRequestException('User is already an organizer');
    }

    // Criar organização e membro OWNER em uma transação
    const result = await prismaWrite.$transaction(async (tx) => {
      // Criar a organização
      const organization = await tx.organization.create({
        data: {
          name: createOrganizerDto.name,
          email: createOrganizerDto.email,
          phone: createOrganizerDto.phone,
          description: createOrganizerDto.description,
        },
      });

      // Criar o membro da organização com role OWNER (o organizador)
      const member = await tx.organizationMember.create({
        data: {
          organizationId: organization.id,
          userId,
          role: 'OWNER',
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
          organization: true,
        },
      });

      // Atualizar role e accountType do usuário (accountType é usado no login/organizer)
      await tx.user.update({
        where: { id: userId },
        data: { role: 'ORGANIZER', accountType: 'ORGANIZER' },
      });

      return { organization, member };
    });

    return {
      message: 'Organizer created successfully',
      data: {
        organization: result.organization,
        member: result.member,
      },
    };
  }

  async findOne(userId: string) {
    const prismaRead = this.prisma.getReadClient();
    
    // Buscar o membro OWNER (organizador) do usuário
    const member = await prismaRead.organizationMember.findFirst({
      where: {
        userId,
        role: 'OWNER',
      },
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
        organization: {
          include: {
            members: {
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
        },
      },
    });

    if (!member) {
      throw new NotFoundException('Organizer not found');
    }

    return {
      message: 'Organizer fetched successfully',
      data: {
        organization: member.organization,
        member,
      },
    };
  }

  async update(userId: string, updateOrganizerDto: UpdateOrganizerDto) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Buscar o membro OWNER (organizador) do usuário
    const member = await prismaRead.organizationMember.findFirst({
      where: {
        userId,
        role: 'OWNER',
      },
      include: {
        organization: true,
      },
    });

    if (!member) {
      throw new NotFoundException('Organizer not found');
    }

    // Atualizar a organização
    const updatedOrganization = await prismaWrite.organization.update({
      where: { id: member.organizationId },
      data: updateOrganizerDto,
      include: {
        members: {
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
      message: 'Organizer updated successfully',
      data: {
        organization: updatedOrganization,
      },
    };
  }

  async sendContactMessage(organizationId: string, contactData: {
    name: string;
    email: string;
    phone?: string;
    message: string;
    eventId?: string;
    userId?: string;
  }) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const organization = await prismaRead.organization.findUnique({
      where: { id: organizationId },
      include: {
        members: {
          where: { role: 'OWNER' },
          include: {
            user: {
              select: {
                email: true,
                phone: true,
              },
            },
          },
          take: 1,
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

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const owner = organization.members[0];
    const event = contactData.eventId ? organization.events[0] : undefined;

    // Criar mensagem no banco
    const contactMessage = await prismaWrite.contactMessage.create({
      data: {
        organizationId: organization.id,
        userId: contactData.userId || null,
        eventId: contactData.eventId || null,
        name: contactData.name,
        email: contactData.email,
        phone: contactData.phone || null,
        message: contactData.message,
      },
    });

    // Enviar email
    try {
      await this.emailService.sendContactMessageToOrganizer({
        organizerEmail: organization.email,
        organizerName: organization.name,
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
    if (owner?.user.phone) {
      try {
        await this.whatsappService.sendContactMessageToOrganizer({
          organizerPhone: owner.user.phone,
          organizerName: organization.name,
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
