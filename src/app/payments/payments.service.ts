import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePaymentDto, ProcessPaymentDto, ConfirmPaymentDto } from './dto/create-payment.dto';
import { PaymentStatus, PaymentMethod } from '@prisma/client';
import { CieloService } from './cielo.service';
import { PaymentGateway } from './payment.gateway';
import { EmailService } from '../../common/services/email.service';
import { TicketPdfService } from '../../common/services/ticket-pdf.service';
import {
  PAYMENT_DETAILS_STANDARD_INCLUDE,
  TICKET_CATEGORY_DETAIL_INCLUDE,
} from './payment-details-standard.include';

function formatEventDate(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = new Date(date as string);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatEventAddress(event: any): string {
  const parts: string[] = [];
  const cityState: string[] = [];
  if (event.city) cityState.push(event.city);
  if (event.state) cityState.push(event.state);
  if (cityState.length) parts.push(cityState.join(' - '));
  if (event.neighborhood) parts.push(event.neighborhood);
  if (event.location) parts.push(event.location);
  if (event.zipCode) {
    const cep = String(event.zipCode).replace(/\D/g, '');
    parts.push(cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep);
  }
  return parts.join(', ');
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cieloService: CieloService,
    private readonly gateway: PaymentGateway,
    private readonly emailService: EmailService,
    private readonly ticketPdfService: TicketPdfService,
  ) { }

  private async isAdminUser(userId: string): Promise<boolean> {
    const user = await this.prisma.getReadClient().user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user?.role === 'PODIOGO_STAFF' || user?.role === 'ADMIN';
  }

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

    // Atualizar status no banco — guarda atômica: só avança se ainda não estiver PAID
    const updatedPayment = await prismaWrite.$transaction(async (prisma) => {
      const result = await prisma.payment.updateMany({
        where: { id: paymentId, status: { not: PaymentStatus.PAID } },
        data: { status: PaymentStatus.PAID, paymentDate: new Date() },
      });

      if (result.count === 0) {
        // Confirmação concorrente chegou primeiro — idempotente
        return prisma.payment.findUnique({ where: { id: paymentId } });
      }

      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          metadata: {
            ...(payment.metadata as any),
            confirmedAt: new Date().toISOString(),
            cieloStatus: cieloResult.cieloStatus,
          } as any,
        },
      });

      await prisma.order.update({
        where: { id: payment.orderId },
        data: { status: 'PAID' },
      });

      await prisma.registration.updateMany({
        where: { orderId: payment.orderId },
        data: { status: 'CONFIRMED' },
      });

      // Marcar cupom/voucher como usados
      const paidOrder = await prisma.order.findUnique({
        where: { id: payment.orderId },
        select: { couponId: true, voucherId: true, userId: true, reservedTickets: true },
      });
      if (paidOrder?.couponId) {
        const coupon = await prisma.coupon.findUnique({
          where: { id: paidOrder.couponId },
          select: { couponType: true, maxUsage: true, usageCount: true },
        });
        if (coupon) {
          const tickets = (paidOrder.reservedTickets ?? []) as any[];
          const ticketCount = tickets.reduce((s: number, rt: any) => s + (rt.quantity ?? 1), 0);
          const remaining = coupon.maxUsage != null ? Math.max(0, coupon.maxUsage - coupon.usageCount) : ticketCount;
          const increment = coupon.couponType === 'QUANTITY' ? 1 : Math.min(remaining, ticketCount);
          if (increment > 0) {
            await prisma.coupon.update({ where: { id: paidOrder.couponId }, data: { usageCount: { increment } } });
          }
        }
      }
      if (paidOrder?.voucherId) {
        // Transição atômica ACTIVE → USED para evitar sobrescrita em corrida
        const voucherResult = await prisma.voucher.updateMany({
          where: { id: paidOrder.voucherId, status: 'ACTIVE' },
          data: { status: 'USED', usedAt: new Date(), usedBy: paidOrder.userId },
        });
        if (voucherResult.count === 0) {
          this.logger.error(
            `[VOUCHER-RACE] confirmPayment: voucher ${paidOrder.voucherId} já estava USED para order ${payment.orderId} — possível dupla utilização, requer estorno manual`,
          );
        }
      }

      return prisma.payment.findUnique({ where: { id: paymentId } });
    });

    // Enviar email de confirmação fire-and-forget
    this.sendConfirmationEmailForOrder(payment.orderId)
      .catch((err: any) => this.logger.warn('Falha ao enviar email de confirmação (cartão):', err));

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

    // Atualizar status no banco — guarda atômica contra confirmação dupla
    const updatedPayment = await prismaWrite.$transaction(async (prisma) => {
      const whereCondition = paymentStatus === PaymentStatus.PAID
        ? { id: paymentId, status: { not: PaymentStatus.PAID } }
        : { id: paymentId };

      const result = await prisma.payment.updateMany({
        where: whereCondition,
        data: {
          status: paymentStatus,
          transactionId: cieloPayment.Payment.PaymentId,
          paymentDate: paymentStatus === PaymentStatus.PAID ? new Date() : null,
        },
      });

      if (paymentStatus === PaymentStatus.PAID && result.count === 0) {
        // Confirmação concorrente chegou primeiro — idempotente
        return prisma.payment.findUnique({ where: { id: paymentId } });
      }

      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          metadata: {
            ...(payment.metadata as any),
            ...metadata,
            cieloStatus: this.cieloService.mapCieloStatusToString(cieloPayment.Payment.Status),
            lastChecked: new Date().toISOString(),
          } as any,
        },
      });

      if (paymentStatus === PaymentStatus.PAID) {
        await prisma.order.update({
          where: { id: payment.orderId },
          data: { status: 'PAID' },
        });

        await prisma.registration.updateMany({
          where: { orderId: payment.orderId },
          data: { status: 'CONFIRMED' },
        });

        // Marcar cupom/voucher como usados
        const paidOrder = await prisma.order.findUnique({
          where: { id: payment.orderId },
          select: { couponId: true, voucherId: true, userId: true, reservedTickets: true },
        });
        if (paidOrder?.couponId) {
          const coupon = await prisma.coupon.findUnique({
            where: { id: paidOrder.couponId },
            select: { couponType: true, maxUsage: true, usageCount: true },
          });
          if (coupon) {
            const tickets = (paidOrder.reservedTickets ?? []) as any[];
            const ticketCount = tickets.reduce((s: number, rt: any) => s + (rt.quantity ?? 1), 0);
            const remaining = coupon.maxUsage != null ? Math.max(0, coupon.maxUsage - coupon.usageCount) : ticketCount;
            const increment = coupon.couponType === 'QUANTITY' ? 1 : Math.min(remaining, ticketCount);
            if (increment > 0) {
              await prisma.coupon.update({ where: { id: paidOrder.couponId }, data: { usageCount: { increment } } });
            }
          }
        }
        if (paidOrder?.voucherId) {
          const voucherResult = await prisma.voucher.updateMany({
            where: { id: paidOrder.voucherId, status: 'ACTIVE' },
            data: { status: 'USED', usedAt: new Date(), usedBy: paidOrder.userId },
          });
          if (voucherResult.count === 0) {
            this.logger.error(
              `[VOUCHER-RACE] processPayment: voucher ${paidOrder.voucherId} já estava USED para order ${payment.orderId} — possível dupla utilização, requer estorno manual`,
            );
          }
        }
      }

      return prisma.payment.findUnique({ where: { id: paymentId } });
    });

    // Enviar email de confirmação fire-and-forget se pagamento confirmado
    if (paymentStatus === PaymentStatus.PAID) {
      this.sendConfirmationEmailForOrder(payment.orderId)
        .catch((err: any) => this.logger.warn('Falha ao enviar email de confirmação (processPayment):', err));
    }

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

      // Fallback: caller may have accidentally passed a paymentId through the order route
      if (!payment) {
        payment = await prismaRead.payment.findUnique({
          where: { id: identifier },
          include: PAYMENT_DETAILS_STANDARD_INCLUDE,
        });
      }

      if (!payment) {
        const orderExists = await prismaRead.order.findUnique({
          where: { id: identifier },
          select: { id: true },
        });
        if (!orderExists) throw new NotFoundException('Order not found');
        throw new NotFoundException('No payment has been processed for this order yet');
      }
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
              // Registrations carregadas diretamente no order para garantir campos escalares
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
      // Monta payment.order combinando: event/organizer de payment.order e
      // registrations (com campos de emergência) de registration.order
      (payment as any).order = {
        ...(payment as any).order,
        registrations: (registration.order as any).registrations,
      };
      // Preserva o contato de emergência da registration consultada diretamente
      (payment as any)._queriedRegistration = {
        id: registration.id,
        emergencyContactName: (registration as any).emergencyContactName ?? null,
        emergencyContactPhone: (registration as any).emergencyContactPhone ?? null,
      };
    }

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    // Verify access if userId is provided
    if (userId && payment.userId !== userId && !await this.isAdminUser(userId)) {
      let isOrganizer = payment.order?.event?.organization?.members?.some(
        (member: any) => member.userId === userId,
      );

      let organizationId = payment.order?.event?.organizationId || payment.order?.event?.organization?.id;

      if (!organizationId && payment.order?.eventId) {
        const event = await prismaRead.event.findUnique({
          where: { id: payment.order.eventId },
          select: { organizationId: true },
        });
        organizationId = event?.organizationId;
      }

      if (!isOrganizer && organizationId) {
        const allMembers = await prismaRead.organizationMember.findMany({
          where: { organizationId, userId },
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
    const orderRow = payment.order as any;
    const billingFromOrder =
      orderRow?.billingCountry != null && String(orderRow.billingCountry).trim() !== ''
        ? {
          country: orderRow.billingCountry,
          postalCode: orderRow.billingPostalCode,
          stateUf: orderRow.billingStateUf,
          street: orderRow.billingStreet,
          number: orderRow.billingNumber,
          complement: orderRow.billingComplement,
          neighborhood: orderRow.billingNeighborhood,
          city: orderRow.billingCity,
        }
        : metadata.billingAddress ?? null;

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
          note: true,
          appliesTo: true,
          minCartValue: true,
          minQuantity: true,
          minAge: true,
          maxAge: true,
          maxUsage: true,
          usageCount: true,
          expiryDate: true,
        },
      });
    }

    // Buscar voucher usado (se houver)
    let voucher = null;
    if (payment.order?.voucherId) {
      voucher = await prismaRead.voucher.findUnique({
        where: { id: payment.order.voucherId },
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          usedAt: true,
          expiryDate: true,
          appliesTo: true,
        },
      });
    }

    // Extrair valores de desconto do metadata (registrado no momento do checkout)
    const discountsMeta = (metadata.discounts as any) ?? {};
    const couponDiscountAmount: number = discountsMeta?.coupon?.discount ?? (payment.order as any)?.discount ?? 0;
    const voucherDiscountAmount: number = discountsMeta?.voucher?.discount ?? (voucher ? (payment.order as any)?.discount ?? 0 : 0);
    const totalDiscountAmount: number = (payment.order as any)?.discount ?? discountsMeta?.totalDiscount ?? 0;

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
          emergencyPhone: buyer?.reservePhone,
          gender: buyer?.gender,
        },
        billingAddress: billingFromOrder,
        // Informações do pagamento
        payment: {
          id: payment.id,
          method: payment.method,
          status: payment.status,
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
          couponType: coupon.couponType,
          discountType: coupon.type,
          discountValue: coupon.type === 'PERCENTAGE' ? null : coupon.value,
          discountPercentage: coupon.type === 'PERCENTAGE' ? coupon.value : null,
          discountAmount: coupon ? couponDiscountAmount : null,
          note: coupon.note ?? null,
          appliesTo: coupon.appliesTo ?? null,
          minCartValue: coupon.minCartValue ?? null,
          minQuantity: coupon.minQuantity ?? null,
          minAge: coupon.minAge ?? null,
          maxAge: coupon.maxAge ?? null,
          maxUsage: coupon.maxUsage ?? null,
          usageCount: coupon.usageCount,
          expiryDate: coupon.expiryDate ?? null,
        } : null,
        // Voucher utilizado (se houver)
        voucher: voucher ? {
          id: voucher.id,
          code: voucher.code,
          name: voucher.name,
          status: voucher.status,
          usedAt: voucher.usedAt ?? null,
          expiryDate: voucher.expiryDate ?? null,
          appliesTo: voucher.appliesTo ?? null,
          discountAmount: voucherDiscountAmount,
        } : null,
        // Total de desconto aplicado (cupom + voucher)
        totalDiscount: totalDiscountAmount,
        // IDs
        transactionId: payment.transactionId,
        orderId: payment.orderId,
        // Todos os inscritos do pedido
        registrations: (() => {
          const orderRegistrations = (payment as any).order?.registrations || [];

          // Mapear as registrations existentes
          const queriedReg = (payment as any)._queriedRegistration ?? null;
          const mappedRegistrations = orderRegistrations.map((reg: any) => {
            // Para a registration consultada diretamente, usa os campos escalares dela
            const isQueried = queriedReg && reg.id === queriedReg.id;
            const emergencyName = isQueried
              ? queriedReg.emergencyContactName
              : (reg.emergencyContactName ?? null);
            const emergencyPhone = isQueried
              ? queriedReg.emergencyContactPhone
              : (reg.emergencyContactPhone ?? null);

            return {
              id: reg.id,
              name: reg.user ? `${reg.user.firstName} ${reg.user.lastName}` : null,
              email: reg.user?.email || null,
              ticket: reg.tickets && reg.tickets.length > 0 ? (() => {
                const rt = reg.tickets[0];
                const snap = rt.ticketSnapshot as Record<string, any> | null;
                return { id: snap?.id ?? rt.ticket.id, name: snap?.name ?? rt.ticket.name };
              })() : null,
              ticketCategory: reg.tickets && reg.tickets.length > 0 ? (() => {
                const rt = reg.tickets[0];
                const snap = rt.ticketSnapshot as Record<string, any> | null;
                const snapCat = snap?.category as Record<string, any> | null | undefined;
                if (snapCat) return snapCat;
                const cat = rt.ticket.category;
                return cat ? { id: cat.id, name: cat.name } : null;
              })() : null,
              emergencyContact: emergencyName || emergencyPhone ? {
                name: emergencyName,
                phone: emergencyPhone,
              } : null,
            };
          });

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

  async pollPixStatus(orderId: string, userId: string): Promise<{ status: PaymentStatus; paid: boolean }> {
    const prismaRead = this.prisma.getReadClient();
    const prismaWrite = this.prisma.getWriteClient();

    const order = await prismaRead.order.findFirst({
      where: { id: orderId, userId },
      select: {
        id: true,
        payment: {
          select: { id: true, transactionId: true, status: true, method: true, metadata: true },
        },
      },
    });

    if (!order) throw new NotFoundException('Order not found');
    if (!order.payment) throw new NotFoundException('Payment not found');

    const payment = order.payment;

    if (payment.status === PaymentStatus.PAID) {
      return { status: PaymentStatus.PAID, paid: true };
    }

    if (payment.method !== PaymentMethod.PIX || !payment.transactionId) {
      return { status: payment.status as PaymentStatus, paid: false };
    }

    const braspagPayment = await this.cieloService.getPayment(payment.transactionId);
    if (!braspagPayment) {
      return { status: payment.status as PaymentStatus, paid: false };
    }

    const newStatus = this.cieloService.mapCieloStatusToPaymentStatus(braspagPayment.Payment.Status);

    if (newStatus !== PaymentStatus.PAID) {
      return { status: newStatus, paid: false };
    }

    // Confirm atomically — same idempotency pattern as the webhook handler
    await prismaWrite.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: payment.id, status: { not: PaymentStatus.PAID } },
        data: { status: PaymentStatus.PAID, paymentDate: new Date() },
      });

      if (updated.count === 0) return; // already confirmed by concurrent request or webhook

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          metadata: {
            ...(payment.metadata as object),
            cieloStatus: this.cieloService.mapCieloStatusToString(braspagPayment.Payment.Status),
            confirmedViaPolling: true,
            confirmedAt: new Date().toISOString(),
          } as any,
        },
      });

      await tx.registration.updateMany({
        where: { orderId },
        data: { status: 'CONFIRMED' },
      });

      // Marcar cupom/voucher como usados
      const paidOrder = await tx.order.findUnique({
        where: { id: orderId },
        select: { couponId: true, voucherId: true, userId: true, reservedTickets: true },
      });
      if (paidOrder?.couponId) {
        const coupon = await tx.coupon.findUnique({
          where: { id: paidOrder.couponId },
          select: { couponType: true, maxUsage: true, usageCount: true },
        });
        if (coupon) {
          const tickets = (paidOrder.reservedTickets ?? []) as any[];
          const ticketCount = tickets.reduce((s: number, rt: any) => s + (rt.quantity ?? 1), 0);
          const remaining = coupon.maxUsage != null
            ? Math.max(0, coupon.maxUsage - coupon.usageCount)
            : ticketCount;
          const increment = coupon.couponType === 'QUANTITY' ? 1 : Math.min(remaining, ticketCount);
          if (increment > 0) {
            await tx.coupon.update({
              where: { id: paidOrder.couponId },
              data: { usageCount: { increment } },
            });
          }
        }
      }
      if (paidOrder?.voucherId) {
        const voucherResult = await tx.voucher.updateMany({
          where: { id: paidOrder.voucherId, status: 'ACTIVE' },
          data: { status: 'USED', usedAt: new Date(), usedBy: paidOrder.userId },
        });
        if (voucherResult.count === 0) {
          this.logger.error(
            `[VOUCHER-RACE] pollPixStatus: voucher ${paidOrder.voucherId} já estava USED para order ${orderId} — possível dupla utilização, requer estorno manual`,
          );
        }
      }
    });

    // Emit WebSocket event so the frontend updates immediately
    this.gateway.emitPaymentConfirmed(orderId);

    // Enviar email de confirmação fire-and-forget
    this.sendConfirmationEmailForOrder(orderId)
      .catch((err: any) => this.logger.warn('Falha ao enviar email de confirmação:', err));

    this.logger.log(`PIX confirmed via polling for order ${orderId}`);
    return { status: PaymentStatus.PAID, paid: true };
  }

  async sandboxSimulatePixPaid(transactionId: string): Promise<{ confirmed: boolean; orderId: string }> {
    if (this.cieloService.sandboxMode === false) {
      throw new BadRequestException('Only available in sandbox mode');
    }

    const payment = await this.prisma.getReadClient().payment.findFirst({
      where: { transactionId },
      select: { id: true, orderId: true, status: true, metadata: true },
    });

    if (!payment) throw new NotFoundException(`Payment not found for transactionId: ${transactionId}`);
    if (payment.status === PaymentStatus.PAID) {
      this.gateway.emitPaymentConfirmed(payment.orderId);
      return { confirmed: true, orderId: payment.orderId };
    }

    await this.prisma.getWriteClient().$transaction(async (tx) => {
      const result = await tx.payment.updateMany({
        where: { id: payment.id, status: { not: PaymentStatus.PAID } },
        data: { status: PaymentStatus.PAID, paymentDate: new Date() },
      });
      if (result.count === 0) return;

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          metadata: {
            ...(payment.metadata as object),
            simulatedAt: new Date().toISOString(),
            simulatedViaScript: true,
          } as any,
        },
      });
      await tx.order.update({
        where: { id: payment.orderId },
        data: { status: 'PAID' },
      });
      await tx.registration.updateMany({
        where: { orderId: payment.orderId },
        data: { status: 'CONFIRMED' },
      });
    });

    this.gateway.emitPaymentConfirmed(payment.orderId);
    this.logger.log(`[SANDBOX] PIX simulated as paid for transactionId ${transactionId}, orderId ${payment.orderId}`);

    // Enviar email de confirmação fire-and-forget
    this.sendConfirmationEmailForOrder(payment.orderId)
      .catch((err: any) => this.logger.warn(`[SANDBOX] Falha ao enviar email de confirmação: ${err?.message}`));

    return { confirmed: true, orderId: payment.orderId };
  }

  async sandboxSimulateDebit3dsPending(orderId: string): Promise<{ redirectUrl: string; orderId: string }> {
    if (this.cieloService.sandboxMode === false) {
      throw new BadRequestException('Only available in sandbox mode');
    }

    const order = await this.prisma.getReadClient().order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, userId: true, finalAmount: true, totalAmount: true },
    });
    if (!order) throw new NotFoundException(`Order not found: ${orderId}`);
    if (order.status !== 'PENDING') throw new BadRequestException(`Order ${orderId} is not PENDING`);

    const amount = order.finalAmount ?? order.totalAmount ?? 0;
    const fakeCieloPaymentId = `sandbox-3ds-${Date.now()}`;

    await this.prisma.getWriteClient().payment.upsert({
      where: { orderId },
      create: {
        orderId,
        userId: order.userId,
        method: 'DEBIT_CARD',
        status: PaymentStatus.PENDING,
        amount,
        transactionId: fakeCieloPaymentId,
        metadata: {
          cieloPaymentId: fakeCieloPaymentId,
          sandboxSimulated: true,
          debitCard: { brand: 'Visa', last4Digits: '0001', holder: 'SANDBOX TEST' },
        } as any,
      },
      update: {
        status: PaymentStatus.PENDING,
        amount,
        transactionId: fakeCieloPaymentId,
        method: 'DEBIT_CARD',
        metadata: {
          cieloPaymentId: fakeCieloPaymentId,
          sandboxSimulated: true,
          debitCard: { brand: 'Visa', last4Digits: '0001', holder: 'SANDBOX TEST' },
        } as any,
      },
    });

    const serverUrl = (process.env.SERVER_URL ?? 'http://localhost:3333').replace(/\/$/, '');
    const redirectUrl = `${serverUrl}/api/v1/payments/3ds-callback?orderId=${orderId}`;

    this.logger.log(`[SANDBOX] 3DS pending simulated for order ${orderId}`);
    return { redirectUrl, orderId };
  }

  async sandboxSimulateDebit3dsPaid(orderId: string): Promise<{ confirmed: boolean; orderId: string }> {
    if (this.cieloService.sandboxMode === false) {
      throw new BadRequestException('Only available in sandbox mode');
    }

    const payment = await this.prisma.getReadClient().payment.findFirst({
      where: { orderId, method: 'DEBIT_CARD' },
      select: { id: true, orderId: true, status: true, metadata: true },
    });
    if (!payment) throw new NotFoundException(`No DEBIT_CARD payment found for order ${orderId}`);
    if (payment.status === PaymentStatus.PAID) {
      this.gateway.emitPaymentConfirmed(orderId);
      return { confirmed: true, orderId };
    }

    let confirmedOrderId: string | null = null;

    await this.prisma.getWriteClient().$transaction(async (tx: any) => {
      const updated = await tx.payment.updateMany({
        where: { id: payment.id, status: { not: PaymentStatus.PAID } },
        data: {
          status: PaymentStatus.PAID,
          paymentDate: new Date(),
          metadata: {
            ...(payment.metadata as object),
            sandboxConfirmedAt: new Date().toISOString(),
            sandboxSimulated: true,
          } as any,
        },
      });
      if (updated.count === 0) { confirmedOrderId = orderId; return; }

      await tx.$queryRaw`
        UPDATE "Order"
        SET "status" = 'PAID'::"OrderStatus", "updatedAt" = NOW()
        WHERE id = ${orderId}::uuid AND "status" = 'PENDING'::"OrderStatus"
      `;

      await tx.registration.updateMany({
        where: { orderId, status: 'PENDING' },
        data: { status: 'CONFIRMED' },
      });

      confirmedOrderId = orderId;
    });

    if (confirmedOrderId) {
      this.gateway.emitPaymentConfirmed(confirmedOrderId);
      this.sendConfirmationEmailForOrder(confirmedOrderId)
        .catch((err: any) => this.logger.warn(`[SANDBOX] 3DS email failed: ${err?.message}`));
      this.logger.log(`[SANDBOX] Debit 3DS confirmed for order ${orderId}`);
    }

    return { confirmed: true, orderId };
  }

  /**
   * Envia email de confirmação de inscrição com PDF do ingresso para um pedido já confirmado.
   * Utilizado por pollPixStatus, sandboxSimulatePixPaid e outros fluxos de confirmação.
   */
  async sendConfirmationEmailForOrder(orderId: string): Promise<void> {
    const order = await this.prisma.getReadClient().order.findUnique({
      where: { id: orderId },
      include: {
        event: { include: { organization: true } },
        payment: true,
        coupon: true,
        voucher: true,
        registrations: {
          include: {
            user: true,
            tickets: { include: { ticket: { include: { category: true } } } },
            products: { include: { product: true, variation: true } },
            questionAnswers: { include: { question: true } },
          },
        },
      },
    });

    if (!order) return;
    const event = order.event;
    const org = event?.organization as { tradeName?: string | null; name?: string | null } | null;
    const orgName: string = org?.tradeName || org?.name || '';
    const regs: any[] = order.registrations ?? [];
    if (!regs.length) return;

    const issuedAt = new Date();
    const orderNumber = orderId.slice(0, 8).toUpperCase();

    // ID do comprador para distinguir inscrição própria de inscrição de convidado
    const buyerUserId = regs.find((r: any) => r.user?.email)?.user?.id as string | undefined;

    const ticketPdfData = {
      orderId,
      orderNumber,
      issuedAt,
      event: {
        name: event?.name ?? '',
        date: event?.eventDate ?? new Date(),
        organization: orgName,
        location: formatEventAddress(event),
        participantCount: regs.length,
      },
      registrations: regs.map((reg: any, idx: number) => {
        // Usa reg.user como fallback para todas as inscrições:
        // - Inscrição do comprador: reg.participantEmail é null → usa user.email etc.
        // - Guest com participantEmail próprio: usa o dele (prioridade sobre user.*)
        // - Guest sem participantEmail: cai no user do comprador como contato de referência
        const user = reg.user ?? {};
        const ticket = reg.tickets?.[0]?.ticket;
        const catName = ticket?.category?.name ?? '';
        const ticketName = ticket?.name ?? '';
        const fullTicketName = catName && ticketName && catName !== ticketName
          ? `${catName} - ${ticketName}` : ticketName || catName;
        return {
          index: idx + 1,
          qrCode: reg.qrCode ?? reg.id,
          participantName: (reg.participantName ?? `${(reg.user ?? {}).firstName ?? ''} ${(reg.user ?? {}).lastName ?? ''}`.trim()) || 'Participante',
          ticketName: fullTicketName,
          email: reg.participantEmail ?? user.email,
          cpf: reg.participantCpf ?? user.documentNumber,
          dateOfBirth: reg.participantDateOfBirth ?? user.dateOfBirth,
          phone: reg.participantPhone ?? user.phone,
          gender: reg.participantGender ?? user.gender,
          questionAnswers: (reg.questionAnswers ?? []).map((qa: any) => ({
            question: qa.question?.question ?? '',
            answer: qa.answer ?? '',
          })),
          products: (reg.products ?? []).map((rp: any) => ({
            name: rp.product?.name ?? rp.productSnapshot?.name ?? '',
            price: rp.unitPrice ?? 0,
            variationName: rp.variation?.name ?? rp.productSnapshot?.variationName,
            imageUrl: rp.product?.images?.[rp.product?.primaryImageIndex ?? 0],
            isIncluded: rp.product?.isIncludedInTicket ?? false,
          })),
        };
      }),
    };

    const eventName = event?.name ?? '';
    const eventLocation = event?.location ?? '';
    const eventDate = formatEventDate(event?.eventDate);
    const eventAddress = formatEventAddress(event);
    const eventBannerUrl = event?.logoUrl ?? event?.bannerUrl ?? 'https://placehold.co/308x232';

    // Comprador = primeira inscrição com conta vinculada
    const buyerUser = regs.find((r: any) => r.user?.email)?.user;
    const buyerEmail: string | undefined = buyerUser?.email;

    // Gerar PDF individual por participante (sequencial — yoga-layout não suporta render paralelo)
    const individualPdfs: Array<{ pdf: Buffer | undefined; participantEmail: string | undefined; participantName: string }> = [];
    for (const [idx, reg] of regs.entries()) {
      const participantEmail: string | undefined = reg.participantEmail ?? reg.user?.email;
      const participantName: string = (reg.participantName
        ?? `${reg.user?.firstName ?? ''} ${reg.user?.lastName ?? ''}`.trim())
        || 'Participante';
      const regEntry = ticketPdfData.registrations[idx];
      if (!regEntry) { individualPdfs.push({ pdf: undefined, participantEmail, participantName }); continue; }
      const singlePdfData = {
        ...ticketPdfData,
        event: { ...ticketPdfData.event, participantCount: 1 },
        registrations: [{ ...regEntry, index: 1 }],
      };
      const pdf = await this.ticketPdfService.generateTicketPdf(singlePdfData)
        .catch((e: any) => { this.logger.warn(`PDF individual falhou para ${participantName}:`, e?.message); return undefined; });
      individualPdfs.push({ pdf, participantEmail, participantName });
    }

    // Envios SMTP em paralelo
    const emailPromises: Promise<unknown>[] = [];

    // Comprador recebe todos os PDFs individuais como anexos separados
    if (buyerEmail) {
      const buyerPdfs = individualPdfs
        .filter(p => p.pdf)
        .map(p => ({ buffer: p.pdf as Buffer, participantName: p.participantName }));
      emailPromises.push(
        this.emailService.sendRegistrationConfirmed({
          email: buyerEmail,
          firstName: buyerUser?.firstName || 'Participante',
          eventName, eventLocation, eventDate, eventAddress, eventBannerUrl,
          ticketPdfs: buyerPdfs,
        }).catch((err: any) => this.logger.warn('Email comprador falhou:', err)),
      );
    }

    // Participantes não-compradores recebem apenas seu próprio ingresso
    for (const p of individualPdfs) {
      if (!p.participantEmail || p.participantEmail === buyerEmail) continue;
      emailPromises.push(
        this.emailService.sendRegistrationConfirmed({
          email: p.participantEmail,
          firstName: p.participantName.split(' ')[0] || 'Participante',
          eventName, eventLocation, eventDate, eventAddress, eventBannerUrl,
          ticketPdfs: p.pdf ? [{ buffer: p.pdf, participantName: p.participantName }] : [],
        }).catch((err: any) => this.logger.warn(`Email participante ${p.participantEmail} falhou:`, err)),
      );
    }

    await Promise.allSettled(emailPromises);
  }
}
