import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRegistrationDto, CreateRegistrationWithInvitedUserDto } from './dto/create-registration.dto';
import { FilterRegistrationsDto, RegistrationFilterStatus } from './dto/filter-registrations.dto';
import { Prisma, RegistrationStatus, PaymentStatus } from '@prisma/client';
// QR Code é gerado dinamicamente no frontend/backend usando o payload salvo em qrCode
import { KitsService } from '../kits/kits.service';

@Injectable()
export class RegistrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kitsService: KitsService,
  ) { }

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

      // Criar o pedido (Order) primeiro
      const order = await prisma.order.create({
        data: {
          userId,
          eventId,
          totalAmount,
          serviceFee,
          discount,
          finalAmount,
          ...(appliedCouponId && { couponId: appliedCouponId }),
          ...(appliedVoucherId && { voucherId: appliedVoucherId }),
        },
      });

      // Criar a inscrição vinculada ao pedido
      const newRegistration = await prisma.registration.create({
        data: {
          eventId,
          orderId: order.id,
          userId: registrationUserId,
          invitedById: (invitedUser || invitedUserId) ? userId : null,
          status: RegistrationStatus.PENDING,
          termsAccepted,
          rulesAccepted,
        },
      });

      // Criar QR Code payload (apenas dados, não Data URL)
      // O QR Code será gerado dinamicamente no frontend/backend usando este payload
      const qrCodePayload = JSON.stringify({
        registrationId: newRegistration.id,
        eventId,
        userId: registrationUserId,
      });

      await prisma.registration.update({
        where: { id: newRegistration.id },
        data: { qrCode: qrCodePayload },
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

    // Formatar registration para substituir qrCode pelo link
    const formattedRegistration = {
      ...registration,
      qrCode: `https://www.podioticket.com.br/user/tickets/${registration.id}`,
    };

    return {
      message: 'Registration created successfully',
      data: { registration: formattedRegistration },
    };
  }

  /**
   * Filtro equivalente ao comportamento anterior de findUserRegistrations (in-memory),
   * empurrado para o Prisma para permitir paginação no banco.
   */
  private buildFindUserRegistrationsWhere(
    userId: string,
    status?: RegistrationFilterStatus,
  ): Prisma.RegistrationWhereInput {
    const participant: Prisma.RegistrationWhereInput = {
      OR: [{ userId }, { invitedById: userId }],
    };
    if (!status) {
      return participant;
    }

    const now = new Date();

    switch (status) {
      case RegistrationFilterStatus.CONFIRMED:
        return {
          AND: [
            participant,
            {
              status: {
                in: [RegistrationStatus.CONFIRMED, RegistrationStatus.COMPLETED],
              },
            },
            {
              order: {
                payment: { status: PaymentStatus.PAID },
              },
            },
          ],
        };
      case RegistrationFilterStatus.PENDING:
        return {
          AND: [
            participant,
            {
              OR: [
                { status: RegistrationStatus.PENDING },
                {
                  order: {
                    payment: {
                      status: {
                        in: [PaymentStatus.PENDING, PaymentStatus.FAILED],
                      },
                    },
                  },
                },
                { order: { is: { payment: null } } },
              ],
            },
          ],
        };
      case RegistrationFilterStatus.COMPLETED:
        return {
          AND: [
            participant,
            {
              event: {
                eventDate: { lt: now },
              },
            },
          ],
        };
      case RegistrationFilterStatus.CANCELLED:
        return {
          AND: [
            participant,
            {
              OR: [
                { status: RegistrationStatus.CANCELLED },
                {
                  order: {
                    payment: { status: PaymentStatus.REFUNDED },
                  },
                },
                {
                  order: {
                    payment: {
                      metadata: {
                        path: ['refundType'],
                        equals: 'CHARGEBACK',
                      },
                    },
                  },
                },
                {
                  order: {
                    payment: {
                      metadata: {
                        path: ['refundType'],
                        equals: 'REFUND',
                      },
                    },
                  },
                },
              ],
            },
          ],
        };
      default:
        return participant;
    }
  }

  private readonly findUserRegistrationsInclude = {
    event: {
      include: {
        organization: {
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
    products: {
      include: {
        product: {
          include: {
            variations: true,
          },
        },
        variation: true,
      },
    },
    order: {
      include: {
        payment: true,
      },
    },
    tickets: {
      include: {
        ticket: {
          select: {
            id: true,
            name: true,
            modality: true,
          },
        },
      },
    },
  } as const;

  async findUserRegistrations(userId: string, filterDto: FilterRegistrationsDto = {}) {
    const prismaRead = this.prisma.getReadClient();
    const { page = 1, limit = 20, status } = filterDto;
    const skip = (page - 1) * limit;

    const where = this.buildFindUserRegistrationsWhere(userId, status);

    const [filteredRegistrations, total] = await Promise.all([
      prismaRead.registration.findMany({
        where,
        include: this.findUserRegistrationsInclude,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prismaRead.registration.count({ where }),
    ]);

    // Formatar registrations para substituir qrCode pelo link, ingressos (modalidade) e produtos
    const formattedRegistrations = filteredRegistrations.map((reg: any) => {
      const { tickets: regTickets, ...regRest } = reg;
      return {
        ...regRest,
        qrCode: `https://www.podioticket.com.br/user/tickets/${reg.id}`,
        tickets: (regTickets || []).map((rt: any) => ({
          id: rt.ticket?.id,
          name: rt.ticket?.name,
          modality: rt.ticket?.modality,
        })),
        products: (reg.products || []).map((rp: any) => ({
          id: rp.id,
          product: {
            id: rp.product.id,
            name: rp.product.name,
            image: rp.product.image,
            basePrice: rp.product.basePrice,
            variationType: rp.product.variationType || null,
          },
          variation: rp.variation ? {
            id: rp.variation.id,
            name: rp.variation.name,
            price: rp.variation.price,
          } : null,
          variationName: rp.variation?.name || null,
          quantity: rp.quantity,
          unitPrice: rp.unitPrice,
          totalPrice: rp.totalPrice,
        })),
      };
    });

    const totalPages = Math.ceil(total / limit);

    return {
      message: 'Registrations fetched successfully',
      data: {
        registrations: formattedRegistrations,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      },
    };
  }

  async findOne(id: string, userId: string) {
    const prismaRead = this.prisma.getReadClient();

    const registration = await prismaRead.registration.findUnique({
      where: { id },
      include: {
        event: {
          include: {
            organization: {
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
            email: true,
            documentNumber: true,
            avatarUrl: true,
            dateOfBirth: true,
            gender: true,
            phone: true,
            reservePhone: true,
          },
        },
        modalities: {
          include: {
            modality: true,
          },
        },
        tickets: {
          include: {
            ticket: {
              include: {
                category: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
                products: {
                  orderBy: { sortOrder: 'asc' },
                  include: {
                    product: {
                      include: {
                        variations: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        questionAnswers: {
          include: {
            question: {
              select: {
                id: true,
                question: true,
              },
            },
          },
        },
        kitItems: {
          include: {
            kitItem: {
              include: {
                product: {
                  select: {
                    id: true,
                    name: true,
                    image: true,
                    basePrice: true,
                  },
                },
              },
            },
          },
        },
        products: {
          include: {
            product: {
              include: {
                variations: true,
              },
            },
            variation: true,
          },
        },
        order: {
          include: {
            payment: true,
          },
        },
      },
    });

    if (!registration) {
      throw new NotFoundException('Registration not found');
    }
    // Formatar a resposta conforme especificação
    // Usar type assertion para contornar problemas de tipagem do Prisma
    const reg = registration as any;

    const pendingProductsMap = new Map<string, { variationId?: string; quantity: number }>();
    for (const pp of (reg.order?.pendingProducts as any[] | null) ?? []) {
      pendingProductsMap.set(pp.productId, { variationId: pp.variationId, quantity: pp.quantity });
    }

    const formattedRegistration = {
      id: reg.id,
      qrCode: `https://www.podioticket.com.br/user/tickets/${reg.id}`,
      user: {
        id: reg.user.id,
        firstName: reg.user.firstName,
        lastName: reg.user.lastName,
        email: reg.user.email,
        documentNumber: reg.user.documentNumber,
        avatarUrl: reg.user.avatarUrl,
        dateOfBirth: reg.user.dateOfBirth?.toISOString() || null,
        gender: reg.user.gender,
        phone: reg.user.phone,
        reservePhone: reg.user.reservePhone,
        fullName: `${reg.user.firstName} ${reg.user.lastName}`,
      },
      modalities: (reg.modalities || []).map((rm: any) => ({
        id: rm.id,
        modality: {
          id: rm.modality.id,
          name: rm.modality.name,
          distance: null, // Modality não tem campo distance no schema
          category: null, // Modality não tem category no schema
        },
      })),
      ticket: reg.tickets && reg.tickets.length > 0 ? {
        id: reg.tickets[0].ticket.id,
        name: reg.tickets[0].ticket.name,
        distance: reg.tickets[0].ticket.distance ?
          (reg.tickets[0].ticket.distanceUnit ?
            `${reg.tickets[0].ticket.distance} ${reg.tickets[0].ticket.distanceUnit}` :
            reg.tickets[0].ticket.distance) :
          null,
        category: reg.tickets[0].ticket.category ? {
          id: reg.tickets[0].ticket.category.id,
          name: reg.tickets[0].ticket.category.name,
        } : null,
        includedProducts: (reg.tickets[0].ticket.products || []).map((tp: any) => {
          const sel = pendingProductsMap.get(tp.product.id);
          const selectedVariation = sel?.variationId
            ? (tp.product.variations || []).find((v: any) => v.id === sel.variationId) ?? null
            : null;
          return {
            id: tp.product.id,
            name: tp.product.name,
            image: tp.product.image,
            basePrice: tp.product.basePrice ? Math.round(tp.product.basePrice * 100) : 0,
            variationType: tp.product.variationType || null,
            selectedVariation: selectedVariation
              ? { id: selectedVariation.id, name: selectedVariation.name, price: selectedVariation.price }
              : null,
            variations: (tp.product.variations || []).map((v: any) => ({
              id: v.id,
              name: v.name,
              price: Math.round(v.price * 100),
              stock: v.stock,
            })),
          };
        }),
      } : null,
      questionAnswers: (reg.questionAnswers || []).map((qa: any) => ({
        id: qa.id,
        question: {
          id: qa.question.id,
          question: qa.question.question,
        },
        answer: qa.answer as string,
      })),
      kitItems: (reg.kitItems || []).map((ki: any) => ({
        id: ki.id,
        kitItem: {
          id: ki.kitItem.id,
          name: ki.kitItem.name || ki.kitItem.product?.name || 'Item',
          price: ki.kitItem.product?.basePrice ? Math.round(ki.kitItem.product.basePrice * 100) : 0, // Converter para centavos (KitItem não tem price, usa product.basePrice)
          image: ki.kitItem.product?.image || null,
        },
        selectedSize: ki.selectedSize,
        quantity: ki.quantity,
      })),
      products: (reg.products || []).map((rp: any) => ({
        id: rp.id,
        product: {
          id: rp.product.id,
          name: rp.product.name,
          image: rp.product.image,
          basePrice: rp.product.basePrice,
          isIncludedInTicket: rp.product.isIncludedInTicket ?? false,
          isRequired: rp.product.isRequired ?? false,
          variationType: rp.product.variationType || null,
        },
        variation: rp.variation ? {
          id: rp.variation.id,
          name: rp.variation.name,
          price: rp.variation.price,
        } : null,
        variationName: rp.variation?.name || null,
        quantity: rp.quantity,
        unitPrice: rp.unitPrice,
        totalPrice: rp.totalPrice,
      })),
      emergencyContact: {
        name: reg.emergencyContactName ?? null,
        phone: reg.emergencyContactPhone ?? null,
      },
    };

    return {
      message: 'Registration fetched successfully',
      data: { registration: formattedRegistration },
    };
  }

  async findMyRegistration(id: string, userId: string) {
    const prismaRead = this.prisma.getReadClient();

    const registration = await prismaRead.registration.findUnique({
      where: { id },
      include: {
        event: {
          include: {
            organization: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                logoUrl: true,
              },
            },
            locations: true,
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
            email: true,
            documentNumber: true,
            avatarUrl: true,
            dateOfBirth: true,
            gender: true,
            phone: true,
            reservePhone: true,
          },
        },
        invitedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        tickets: {
          include: {
            ticket: {
              include: {
                category: { select: { id: true, name: true } },
                kit: { select: { id: true, name: true } },
              },
            },
          },
        },
        questionAnswers: {
          include: {
            question: {
              select: { id: true, question: true, type: true, isRequired: true },
            },
          },
        },
        products: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                image: true,
                basePrice: true,
                isIncludedInTicket: true,
                isRequired: true,
                variationType: true,
              },
            },
            variation: {
              select: { id: true, name: true, price: true },
            },
          },
        },
        order: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                documentNumber: true,
                avatarUrl: true,
              },
            },
            payment: {
              select: {
                id: true,
                status: true,
                method: true,
                amount: true,
                transactionId: true,
                paymentDate: true,
                createdAt: true,
              },
            },
            coupon: {
              select: { id: true, code: true, type: true, value: true },
            },
            voucher: {
              select: { id: true, code: true, name: true, status: true },
            },
          },
        },
      },
    });

    if (!registration) {
      throw new NotFoundException('Registration not found');
    }

    // Verificar se o usuário tem acesso (é o dono da inscrição ou foi convidado por ele)
    if (registration.userId !== userId && registration.invitedById !== userId) {
      throw new BadRequestException('Access denied - You can only view your own registrations');
    }

    const reg = registration as any;

    const formattedRegistration = {
      id: reg.id,
      status: reg.status,
      qrCode: `https://www.podioticket.com.br/user/tickets/${reg.id}`,
      createdAt: reg.createdAt,
      updatedAt: reg.updatedAt,
      participant: {
        id: reg.user.id,
        firstName: reg.user.firstName,
        lastName: reg.user.lastName,
        fullName: `${reg.user.firstName} ${reg.user.lastName}`,
        email: reg.user.email,
        documentNumber: reg.user.documentNumber,
        avatarUrl: reg.user.avatarUrl,
        dateOfBirth: reg.user.dateOfBirth?.toISOString() || null,
        gender: reg.user.gender,
        phone: reg.user.phone,
        reservePhone: reg.user.reservePhone,
      },
      invitedBy: reg.invitedBy ? {
        id: reg.invitedBy.id,
        fullName: `${reg.invitedBy.firstName} ${reg.invitedBy.lastName}`,
        email: reg.invitedBy.email,
      } : null,
      emergencyContact: reg.emergencyContactName || reg.emergencyContactPhone ? {
        name: reg.emergencyContactName ?? null,
        phone: reg.emergencyContactPhone ?? null,
      } : null,
      event: {
        id: reg.event.id,
        name: reg.event.name,
        slug: reg.event.slug,
        startDate: reg.event.startDate,
        endDate: reg.event.endDate,
        imageUrl: reg.event.imageUrl,
        bannerUrl: reg.event.bannerUrl,
        logoUrl: reg.event.logoUrl,
        status: reg.event.status,
        location: reg.event.location,
        locations: reg.event.locations ?? [],
        organization: reg.event.organization ?? null,
        regulationTopic: reg.event.topics?.[0] ?? null,
      },
      ticket: reg.tickets?.[0] ? {
        id: reg.tickets[0].ticket.id,
        name: reg.tickets[0].ticket.name,
        description: reg.tickets[0].ticket.description ?? null,
        modality: reg.tickets[0].ticket.modality ?? null,
        distance: reg.tickets[0].ticket.distance ?? null,
        distanceUnit: reg.tickets[0].ticket.distanceUnit ?? null,
        gender: reg.tickets[0].ticket.gender ?? null,
        ageLimitMin: reg.tickets[0].ticket.ageLimitMin ?? null,
        ageLimitMax: reg.tickets[0].ticket.ageLimitMax ?? null,
        hasKit: reg.tickets[0].ticket.hasKit,
        category: reg.tickets[0].ticket.category ? {
          id: reg.tickets[0].ticket.category.id,
          name: reg.tickets[0].ticket.category.name,
        } : null,
        kit: reg.tickets[0].ticket.kit ? {
          id: reg.tickets[0].ticket.kit.id,
          name: reg.tickets[0].ticket.kit.name,
        } : null,
      } : null,
      products: (reg.products || []).map((rp: any) => ({
        id: rp.id,
        product: {
          id: rp.product.id,
          name: rp.product.name,
          image: rp.product.image ?? null,
          basePrice: rp.product.basePrice,
          isIncludedInTicket: rp.product.isIncludedInTicket ?? false,
          isRequired: rp.product.isRequired ?? false,
          variationType: rp.product.variationType || null,
        },
        variation: rp.variation ? {
          id: rp.variation.id,
          name: rp.variation.name,
          price: rp.variation.price,
        } : null,
        quantity: rp.quantity,
        unitPrice: rp.unitPrice,
        totalPrice: rp.totalPrice,
      })),
      questionAnswers: (reg.questionAnswers || []).map((qa: any) => ({
        id: qa.id,
        question: {
          id: qa.question.id,
          question: qa.question.question,
          type: qa.question.type,
          isRequired: qa.question.isRequired,
        },
        answer: qa.answer as string,
      })),
      order: reg.order ? {
        id: reg.order.id,
        totalAmount: reg.order.totalAmount,
        serviceFee: reg.order.serviceFee,
        discount: reg.order.discount,
        finalAmount: reg.order.finalAmount,
        purchaseDate: reg.order.createdAt,
        coupon: reg.order.coupon ? {
          id: reg.order.coupon.id,
          code: reg.order.coupon.code,
          type: reg.order.coupon.type,
          value: reg.order.coupon.value,
        } : null,
        voucher: reg.order.voucher ? {
          id: reg.order.voucher.id,
          code: reg.order.voucher.code,
          name: reg.order.voucher.name,
          status: reg.order.voucher.status,
        } : null,
        buyer: reg.order.user ? {
          id: reg.order.user.id,
          fullName: `${reg.order.user.firstName} ${reg.order.user.lastName}`,
          email: reg.order.user.email,
          phone: reg.order.user.phone,
          documentNumber: reg.order.user.documentNumber,
          avatarUrl: reg.order.user.avatarUrl,
        } : null,
        payment: reg.order.payment ? {
          id: reg.order.payment.id,
          status: reg.order.payment.status,
          method: reg.order.payment.method,
          amount: reg.order.payment.amount,
          transactionId: reg.order.payment.transactionId ?? null,
          paymentDate: reg.order.payment.paymentDate ?? null,
          createdAt: reg.order.payment.createdAt,
        } : null,
      } : null,
    };

    return {
      message: 'Registration details fetched successfully',
      data: { registration: formattedRegistration },
    };
  }

  async cancel(id: string, userId: string) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const registration = await prismaRead.registration.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            payment: true,
          },
        },
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

    if (registration.order?.payment && registration.order.payment.status === 'PAID') {
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

