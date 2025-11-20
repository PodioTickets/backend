import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRegistrationDto, CreateRegistrationWithInvitedUserDto } from './dto/create-registration.dto';
import { RegistrationStatus } from '@prisma/client';
import * as QRCode from 'qrcode';
import { KitsService } from '../kits/kits.service';

@Injectable()
export class RegistrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kitsService: KitsService,
  ) {}

  async create(userId: string, createRegistrationDto: CreateRegistrationWithInvitedUserDto) {
    const { eventId, modalities, kitItems = [], questionAnswers = [], termsAccepted, rulesAccepted, invitedUser, invitedUserId } = createRegistrationDto;

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se o evento existe e está ativo
    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
      include: {
        questions: true,
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.status !== 'PUBLISHED') {
      throw new BadRequestException('Event is not available for registration');
    }

    if (new Date() > new Date(event.registrationEndDate)) {
      throw new BadRequestException('Registration period has ended');
    }

    if (new Date() > new Date(event.eventDate)) {
      throw new BadRequestException('Event has already occurred');
    }

    if (!termsAccepted || !rulesAccepted) {
      throw new BadRequestException('Terms and rules must be accepted');
    }

    // Verificar se todas as perguntas obrigatórias foram respondidas
    const requiredQuestions = event.questions.filter((q) => q.isRequired);
    const answeredQuestionIds = questionAnswers.map((qa) => qa.questionId);
    const missingQuestions = requiredQuestions.filter((q) => !answeredQuestionIds.includes(q.id));

    if (missingQuestions.length > 0) {
      throw new BadRequestException(`Missing required questions: ${missingQuestions.map((q) => q.question).join(', ')}`);
    }

    // Verificar modalidades e calcular preço
    let totalAmount = 0;
    for (const modalitySelection of modalities) {
      const modality = await prismaRead.modality.findUnique({
        where: { id: modalitySelection.modalityId },
      });

      if (!modality || modality.eventId !== eventId || !modality.isActive) {
        throw new NotFoundException(`Modality ${modalitySelection.modalityId} not found`);
      }

      if (modality.maxParticipants && modality.currentParticipants >= modality.maxParticipants) {
        throw new BadRequestException(`Modality ${modality.name} is full`);
      }

      totalAmount += modality.price;
    }

    // Verificar estoque dos itens do kit
    for (const kitItem of kitItems) {
      await this.kitsService.checkStock(kitItem.kitItemId, kitItem.size, kitItem.quantity);
    }

    // Calcular taxa de serviço (exemplo: 5%)
    const serviceFee = totalAmount * 0.05;
    const finalAmount = totalAmount + serviceFee;

    // Determinar o usuário da inscrição (próprio ou convidado)
    let registrationUserId = userId;

    if (invitedUser) {
      // Criar usuário convidado (pre-cadastro)
      const invitedUserData = await prismaWrite.user.create({
        data: {
          email: invitedUser.email,
          firstName: invitedUser.firstName,
          lastName: invitedUser.lastName,
          documentNumber: invitedUser.documentNumber,
          password: '', // Senha será definida depois
          isActive: false, // Ativo apenas após definir senha
        },
      });
      registrationUserId = invitedUserData.id;
    } else if (invitedUserId) {
      registrationUserId = invitedUserId;
    }

    // Criar inscrição
    const registration = await prismaWrite.$transaction(async (prisma) => {
      // Criar a inscrição
      const newRegistration = await prisma.registration.create({
        data: {
          eventId,
          userId: registrationUserId,
          invitedById: invitedUser || invitedUserId ? userId : null,
          status: RegistrationStatus.PENDING,
          termsAccepted,
          rulesAccepted,
          totalAmount,
          serviceFee,
          discount: 0,
          finalAmount,
        },
      });

      // Criar QR Code
      const qrCodeData = JSON.stringify({
        registrationId: newRegistration.id,
        eventId,
        userId: registrationUserId,
      });
      const qrCode = await QRCode.toDataURL(qrCodeData);

      await prisma.registration.update({
        where: { id: newRegistration.id },
        data: { qrCode },
      });

      // Adicionar modalidades
      for (const modalitySelection of modalities) {
        await prisma.registrationModality.create({
          data: {
            registrationId: newRegistration.id,
            modalityId: modalitySelection.modalityId,
          },
        });

        // Atualizar contador de participantes
        await prisma.modality.update({
          where: { id: modalitySelection.modalityId },
          data: {
            currentParticipants: {
              increment: 1,
            },
          },
        });
      }

      // Adicionar itens do kit e atualizar estoque
      for (const kitItem of kitItems) {
        await prisma.registrationKitItem.create({
          data: {
            registrationId: newRegistration.id,
            kitItemId: kitItem.kitItemId,
            selectedSize: kitItem.size,
            quantity: kitItem.quantity,
          },
        });

        await this.kitsService.updateStock(kitItem.kitItemId, kitItem.size, kitItem.quantity);
      }

      // Adicionar respostas das perguntas
      for (const answer of questionAnswers) {
        await prisma.questionAnswer.create({
          data: {
            registrationId: newRegistration.id,
            questionId: answer.questionId,
            answer: answer.answer,
          },
        });
      }

      return prisma.registration.findUnique({
        where: { id: newRegistration.id },
        include: {
          modalities: {
            include: {
              modality: true,
            },
          },
          kitItems: {
            include: {
              kitItem: true,
            },
          },
          questionAnswers: {
            include: {
              question: true,
            },
          },
        },
      });
    });

    return {
      message: 'Registration created successfully',
      data: { registration },
    };
  }

  async findUserRegistrations(userId: string) {
    const prismaRead = this.prisma.getReadClient();
    
    const registrations = await prismaRead.registration.findMany({
      where: {
        OR: [
          { userId },
          { invitedById: userId },
        ],
      },
      include: {
        event: {
          include: {
            organizer: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            documentNumber: true,
            dateOfBirth: true,
          },
        },
        modalities: {
          include: {
            modality: true,
          },
        },
        kitItems: {
          include: {
            kitItem: true,
          },
        },
        payment: true,
      },
      orderBy: {
        purchaseDate: 'desc',
      },
    });

    return {
      message: 'Registrations fetched successfully',
      data: { registrations },
    };
  }

  async findOne(id: string, userId: string) {
    const prismaRead = this.prisma.getReadClient();
    
    const registration = await prismaRead.registration.findUnique({
      where: { id },
      include: {
        event: {
          include: {
            organizer: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
              },
            },
            topics: {
              where: {
                title: 'REGULAMENTO',
                isEnabled: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            documentNumber: true,
            dateOfBirth: true,
          },
        },
        modalities: {
          include: {
            modality: true,
          },
        },
        kitItems: {
          include: {
            kitItem: true,
          },
        },
        payment: true,
      },
    });

    if (!registration) {
      throw new NotFoundException('Registration not found');
    }

    // Verificar se o usuário tem acesso a esta inscrição
    if (registration.userId !== userId && registration.invitedById !== userId) {
      throw new BadRequestException('Access denied');
    }

    return {
      message: 'Registration fetched successfully',
      data: { registration },
    };
  }

  async cancel(id: string, userId: string) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const registration = await prismaRead.registration.findUnique({
      where: { id },
      include: {
        payment: true,
        modalities: {
          include: {
            modality: true,
          },
        },
      },
    });

    if (!registration) {
      throw new NotFoundException('Registration not found');
    }

    if (registration.userId !== userId && registration.invitedById !== userId) {
      throw new BadRequestException('Access denied');
    }

    if (registration.status === RegistrationStatus.CANCELLED) {
      throw new BadRequestException('Registration already cancelled');
    }

    if (registration.payment && registration.payment.status === 'PAID') {
      throw new BadRequestException('Cannot cancel paid registration');
    }

    await prismaWrite.$transaction(async (prisma) => {
      // Atualizar status
      await prisma.registration.update({
        where: { id },
        data: { status: RegistrationStatus.CANCELLED },
      });

      // Reduzir contador de participantes
      for (const regModality of registration.modalities) {
        await prisma.modality.update({
          where: { id: regModality.modalityId },
          data: {
            currentParticipants: {
              decrement: 1,
            },
          },
        });
      }
    });

    return {
      message: 'Registration cancelled successfully',
    };
  }
}

