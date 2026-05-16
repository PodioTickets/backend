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

  private async isAdminUser(userId: string): Promise<boolean> {
    const user = await this.prisma.getReadClient().user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user?.role === 'PODIOGO_STAFF' || user?.role === 'ADMIN';
  }

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

    // Validar respostas contra as opções válidas da pergunta
    const questionMap = new Map(event.questions.map((q) => [q.id, q]));
    for (const qa of questionAnswers) {
      const question = questionMap.get(qa.questionId);
      if (!question) continue;

      if (['select', 'radio', 'checkbox'].includes(question.type)) {
        const validOptions = (question.options as string[] | null) ?? [];

        let selectedValues: string[];
        try {
          const parsed = JSON.parse(qa.answer);
          selectedValues = Array.isArray(parsed) ? parsed : [String(parsed)];
        } catch {
          selectedValues = [qa.answer];
        }

        const invalid = selectedValues.filter((v) => !validOptions.includes(v));
        if (invalid.length > 0) {
          throw new BadRequestException(
            `Resposta inválida para "${question.question}": ${invalid.join(', ')}. Opções válidas: ${validOptions.join(', ')}`,
          );
        }
      }
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

    // Determinar o usuário da inscrição (próprio ou convidado)
    let registrationUserId: string | null = userId;
    let guestSnapshot: { name: string; email: string; cpf: string; cpfClean: string } | null = null;

    if (invitedUser) {
      const existingUser = await prismaRead.user.findFirst({
        where: { email: invitedUser.email },
        select: { id: true },
      });
      if (existingUser) {
        registrationUserId = existingUser.id;
      } else {
        registrationUserId = null;
        guestSnapshot = {
          name: `${invitedUser.firstName} ${invitedUser.lastName}`,
          email: invitedUser.email,
          cpf: invitedUser.documentNumber,
          cpfClean: invitedUser.documentNumber.replace(/\D/g, ''),
        };
      }
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

    // Aplica fórmula: ((modalidade - cupom/voucher) + 0) + % taxa de serviço.
    // Desconto abate apenas o valor base; taxa incide sobre o valor já com desconto.
    const feePercent = (event as any).participantFeePercent ?? 0;
    const effectiveDiscount = Math.min(discount, totalAmount);
    const baseAfterDiscount = totalAmount - effectiveDiscount;
    const serviceFee = Math.round(baseAfterDiscount * (feePercent / 100));
    const finalAmount = baseAfterDiscount + serviceFee;

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
        // Atomic ACTIVE → USED para evitar dupla utilização do voucher
        const r = await prisma.voucher.updateMany({
          where: { id: appliedVoucherId, status: 'ACTIVE' },
          data: {
            status: 'USED',
            usedAt: new Date(),
            usedBy: registrationUserId,
          },
        });
        if (r.count === 0) {
          throw new Error(`Voucher ${appliedVoucherId} já foi utilizado`);
        }
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
          invitedById: (guestSnapshot || invitedUserId) ? userId : null,
          status: RegistrationStatus.PENDING,
          termsAccepted,
          rulesAccepted,
          ...(guestSnapshot && {
            participantName: guestSnapshot.name,
            participantEmail: guestSnapshot.email,
            participantCpf: guestSnapshot.cpf,
            participantCpfClean: guestSnapshot.cpfClean,
          }),
        },
      });

      const qrCodePayload = JSON.stringify({
        registrationId: newRegistration.id,
        eventId,
        userId: registrationUserId ?? userId,
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

      // Adicionar respostas das perguntas com snapshot da pergunta no momento da resposta
      for (const answer of questionAnswers) {
        const questionData = questionMap.get(answer.questionId);
        const questionSnapshot = questionData ? {
          id: questionData.id,
          question: (questionData as any).question,
          description: (questionData as any).description ?? null,
          type: (questionData as any).type,
          options: (questionData as any).options ?? null,
          isRequired: (questionData as any).isRequired,
        } : null;
        await prisma.questionAnswer.create({
          data: {
            registrationId: newRegistration.id,
            questionId: answer.questionId,
            answer: answer.answer,
            questionSnapshot,
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

  private deriveOrderStatus(orderStatus: string, paymentStatus: string | null): string {
    if (orderStatus === 'CANCELLED') return 'CANCELLED';
    switch (paymentStatus) {
      case 'PAID': return 'CONFIRMED';
      case 'REFUNDED': return 'CANCELLED';
      case 'FAILED': return 'PENDING';
      default: return 'PENDING';
    }
  }

  private async resolveParticipant(reg: any, prismaRead: any): Promise<{
    id: string | null;
    firstName: string;
    lastName: string;
    fullName: string;
    email: string | null;
    documentNumber: string | null;
    avatarUrl: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    phone: string | null;
    reservePhone: string | null;
  }> {
    if (reg.user) {
      const u = reg.user;
      return {
        id: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        fullName: `${u.firstName} ${u.lastName}`,
        email: u.email,
        documentNumber: u.documentNumber ?? null,
        avatarUrl: u.avatarUrl ?? null,
        dateOfBirth: u.dateOfBirth?.toISOString() ?? null,
        gender: u.gender ?? null,
        phone: u.phone ?? null,
        reservePhone: u.reservePhone ?? null,
      };
    }

    if (reg.participantCpfClean) {
      const realUser = await prismaRead.user.findFirst({
        where: { documentNumberClean: reg.participantCpfClean, accountType: 'USER' },
        select: {
          id: true, firstName: true, lastName: true, email: true,
          documentNumber: true, avatarUrl: true, dateOfBirth: true,
          gender: true, phone: true, reservePhone: true,
        },
      });
      if (realUser) {
        return {
          id: realUser.id,
          firstName: realUser.firstName,
          lastName: realUser.lastName,
          fullName: `${realUser.firstName} ${realUser.lastName}`,
          email: realUser.email,
          documentNumber: realUser.documentNumber ?? null,
          avatarUrl: realUser.avatarUrl ?? null,
          dateOfBirth: realUser.dateOfBirth?.toISOString() ?? null,
          gender: realUser.gender ?? null,
          phone: realUser.phone ?? null,
          reservePhone: realUser.reservePhone ?? null,
        };
      }
    }

    const nameParts = (reg.participantName ?? '').split(' ');
    return {
      id: null,
      firstName: nameParts[0] ?? '',
      lastName: nameParts.slice(1).join(' ') ?? '',
      fullName: reg.participantName ?? '',
      email: reg.participantEmail ?? null,
      documentNumber: reg.participantCpf ?? null,
      avatarUrl: null,
      dateOfBirth: reg.participantDateOfBirth?.toISOString() ?? null,
      gender: reg.participantGender ?? null,
      phone: reg.participantPhone ?? null,
      reservePhone: null,
    };
  }

  private buildUserOrdersWhere(
    userId: string,
    status?: RegistrationFilterStatus,
    userCpfClean?: string | null,
  ): Prisma.OrderWhereInput {
    const orClauses: Prisma.OrderWhereInput[] = [{ userId }];
    if (userCpfClean) {
      orClauses.push({ registrations: { some: { user: { documentNumberClean: userCpfClean } } } });
      orClauses.push({ registrations: { some: { participantCpfClean: userCpfClean } } });
    }
    const participant: Prisma.OrderWhereInput = { OR: orClauses };
    if (!status) {
      return participant;
    }

    const now = new Date();

    switch (status) {
      case RegistrationFilterStatus.CONFIRMED:
        return {
          AND: [
            participant,
            { payment: { status: PaymentStatus.PAID } },
            { status: { not: 'CANCELLED' } },
          ],
        };
      case RegistrationFilterStatus.PENDING:
        return {
          AND: [
            participant,
            {
              OR: [
                { status: 'PENDING' },
                { payment: { status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] } } },
                { payment: { is: null } },
              ],
            },
          ],
        };
      case RegistrationFilterStatus.COMPLETED:
        return {
          AND: [
            participant,
            { event: { eventDate: { lt: now } } },
          ],
        };
      case RegistrationFilterStatus.CANCELLED:
        return {
          AND: [
            participant,
            {
              OR: [
                { status: 'CANCELLED' },
                { payment: { status: PaymentStatus.REFUNDED } },
                { payment: { metadata: { path: ['refundType'], equals: 'CHARGEBACK' } } },
                { payment: { metadata: { path: ['refundType'], equals: 'REFUND' } } },
              ],
            },
          ],
        };
      default:
        return participant;
    }
  }

  async findUserRegistrations(userId: string, filterDto: FilterRegistrationsDto = {}) {
    const prismaRead = this.prisma.getReadClient();
    const { page = 1, limit = 20, status } = filterDto;
    const skip = (page - 1) * limit;

    const currentUser = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { documentNumberClean: true },
    });
    const userCpfClean = currentUser?.documentNumberClean ?? null;

    const where = this.buildUserOrdersWhere(userId, status, userCpfClean);

    const [orders, total] = await Promise.all([
      prismaRead.order.findMany({
        where,
        select: {
          id: true,
          status: true,
          createdAt: true,
          payment: { select: { status: true } },
          event: {
            select: {
              id: true,
              name: true,
              slug: true,
              eventDate: true,
              logoUrl: true,
              location: true,
              city: true,
              state: true,
            },
          },
          registrations: {
            select: {
              userId: true,
              invitedById: true,
              invitedBy: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                },
              },
              tickets: {
                select: {
                  ticket: {
                    select: {
                      modality: true,
                      distance: true,
                      distanceUnit: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prismaRead.order.count({ where }),
    ]);

    const formattedOrders = orders.map((order: any) => {
      const modalitySet = new Set<string>();
      let invitedBy: { id: string; fullName: string } | null = null;
      for (const reg of order.registrations ?? []) {
        for (const rt of reg.tickets ?? []) {
          if (rt.ticket?.modality) modalitySet.add(rt.ticket.modality);
        }
        // pick invitedBy from first registration that has it
        if (!invitedBy && reg.invitedBy) {
          invitedBy = {
            id: reg.invitedBy.id,
            fullName: `${reg.invitedBy.firstName} ${reg.invitedBy.lastName}`.trim(),
          };
        }
      }
      return {
        id: order.id,
        status: this.deriveOrderStatus(order.status, order.payment?.status ?? null),
        createdAt: order.createdAt,
        event: order.event,
        modalities: Array.from(modalitySet),
        invitedBy,
      };
    });

    return {
      message: 'Orders fetched successfully',
      data: {
        orders: formattedOrders,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
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
            batch: { select: { id: true, price: true } },
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
                description: true,
                type: true,
                isRequired: true,
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
      throw new NotFoundException('Inscrição não encontrada');
    }

    const reg = registration as any;
    const participant = await this.resolveParticipant(reg, prismaRead);

    const pendingProductsMap = new Map<string, { variationId?: string; quantity: number }>();
    for (const pp of (reg.order?.pendingProducts as any[] | null) ?? []) {
      pendingProductsMap.set(pp.productId, { variationId: pp.variationId, quantity: pp.quantity });
    }

    const formattedRegistration = {
      id: reg.id,
      qrCode: `https://www.podioticket.com.br/user/tickets/${reg.id}`,
      user: participant,
      modalities: (reg.modalities || []).map((rm: any) => ({
        id: rm.id,
        modality: {
          id: rm.modality.id,
          name: rm.modality.name,
          distance: null, // Modality não tem campo distance no schema
          category: null, // Modality não tem category no schema
        },
      })),
      ticket: reg.tickets && reg.tickets.length > 0 ? (() => {
        const rt = reg.tickets[0];
        const snap = rt.ticketSnapshot as Record<string, any> | null;
        const t = rt.ticket;
        const dist = snap?.distance ?? t.distance;
        const distUnit = snap?.distanceUnit ?? t.distanceUnit;
        const snapCat = snap?.category as Record<string, any> | null | undefined;
        return {
          id: snap?.id ?? t.id,
          name: snap?.name ?? t.name,
          distance: dist ? (distUnit ? `${dist} ${distUnit}` : dist) : null,
          category: snapCat ?? (t.category ? { id: t.category.id, name: t.category.name } : null),
          includedProducts: (t.products || []).map((tp: any) => {
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
        };
      })() : null,
      questionAnswers: (reg.questionAnswers || []).map((qa: any) => {
        const qSnap = qa.questionSnapshot as Record<string, any> | null;
        const qData = qSnap ?? qa.question ?? {};
        return {
          id: qa.id,
          question: {
            id: qData.id,
            question: qData.question,
            description: qData.description ?? null,
          },
          answer: qa.answer as string,
        };
      }),
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
      products: (reg.products || []).map((rp: any) => {
        const snap = rp.productSnapshot as Record<string, any> | null;
        const productData = snap ?? rp.product ?? {};
        const variationData = snap?.selectedVariation ?? (rp.variation ? {
          id: rp.variation.id, name: rp.variation.name, price: rp.variation.price,
        } : null);
        return {
          id: rp.id,
          product: {
            id: productData.id,
            name: productData.name,
            image: productData.images?.[productData.primaryImageIndex ?? 0] ?? productData.image ?? null,
            basePrice: productData.basePrice,
            isIncludedInTicket: productData.isIncludedInTicket ?? false,
            isRequired: productData.isRequired ?? false,
            variationType: productData.variationType ?? null,
          },
          variation: variationData,
          variationName: variationData?.name ?? null,
          quantity: rp.quantity,
          unitPrice: rp.unitPrice,
          totalPrice: rp.totalPrice,
        };
      }),
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
              select: { id: true, question: true, description: true, type: true, isRequired: true },
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
      throw new NotFoundException('Inscrição não encontrada');
    }

    const currentUser = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { documentNumberClean: true, role: true },
    });
    const isAdmin = currentUser?.role === 'PODIOGO_STAFF' || currentUser?.role === 'ADMIN';
    const isBuyer = registration.order?.userId === userId;
    const isParticipant = registration.userId === userId;
    const isInviter = registration.invitedById === userId;
    const isCpfMatch = !!(currentUser?.documentNumberClean && (registration as any).participantCpfClean === currentUser.documentNumberClean);

    if (!isAdmin && !isParticipant && !isInviter && !isBuyer && !isCpfMatch) {
      throw new BadRequestException('Acesso negado — você só pode visualizar suas próprias inscrições');
    }

    const reg = registration as any;
    const participant = await this.resolveParticipant(reg, prismaRead);

    const formattedRegistration = {
      id: reg.id,
      status: reg.status,
      qrCode: `https://www.podioticket.com.br/user/tickets/${reg.id}`,
      createdAt: reg.createdAt,
      updatedAt: reg.updatedAt,
      participant,
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
      ticket: reg.tickets?.[0] ? (() => {
        const rt = reg.tickets[0];
        const snap = rt.ticketSnapshot as Record<string, any> | null;
        const t = rt.ticket;
        const snapCat = snap?.category as Record<string, any> | null | undefined;
        return {
          id: snap?.id ?? t.id,
          name: snap?.name ?? t.name,
          description: snap?.description ?? t.description ?? null,
          modality: snap?.modality ?? t.modality ?? null,
          distance: snap?.distance ?? t.distance ?? null,
          distanceUnit: snap?.distanceUnit ?? t.distanceUnit ?? null,
          gender: snap?.gender ?? t.gender ?? null,
          ageLimitMin: snap?.ageLimitMin ?? t.ageLimitMin ?? null,
          ageLimitMax: snap?.ageLimitMax ?? t.ageLimitMax ?? null,
          hasKit: snap?.hasKit ?? t.hasKit,
          category: snapCat ?? (t.category ? { id: t.category.id, name: t.category.name } : null),
          kit: t.kit ? { id: t.kit.id, name: t.kit.name } : null,
        };
      })() : null,
      products: (reg.products || []).map((rp: any) => {
        // Usa snapshot se disponível (produto pode ter sido deletado ou editado após a compra)
        const snap = rp.productSnapshot as Record<string, any> | null;
        const productData = snap ?? rp.product ?? {};
        const variationData = snap?.selectedVariation ?? (rp.variation ? {
          id: rp.variation.id,
          name: rp.variation.name,
          price: rp.variation.price,
        } : null);
        return {
          id: rp.id,
          product: {
            id: productData.id,
            name: productData.name,
            image: productData.images?.[productData.primaryImageIndex ?? 0] ?? productData.image ?? null,
            basePrice: productData.basePrice,
            isIncludedInTicket: productData.isIncludedInTicket ?? false,
            isRequired: productData.isRequired ?? false,
            variationType: productData.variationType ?? null,
          },
          variation: variationData,
          quantity: rp.quantity,
          unitPrice: rp.unitPrice,
          totalPrice: rp.totalPrice,
        };
      }),
      questionAnswers: (reg.questionAnswers || []).map((qa: any) => {
        const qSnap = qa.questionSnapshot as Record<string, any> | null;
        const qData = qSnap ?? qa.question ?? {};
        return {
          id: qa.id,
          question: {
            id: qData.id,
            question: qData.question,
            description: qData.description ?? null,
            type: qData.type,
            isRequired: qData.isRequired,
          },
          answer: qa.answer as string,
        };
      }),
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

  async updateProductVariation(
    registrationId: string,
    productId: string,
    variationId: string,
    userId: string,
  ) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const registration = await prismaRead.registration.findUnique({
      where: { id: registrationId },
      include: {
        order: { select: { eventId: true } },
        tickets: { select: { ticketId: true } },
        products: {
          where: { productId },
          include: {
            product: {
              select: {
                id: true,
                isIncludedInTicket: true,
                buyerVariationEditAllowed: true,
                variationEditDeadlineDays: true,
                variations: { select: { id: true } },
              },
            },
          },
        },
      },
    });

    if (!registration) {
      throw new NotFoundException('Inscrição não encontrada');
    }
    const isBuyerUpdate = registration.order?.eventId && (registration as any).invitedById === userId;
    if (registration.userId !== userId && !isBuyerUpdate && !await this.isAdminUser(userId)) {
      throw new NotFoundException('Inscrição não encontrada');
    }

    if (registration.status !== 'CONFIRMED') {
      throw new BadRequestException('Só é possível alterar variação em inscrições confirmadas');
    }

    // Produto incluso pode não ter RegistrationProduct criado no pagamento
    // (caso o frontend não o tenha enviado em pendingProducts)
    const regProduct = registration.products[0] ?? null;

    // Buscar o produto diretamente se não há RegistrationProduct
    const product = regProduct?.product ?? await prismaRead.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        isIncludedInTicket: true,
        buyerVariationEditAllowed: true,
        variationEditDeadlineDays: true,
        variations: { select: { id: true } },
      },
    });

    if (!product) {
      throw new NotFoundException('Produto não encontrado');
    }

    // Produto deve ser incluso no ingresso
    if (!product.isIncludedInTicket) {
      throw new BadRequestException('Alteração de variação permitida apenas para produtos inclusos no ingresso');
    }

    // Produto deve ter edição habilitada
    if (!product.buyerVariationEditAllowed) {
      throw new BadRequestException('Este produto não permite alteração de variação');
    }

    // Só pode alterar uma vez (apenas se já existe um RegistrationProduct com variationEdited)
    if (regProduct?.variationEdited) {
      throw new BadRequestException('A variação deste produto já foi alterada anteriormente');
    }

    // Verificar se o produto está vinculado ao ingresso da inscrição
    const ticketId = registration.tickets[0]?.ticketId;
    if (ticketId) {
      const ticketProduct = await prismaRead.ticketProduct.findUnique({
        where: { ticketId_productId: { ticketId, productId } },
      });
      if (!ticketProduct) {
        throw new BadRequestException('Produto não está vinculado ao ingresso desta inscrição');
      }
    }

    // Verificar janela de edição
    if (product.variationEditDeadlineDays > 0) {
      const event = await prismaRead.event.findUnique({
        where: { id: registration.order.eventId },
        select: { eventDate: true },
      });
      if (event) {
        const deadlineMs = product.variationEditDeadlineDays * 24 * 60 * 60 * 1000;
        const cutoff = new Date(event.eventDate.getTime() - deadlineMs);
        if (new Date() >= cutoff) {
          throw new BadRequestException('Prazo para alteração de variação encerrado');
        }
      }
    }

    // Validar variationId
    const validVariation = product.variations.find((v) => v.id === variationId);
    if (!validVariation) {
      throw new BadRequestException('Variação inválida para este produto');
    }

    if (regProduct) {
      await prismaWrite.registrationProduct.update({
        where: { id: regProduct.id },
        data: { variationId, variationEdited: true },
      });
    } else {
      // Criar RegistrationProduct para produto incluso que ainda não tem registro
      await prismaWrite.registrationProduct.create({
        data: {
          registrationId,
          productId,
          variationId,
          variationEdited: true,
          quantity: 1,
          unitPrice: 0,
          totalPrice: 0,
        },
      });
    }

    return { message: 'Variação atualizada com sucesso' };
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
      throw new NotFoundException('Inscrição não encontrada');
    }

    const isBuyerCancel = registration.order?.userId === userId;
    const isParticipantCancel = registration.userId === userId;
    const isInviterCancel = registration.invitedById === userId;
    if (!isParticipantCancel && !isInviterCancel && !isBuyerCancel && !await this.isAdminUser(userId)) {
      throw new BadRequestException('Acesso negado');
    }

    if (registration.status === RegistrationStatus.CANCELLED) {
      throw new BadRequestException('Inscrição já cancelada');
    }

    if (registration.order?.payment && registration.order.payment.status === 'PAID') {
      throw new BadRequestException('Não é possível cancelar uma inscrição paga');
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
      throw new NotFoundException('Cupom não encontrado');
    }

    if (coupon.status !== 'ACTIVE') {
      throw new BadRequestException('Cupom não está ativo');
    }

    // Verificar expiração
    if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
      throw new BadRequestException('Cupom expirado');
    }

    // Verificar CPF list se habilitado
    if (coupon.cpfListStatus === 'ENABLED') {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { documentNumber: true },
      });

      if (!user || !user.documentNumber) {
        throw new BadRequestException('CPF do usuário é obrigatório para este cupom');
      }

      const cpfList = ((coupon.cpfList as string[] | null) ?? []).map((c) => c.replace(/\D/g, ''));
      const userCpf = user.documentNumber.replace(/\D/g, '');
      if (cpfList.length === 0 || !cpfList.includes(userCpf)) {
        throw new BadRequestException('Cupom não é válido para este usuário');
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
          throw new BadRequestException('Cupom não se aplica às modalidades selecionadas');
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
        throw new BadRequestException('CPF do usuário é obrigatório para este voucher');
      }

      const cpfList = ((voucher.cpfList as string[] | null) ?? []).map((c) => c.replace(/\D/g, ''));
      const userCpf = user.documentNumber.replace(/\D/g, '');
      if (cpfList.length === 0 || !cpfList.includes(userCpf)) {
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

