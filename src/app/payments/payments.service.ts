import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePaymentDto, ProcessPaymentDto, ConfirmPaymentDto } from './dto/create-payment.dto';
import { PaymentStatus, PaymentMethod } from '@prisma/client';
import { CieloService } from './cielo.service';
import {
  PAYMENT_DETAILS_STANDARD_INCLUDE,
  TICKET_CATEGORY_DETAIL_INCLUDE,
} from './payment-details-standard.include';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cieloService: CieloService,
  ) { }

  /**
   * Retorna o valor em centavos (valores já estão em centavos no banco)
   */
  private normalizeToCents(value: number | null | undefined): number {
    if (!value || value === 0) return 0;
    return value; // Valor exato, sem arredondamento
  }

  async create(userId: string, createPaymentDto: CreatePaymentDto) {
    const { registrationId, method, metadata } = createPaymentDto;

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se a inscrição existe e pertence ao usuário
    const registration = await prismaRead.registration.findUnique({
      where: { id: registrationId },
      include: {
        order: {
          include: {
            payment: true,
          },
        },
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

    if (!registration) {
      throw new NotFoundException('Registration not found');
    }

    if (!registration.order) {
      throw new BadRequestException('Registration must have an order');
    }

    if (registration.status === 'CANCELLED') {
      throw new BadRequestException('Registration is cancelled');
    }

    if (registration.order.payment) {
      throw new BadRequestException('Payment already exists for this order');
    }

    // Criar pagamento na Cielo
    const cieloResult = await this.cieloService.createPayment(
      registration.order.finalAmount,
      'BRL',
      method,
      registrationId,
      {
        name: `${registration.user.firstName} ${registration.user.lastName}`,
        email: registration.user.email,
      },
    );

    if (!cieloResult.success) {
      throw new BadRequestException(cieloResult.error || 'Failed to create payment');
    }

    // Criar pagamento no banco
    const payment = await prismaWrite.payment.create({
      data: {
        orderId: registration.orderId,
        userId,
        method,
        status: PaymentStatus.PENDING,
        amount: registration.order.finalAmount,
        transactionId: cieloResult.paymentId,
        metadata: {
          ...metadata,
          cieloPaymentId: cieloResult.paymentId,
          clientSecret: cieloResult.clientSecret,
          qrCode: cieloResult.qrCode,
          pixCode: cieloResult.pixCode,
          barcode: cieloResult.barcode,
          boletoUrl: cieloResult.boletoUrl,
          expiresAt: cieloResult.expiresAt?.toISOString(),
        } as any,
      },
      include: {
        order: {
          include: {
            event: true,
            registrations: true,
          },
        },
      },
    });

    return {
      message: 'Payment created successfully',
      data: {
        payment,
        paymentIntent: {
          id: cieloResult.paymentId,
          clientSecret: cieloResult.clientSecret,
          qrCode: cieloResult.qrCode,
          pixCode: cieloResult.pixCode,
          barcode: cieloResult.barcode,
          boletoUrl: cieloResult.boletoUrl,
          expiresAt: cieloResult.expiresAt,
        },
      },
    };
  }

  async confirmPayment(userId: string, confirmPaymentDto: ConfirmPaymentDto) {
    const { paymentId, paymentMethodId } = confirmPaymentDto;

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const payment = await prismaRead.payment.findUnique({
      where: { id: paymentId },
      include: {
        order: {
          include: {
            registrations: true,
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.status === PaymentStatus.PAID) {
      throw new BadRequestException('Payment already processed');
    }

    if (!payment.transactionId) {
      throw new BadRequestException('Payment intent not found');
    }

    // Capturar pagamento na Cielo
    const cieloResult = await this.cieloService.capturePayment(payment.transactionId || '');

    if (!cieloResult.success) {
      throw new BadRequestException(cieloResult.error || 'Failed to confirm payment');
    }

    // Atualizar status no banco
    const updatedPayment = await prismaWrite.$transaction(async (prisma) => {
      const paymentUpdate = await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.PAID,
          paymentDate: new Date(),
          metadata: {
            ...(payment.metadata as any),
            confirmedAt: new Date().toISOString(),
            cieloStatus: cieloResult.cieloStatus,
          } as any,
        },
      });

      // Atualizar status das inscrições do pedido
      await prisma.registration.updateMany({
        where: { orderId: payment.orderId },
        data: {
          status: 'CONFIRMED',
        },
      });

      return paymentUpdate;
    });

    return {
      message: 'Payment confirmed successfully',
      data: { payment: updatedPayment },
    };
  }

  async processPayment(userId: string, processPaymentDto: ProcessPaymentDto) {
    const { paymentId, transactionId, metadata } = processPaymentDto;

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const payment = await prismaRead.payment.findUnique({
      where: { id: paymentId },
      include: {
        order: {
          include: {
            registrations: true,
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.status === PaymentStatus.PAID) {
      throw new BadRequestException('Payment already processed');
    }

    // Verificar status na Cielo
    const cieloPayment = await this.cieloService.getPayment(
      payment.transactionId || transactionId || '',
    );

    if (!cieloPayment) {
      throw new BadRequestException('Payment not found');
    }

    const paymentStatus = this.cieloService.mapCieloStatusToPaymentStatus(
      cieloPayment.Payment.Status,
    );

    // Atualizar status no banco
    const updatedPayment = await prismaWrite.$transaction(async (prisma) => {
      const paymentUpdate = await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: paymentStatus,
          transactionId: cieloPayment.Payment.PaymentId,
          paymentDate: paymentStatus === PaymentStatus.PAID ? new Date() : null,
          metadata: {
            ...(payment.metadata as any),
            ...metadata,
            cieloStatus: this.cieloService.mapCieloStatusToString(cieloPayment.Payment.Status),
            lastChecked: new Date().toISOString(),
          } as any,
        },
      });

      // Atualizar status das inscrições do pedido se pago
      if (paymentStatus === PaymentStatus.PAID) {
        await prisma.registration.updateMany({
          where: { orderId: payment.orderId },
          data: {
            status: 'CONFIRMED',
          },
        });
      }

      return paymentUpdate;
    });

    return {
      message: 'Payment processed successfully',
      data: { payment: updatedPayment },
    };
  }

  async findOne(id: string, userId: string) {
    const prismaRead = this.prisma.getReadClient();

    const payment = await prismaRead.payment.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            event: true,
            registrations: {
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
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    // Buscar informações atualizadas da Cielo se disponível
    let cieloInfo = null;
    if (payment.transactionId) {
      const cieloPayment = await this.cieloService.getPayment(payment.transactionId);
      if (cieloPayment) {
        cieloInfo = {
          status: this.cieloService.mapCieloStatusToString(cieloPayment.Payment.Status),
          amount: cieloPayment.Payment.Amount / 100,
          currency: cieloPayment.Payment.Currency,
        };
      }
    }

    return {
      message: 'Payment fetched successfully',
      data: {
        payment,
        cieloInfo,
      },
    };
  }

  async getUserPayments(userId: string) {
    const prismaRead = this.prisma.getReadClient();

    const payments = await prismaRead.payment.findMany({
      where: { userId },
      include: {
        order: {
          include: {
            event: {
              select: {
                id: true,
                name: true,
                eventDate: true,
              },
            },
            registrations: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      message: 'Payments fetched successfully',
      data: { payments },
    };
  }

  async getPaymentSummary(registrationId: string) {
    const prismaRead = this.prisma.getReadClient();

    const registration = await prismaRead.registration.findUnique({
      where: { id: registrationId },
      include: {
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

    if (!registration.order) {
      throw new BadRequestException('Registration must have an order');
    }

    return {
      message: 'Payment summary fetched successfully',
      data: {
        totalAmount: registration.order.totalAmount,
        serviceFee: registration.order.serviceFee,
        discount: registration.order.discount,
        finalAmount: registration.order.finalAmount,
        payment: registration.order.payment,
      },
    };
  }

  /**
   * Busca detalhes completos do pagamento por transactionId, orderId, paymentId ou registrationId
   */
  async getPaymentDetails(identifier: string, identifierType: 'transaction' | 'order' | 'payment' | 'registration', userId?: string) {
    const prismaRead = this.prisma.getReadClient();

    // Validar e limpar formato do identificador
    let cleanIdentifier = identifier.trim();

    if (identifierType === 'order' || identifierType === 'registration') {
      // UUID deve ter formato: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (5 grupos, 36 caracteres total)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      // Tentar remover sufixos comuns (ex: -2, -installment-2, etc.) se o formato não for válido
      if (!uuidRegex.test(cleanIdentifier)) {
        // Tentar extrair apenas os primeiros 5 grupos (formato UUID padrão)
        // Aceita UUIDs completos mesmo com sufixos como -installment-2
        const uuidMatch = cleanIdentifier.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (uuidMatch && uuidMatch[1].length === 36) { // UUID completo tem 36 caracteres (32 hex + 4 hífens)
          cleanIdentifier = uuidMatch[1];
        } else {
          // Verificar se é um UUID incompleto
          const hexChars = cleanIdentifier.replace(/-/g, '').length;
          if (hexChars < 32) {
            throw new BadRequestException(
              `Invalid ${identifierType} ID format. UUID appears to be incomplete (expected 32 hexadecimal characters, found ${hexChars}). ` +
              `Received: ${identifier}. Please use the full UUID from the payment or order.`
            );
          } else {
            throw new BadRequestException(
              `Invalid ${identifierType} ID format. Expected UUID format (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). ` +
              `Received: ${identifier}`
            );
          }
        }
      }
    }

    // Usar o identificador limpo
    identifier = cleanIdentifier;

    let payment: any = null;

    // Buscar pagamento baseado no tipo de identificador
    if (identifierType === 'transaction') {
      payment = await prismaRead.payment.findFirst({
        where: { transactionId: identifier },
        include: PAYMENT_DETAILS_STANDARD_INCLUDE,
      });
    } else if (identifierType === 'order') {
      payment = await prismaRead.payment.findUnique({
        where: { orderId: identifier },
        include: PAYMENT_DETAILS_STANDARD_INCLUDE,
      });
    } else if (identifierType === 'payment') {
      payment = await prismaRead.payment.findUnique({
        where: { id: identifier },
        include: PAYMENT_DETAILS_STANDARD_INCLUDE,
      });
    } else if (identifierType === 'registration') {
      const registration = await prismaRead.registration.findUnique({
        where: { id: identifier },
        include: {
          order: {
            include: {
              payment: {
                include: {
                  order: {
                    include: {
                      event: {
                        include: {
                          organization: {
                            include: {
                              members: {
                                where: { role: 'OWNER' },
                                include: {
                                  user: {
                                    select: {
                                      id: true,
                                      firstName: true,
                                      lastName: true,
                                      email: true,
                                      avatarUrl: true,
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                      registrations: {
                        include: {
                          user: {
                            select: {
                              id: true,
                              firstName: true,
                              lastName: true,
                              email: true,
                              phone: true,
                              documentNumber: true,
                              dateOfBirth: true,
                              reservePhone: true,
                              gender: true,
                            },
                          },
                          tickets: {
                            include: {
                              ticket: {
                                include: {
                                  category: TICKET_CATEGORY_DETAIL_INCLUDE,
                                },
                              },
                            },
                          },
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
                      phone: true,
                      documentNumber: true,
                      dateOfBirth: true,
                      reservePhone: true,
                      gender: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!registration) {
        throw new NotFoundException('Registration not found');
      }

      if (!registration.order?.payment) {
        throw new NotFoundException('Payment not found for this registration');
      }

      payment = registration.order.payment;
      // Garantir que payment.order tenha todas as registrations do pedido
      // Como payment é do tipo Payment e não tem order tipado, precisamos fazer cast
      // Preservar todas as propriedades do order, incluindo registrations
      (payment as any).order = registration.order;
      
      // Se as registrations não estiverem carregadas, buscar diretamente do banco
      if (!(payment as any).order.registrations || (payment as any).order.registrations.length === 0) {
        const orderWithRegistrations = await prismaRead.order.findUnique({
          where: { id: registration.orderId },
          include: {
            registrations: {
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    phone: true,
                    documentNumber: true,
                    dateOfBirth: true,
                    reservePhone: true,
                    gender: true,
                  },
                },
                tickets: {
                  include: {
                    ticket: {
                      include: {
                        category: TICKET_CATEGORY_DETAIL_INCLUDE,
                      },
                    },
                  },
                },
              },
            },
          },
        });
        if (orderWithRegistrations) {
          (payment as any).order.registrations = orderWithRegistrations.registrations;
        }
      }
    }

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    // Verificar permissão se userId for fornecido
    if (userId && payment.userId !== userId) {
      // Verificar se o usuário é organizador do evento
      // Primeiro verifica nos membros já carregados (pode ter apenas OWNER)
      let isOrganizer = payment.order?.event?.organization?.members?.some(
        (member: any) => member.userId === userId,
      );
      
      // Se não encontrou, busca todos os membros da organização
      // Pode buscar organizationId de payment.order.event.organizationId ou payment.order.event.organization.id
      let organizationId = payment.order?.event?.organizationId || payment.order?.event?.organization?.id;
      
      // Se ainda não encontrou o organizationId, busca o evento diretamente
      if (!organizationId && payment.order?.eventId) {
        const event = await prismaRead.event.findUnique({
          where: { id: payment.order.eventId },
          select: { organizationId: true },
        });
        organizationId = event?.organizationId;
      }
      
      if (!isOrganizer && organizationId) {
        const allMembers = await prismaRead.organizationMember.findMany({
          where: {
            organizationId: organizationId,
            userId: userId,
          },
        });
        isOrganizer = allMembers.length > 0;
      }
      
      if (!isOrganizer) {
        throw new BadRequestException('Access denied');
      }
    }

    const metadata = payment.metadata as any || {};
    const creditCardInfo = metadata.creditCard || {};
    const pixInfo = metadata.pix || {};
    const boletoInfo = metadata.boleto || {};

    // Buscar cupom usado (se houver)
    let coupon = null;
    if (payment.order?.couponId) {
      coupon = await prismaRead.coupon.findUnique({
        where: { id: payment.order.couponId },
        select: {
          id: true,
          code: true,
          couponType: true,
          type: true,
          value: true,
        },
      });
    }

    // Formatar resposta
    const buyer = payment.user;
    const organizer = payment.order?.event?.organization?.members?.[0]?.user || null;
    const event = payment.order?.event;

    return {
      message: 'Payment details fetched successfully',
      data: {
        // Informações do comprador
        buyer: {
          id: buyer?.id,
          fullName: buyer ? `${buyer.firstName} ${buyer.lastName}` : null,
          firstName: buyer?.firstName,
          lastName: buyer?.lastName,
          email: buyer?.email,
          documentNumber: buyer?.documentNumber,
          phone: buyer?.phone,
          dateOfBirth: buyer?.dateOfBirth,
          reservePhone: buyer?.reservePhone,
          gender: buyer?.gender,
        },
        // Informações do pagamento
        payment: {
          id: payment.id,
          method: payment.method,
          status: payment.status,
          // payment.amount e order.finalAmount são Float no schema
          // Como order.finalAmount foi salvo como centavos (Math.round), mas é Float, pode estar em reais
          // Precisamos normalizar: se o valor parece estar em reais (pequeno), multiplicar por 100
          // Se parece estar em centavos (grande), usar diretamente
          totalAmount: payment.order?.finalAmount
            ? this.normalizeToCents(payment.order.finalAmount)
            : this.normalizeToCents(payment.amount),
          purchaseDate: payment.order?.createdAt,
          paymentDate: payment.paymentDate,
          gateway: 'CIELO',
          authorizationCode: metadata.authorizationCode || null,
          nsu: metadata.proofOfSale || null,
          transactionIp: metadata.transactionIp || null,
          // Parcelamento (se aplicável)
          installments: creditCardInfo.installments || null,
          // installmentValue no metadata: foi calculado como prices.finalTotal / installments (em centavos)
          // Mas como está em JSON (Float), pode ter sido convertido para reais
          installmentValue: creditCardInfo.installmentValue
            ? this.normalizeToCents(creditCardInfo.installmentValue)
            : null,
          // Informações do cartão de crédito (se aplicável)
          cardBrand: creditCardInfo.brand || null,
          last4Digits: creditCardInfo.last4Digits || null,
          cardHolder: creditCardInfo.holder || null,
          // Informações adicionais do pagamento
          returnCode: metadata.returnCode || null,
          returnMessage: metadata.returnMessage || null,
          cieloPaymentId: metadata.cieloPaymentId || null,
          cieloStatus: metadata.cieloStatus || null,
          // Informações PIX (se aplicável)
          pix: pixInfo.qrCode || pixInfo.pixCode ? {
            qrCode: pixInfo.qrCode,
            pixCode: pixInfo.pixCode,
            expiresAt: pixInfo.expiresAt,
          } : null,
          // Informações Boleto (se aplicável)
          boleto: boletoInfo.barcode ? {
            barcode: boletoInfo.barcode,
            digitableLine: boletoInfo.digitableLine,
            expiresAt: boletoInfo.expiresAt,
            url: boletoInfo.url,
          } : null,
        },
        // Informações do evento
        event: event ? {
          id: event.id,
          name: event.name,
          category: event.category || null,
          organizer: organizer ? {
            id: organizer.id,
            name: `${organizer.firstName} ${organizer.lastName}`,
            email: organizer.email,
            avatar: organizer.avatarUrl,
          } : null,
        } : null,
        // Cupom utilizado (se houver)
        coupon: coupon ? {
          id: coupon.id,
          code: coupon.code,
          type: coupon.type,
          discountValue: coupon.type === 'PERCENTAGE' ? null : coupon.value,
          discountPercentage: coupon.type === 'PERCENTAGE' ? coupon.value : null,
        } : null,
        // IDs
        transactionId: payment.transactionId,
        orderId: payment.orderId,
        // Todos os inscritos do pedido
        registrations: (() => {
          const orderRegistrations = (payment as any).order?.registrations || [];
          
          // Mapear as registrations existentes
          const mappedRegistrations = orderRegistrations.map((reg: any) => ({
            id: reg.id,
            name: reg.user ? `${reg.user.firstName} ${reg.user.lastName}` : null,
            email: reg.user?.email || null,
            ticket: reg.tickets && reg.tickets.length > 0 ? {
              id: reg.tickets[0].ticket.id,
              name: reg.tickets[0].ticket.name,
            } : null,
            ticketCategory: reg.tickets && reg.tickets.length > 0 && reg.tickets[0].ticket.category ? {
              id: reg.tickets[0].ticket.category.id,
              name: reg.tickets[0].ticket.category.name,
            } : null,
          }));
          
          // Verificar se o comprador (buyer) já está na lista de registrations
          const buyerId = buyer?.id;
          const buyerAlreadyInList = buyerId && orderRegistrations.some((reg: any) => reg.userId === buyerId);
          
          // Se o comprador não estiver na lista, adicionar (mesmo sem registration, ele fez o pedido)
          if (buyerId && !buyerAlreadyInList) {
            mappedRegistrations.push({
              id: null, // Comprador pode não ter registration própria
              name: buyer ? `${buyer.firstName} ${buyer.lastName}` : null,
              email: buyer?.email || null,
              ticket: null, // Comprador pode não ter ticket se comprou apenas para outros
              ticketCategory: null,
            });
          }
          
          return mappedRegistrations;
        })(),
      },
    };
  }
}
