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
    const { eventId, modalities, kitItems = [], questionAnswers = [], termsAccepted, rulesAccepted, invitedUser, invitedUserId, couponCode, voucherCode } = createRegistrationDto;

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

    // Determinar o usuário da inscrição (próprio ou convidado) - precisa ser feito antes das validações de cupom/voucher
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

    // Validar e aplicar cupom ou voucher
    let discount = 0;
    let appliedCouponId: string | null = null;
    let appliedVoucherId: string | null = null;

    if (couponCode && voucherCode) {
      throw new BadRequestException('Cannot use both coupon and voucher at the same time');
    }

    if (couponCode) {
      const couponResult = await this.validateAndApplyCoupon(
        prismaRead,
        eventId,
        couponCode,
        modalities.map((m) => m.modalityId),
        totalAmount,
        registrationUserId,
      );
      discount = couponResult.discount;
      appliedCouponId = couponResult.couponId;
    } else if (voucherCode) {
      const voucherResult = await this.validateAndApplyVoucher(
        prismaRead,
        eventId,
        voucherCode,
        modalities.map((m) => m.modalityId),
        totalAmount,
        registrationUserId,
      );
      discount = voucherResult.discount;
      appliedVoucherId = voucherResult.voucherId;
    }

    // Calcular taxa de serviço (exemplo: 5%) sobre o valor após desconto
    const amountAfterDiscount = Math.max(0, totalAmount - discount);
    const serviceFee = amountAfterDiscount * 0.05;
    const finalAmount = amountAfterDiscount + serviceFee;

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
      // Aplicar cupom ou voucher (marcar como usado)
      if (appliedCouponId) {
        await prisma.coupon.update({
          where: { id: appliedCouponId },
          data: {
            usageCount: { increment: 1 },
          },
        });
      } else if (appliedVoucherId) {
        await prisma.voucher.update({
          where: { id: appliedVoucherId },
          data: {
            status: 'USED',
            usedAt: new Date(),
            usedBy: registrationUserId,
          },
        });
      }

      // Criar a inscrição
      const newRegistration = await prisma.registration.create({
        data: {
          eventId,
          userId: registrationUserId,
          invitedById: (invitedUser || invitedUserId) ? userId : null,
          status: RegistrationStatus.PENDING,
          termsAccepted,
          rulesAccepted,
          totalAmount,
          serviceFee,
          discount,
          finalAmount,
          ...(appliedCouponId && { couponId: appliedCouponId }),
          ...(appliedVoucherId && { voucherId: appliedVoucherId }),
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

  /**
   * Valida e aplica um cupom de desconto
   */
  private async validateAndApplyCoupon(
    prisma: any,
    eventId: string,
    couponCode: string,
    modalityIds: string[],
    totalAmount: number,
    userId: string,
  ): Promise<{ discount: number; couponId: string }> {
    const coupon = await prisma.coupon.findUnique({
      where: {
        eventId_code: {
          eventId,
          code: couponCode.toUpperCase(),
        },
      },
    });

    if (!coupon) {
      throw new NotFoundException('Coupon not found');
    }

    if (coupon.status !== 'ACTIVE') {
      throw new BadRequestException('Coupon is not active');
    }

    // Verificar expiração
    if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
      throw new BadRequestException('Coupon has expired');
    }

    // Verificar CPF list se habilitado
    if (coupon.cpfListStatus === 'ENABLED') {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { documentNumber: true },
      });

      if (!user || !user.documentNumber) {
        throw new BadRequestException('User document number is required for this coupon');
      }

      const cpfList = coupon.cpfList as string[] | null;
      if (!cpfList || !cpfList.includes(user.documentNumber)) {
        throw new BadRequestException('Coupon is not valid for this user');
      }
    }

    // Verificar valor mínimo do carrinho
    if (coupon.minCartValue && totalAmount < coupon.minCartValue) {
      throw new BadRequestException(`Minimum cart value of ${coupon.minCartValue} is required for this coupon`);
    }

    // Verificar se aplica às modalidades selecionadas
    if (coupon.appliesTo) {
      let appliesToValue: string | string[] | null = null;
      try {
        const parsed = JSON.parse(coupon.appliesTo);
        appliesToValue = Array.isArray(parsed) ? parsed : coupon.appliesTo;
      } catch {
        appliesToValue = coupon.appliesTo;
      }

      if (appliesToValue !== 'all') {
        const appliesToArray = Array.isArray(appliesToValue) ? appliesToValue : [appliesToValue];
        // Verificar se pelo menos uma modalidade está na lista
        const hasMatchingModality = modalityIds.some((id) => appliesToArray.includes(id));
        if (!hasMatchingModality) {
          throw new BadRequestException('Coupon does not apply to selected modalities');
        }
      }
    }

    // Calcular desconto
    let discount = 0;
    if (coupon.couponType === 'DISCOUNT') {
      if (coupon.type === 'PERCENTAGE') {
        discount = (totalAmount * coupon.value) / 100;
      } else if (coupon.type === 'FIXED') {
        discount = Math.min(coupon.value, totalAmount); // Não pode ser maior que o total
      }
    } else if (coupon.couponType === 'QUANTITY') {
      // Para cupons de quantidade, verificar se a quantidade mínima foi atingida
      if (coupon.minQuantity && modalityIds.length >= coupon.minQuantity) {
        if (coupon.type === 'PERCENTAGE') {
          discount = (totalAmount * coupon.value) / 100;
        } else if (coupon.type === 'FIXED') {
          discount = Math.min(coupon.value, totalAmount);
        }
      } else {
        throw new BadRequestException(`Minimum quantity of ${coupon.minQuantity} modalities is required for this coupon`);
      }
    } else if (coupon.couponType === 'AGE') {
      // Para cupons de idade, a validação de idade deve ser feita no frontend
      // Aqui apenas aplicamos o desconto se o cupom for válido
      if (coupon.type === 'PERCENTAGE') {
        discount = (totalAmount * coupon.value) / 100;
      } else if (coupon.type === 'FIXED') {
        discount = Math.min(coupon.value, totalAmount);
      }
    }

    return { discount, couponId: coupon.id };
  }

  /**
   * Valida e aplica um voucher
   */
  private async validateAndApplyVoucher(
    prisma: any,
    eventId: string,
    voucherCode: string,
    modalityIds: string[],
    totalAmount: number,
    userId: string,
  ): Promise<{ discount: number; voucherId: string }> {
    const voucher = await prisma.voucher.findUnique({
      where: { code: voucherCode },
    });

    if (!voucher) {
      throw new NotFoundException('Voucher not found');
    }

    if (voucher.eventId !== eventId) {
      throw new BadRequestException('Voucher is not valid for this event');
    }

    if (voucher.status !== 'ACTIVE') {
      throw new BadRequestException('Voucher is not active');
    }

    // Verificar se já foi usado
    if (voucher.status === 'USED') {
      throw new BadRequestException('Voucher has already been used');
    }

    // Verificar expiração
    if (voucher.expiryDate && new Date(voucher.expiryDate) < new Date()) {
      throw new BadRequestException('Voucher has expired');
    }

    // Verificar CPF list se habilitado
    if (voucher.cpfListStatus === 'ENABLED') {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { documentNumber: true },
      });

      if (!user || !user.documentNumber) {
        throw new BadRequestException('User document number is required for this voucher');
      }

      const cpfList = voucher.cpfList as string[] | null;
      if (!cpfList || !cpfList.includes(user.documentNumber)) {
        throw new BadRequestException('Voucher is not valid for this user');
      }
    }

    // Verificar se aplica às modalidades selecionadas
    if (voucher.appliesTo) {
      let appliesToValue: string | string[] | null = null;
      try {
        const parsed = JSON.parse(voucher.appliesTo);
        appliesToValue = Array.isArray(parsed) ? parsed : voucher.appliesTo;
      } catch {
        appliesToValue = voucher.appliesTo;
      }

      if (appliesToValue !== 'all') {
        const appliesToArray = Array.isArray(appliesToValue) ? appliesToValue : [appliesToValue];
        // Verificar se pelo menos uma modalidade está na lista
        const hasMatchingModality = modalityIds.some((id) => appliesToArray.includes(id));
        if (!hasMatchingModality) {
          throw new BadRequestException('Voucher does not apply to selected modalities');
        }
      }
    }

    // Vouchers geralmente dão desconto de 100% (ingresso grátis)
    // Como não há campo de valor no voucher, assumimos que é 100% de desconto
    // Você pode ajustar isso conforme sua lógica de negócio
    const discount = totalAmount; // 100% de desconto (ingresso grátis)

    return { discount, voucherId: voucher.id };
  }
}

