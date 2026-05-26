import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrganizerDto, UpdateOrganizerDto } from './dto/create-organizer.dto';
import { EmailService } from '../../common/services/email.service';
import { WhatsAppService } from '../../common/services/whatsapp.service';

/**
 * Remove URLs e domínios do texto da mensagem para evitar spam/phishing.
 * Aplicado somente no backend, antes de salvar e enviar.
 */
function sanitizeMessage(text: string): string {
  // 1. URLs com protocolo explícito (http, https, ftp, ws, wss)
  let s = text.replace(/(?:https?|ftp|wss?):\/\/[^\s\])"'>]+/gi, '');
  // 2. Domínios com www.
  s = s.replace(/\bwww\.[a-zA-Z0-9][a-zA-Z0-9\-.]{1,61}[a-zA-Z]{2,7}(?:\/[^\s]*)?\b/gi, '');
  // 3. Domínios simples com TLDs comuns (ex: site.com, meusite.com.br)
  const tlds = 'com|net|org|br|io|co|app|dev|site|online|me|info|biz|tv|gg|us|uk|pt|mobi|shop|store|digital|tech|club|live|news|link|vc|ai|zip|mov';
  s = s.replace(
    new RegExp(`\\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?\\.)+(?:${tlds})(?:\\/[^\\s]*)?\\b`, 'gi'),
    '',
  );
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

@Injectable()
export class OrganizersService {
  private readonly logger = new Logger(OrganizersService.name);

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

    this.emailService
      .sendWelcomeOrganizer({ email: result.member.user.email, firstName: result.member.user.firstName })
      .catch((err) => this.logger.warn('Failed to send welcome organizer email:', err));

    return {
      message: 'Organizer created successfully',
      data: {
        organization: result.organization,
        member: result.member,
      },
    };
  }

  async findMyOrganizations(userId: string) {
    const prismaRead = this.prisma.getReadClient();

    const memberships = await prismaRead.organizationMember.findMany({
      where: { userId },
      include: {
        organization: {
          include: {
            _count: {
              select: {
                members: true,
                events: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const organizations = memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      description: m.organization.description,
      logoUrl: m.organization.logoUrl,
      email: m.organization.email,
      phone: m.organization.phone,
      city: m.organization.city,
      state: m.organization.state,
      role: m.role,
      joinedAt: m.createdAt,
      membersCount: m.organization._count.members,
      eventsCount: m.organization._count.events,
    }));

    return {
      message: 'Organizations fetched successfully',
      data: { organizations },
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
    cpf?: string;
    subject?: string;
    message: string;
    eventId?: string;
    userId?: string;
  }) {
    // Sanitizar mensagem: remove links e domínios antes de qualquer persistência ou envio
    const cleanMessage = sanitizeMessage(contactData.message);
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
            contactEmail: true,
          },
        },
      },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const owner = organization.members[0];
    const event = contactData.eventId ? organization.events[0] : undefined;

    /* Busca avatar, país e tipo do documento do usuário logado. Os 3 campos
     * sao passados pro email service que usa locale.util pra decidir
     * formatacao e label do documento. */
    let userAvatarUrl: string | undefined;
    let userCountry: string | null = null;
    let userDocumentType: 'CPF' | 'PASSPORT' | null = null;
    if (contactData.userId) {
      const userRecord = await prismaRead.user.findUnique({
        where: { id: contactData.userId },
        select: { avatarUrl: true, country: true, documentType: true },
      });
      userAvatarUrl = userRecord?.avatarUrl ?? undefined;
      userCountry = userRecord?.country ?? null;
      userDocumentType = (userRecord?.documentType ?? null) as
        | 'CPF'
        | 'PASSPORT'
        | null;
    }

    // Criar mensagem no banco (já com mensagem sanitizada)
    const contactMessage = await prismaWrite.contactMessage.create({
      data: {
        organizationId: organization.id,
        userId: contactData.userId || null,
        eventId: contactData.eventId || null,
        name: contactData.name,
        email: contactData.email,
        phone: contactData.phone || null,
        message: cleanMessage,
      },
    });

    // Enviar email (mensagem já sanitizada) — fire-and-forget para não bloquear a resposta HTTP
    /* contactEmail adicionado ao schema após última geração do cliente Prisma — cast necessário */
    const recipientEmail = (event as any)?.contactEmail || organization.email;
    this.emailService
      .sendContactMessageToOrganizer({
        organizerEmail: recipientEmail,
        organizerName: organization.name,
        userName: contactData.name,
        userEmail: contactData.email,
        userPhone: contactData.phone,
        userCpf: contactData.cpf,
        userAvatarUrl,
        userCountry,
        userDocumentType,
        subject: contactData.subject,
        eventName: event?.name,
        message: cleanMessage,
      })
      .catch((error) => this.logger.warn('Falha ao enviar email de contato ao organizador:', error));

    // Enviar confirmação ao remetente — fire-and-forget
    this.emailService
      .sendContactMessageConfirmation({
        recipientEmail: contactData.email,
        userName: contactData.name,
        userEmail: contactData.email,
        userCpf: contactData.cpf,
        userPhone: contactData.phone,
        userAvatarUrl,
        userCountry,
        userDocumentType,
        subject: contactData.subject,
        message: cleanMessage,
        eventName: event?.name,
        organizerName: organization.name,
        organizerAvatarUrl: organization.logoUrl ?? undefined,
      })
      .catch((error) => this.logger.warn('Falha ao enviar confirmação de mensagem ao remetente:', error));

    // Enviar WhatsApp se disponível (mensagem já sanitizada) — fire-and-forget
    if (owner?.user.phone) {
      this.whatsappService
        .sendContactMessageToOrganizer({
          organizerPhone: owner.user.phone,
          organizerName: organization.name,
          userName: contactData.name,
          userEmail: contactData.email,
          userPhone: contactData.phone,
          eventName: event?.name,
          message: cleanMessage,
        })
        .catch((error) => this.logger.warn('Falha ao enviar WhatsApp ao organizador:', error));
    }

    return {
      message: 'Message sent successfully',
      data: { contactMessage },
    };
  }
}
