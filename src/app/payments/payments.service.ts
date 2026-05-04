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
      select: { id: true, orderId: true, status: true },
    });

    if (!payment) throw new NotFoundException(`Payment not found for transactionId: ${transactionId}`);
    if (payment.status === PaymentStatus.PAID) {
      this.gateway.emitPaymentConfirmed(payment.orderId);
      return { confirmed: true, orderId: payment.orderId };
    }

    await this.prisma.getWriteClient().$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.PAID,
          paymentDate: new Date(),
          metadata: { simulatedAt: new Date().toISOString(), simulatedViaScript: true } as any,
        },
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
    const org = event?.organization ?? {};
    const orgName: string = org.tradeName || org.name || '';
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
        // Usar dados do User vinculado apenas na inscrição do próprio comprador;
        // convidados têm reg.user = comprador → não usar user.* como fallback
        const isBuyerReg = buyerUserId && reg.user?.id === buyerUserId && !reg.participantName;
        const user = isBuyerReg ? (reg.user ?? {}) : {};
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

    const ticketPdf = await this.ticketPdfService.generateTicketPdf(ticketPdfData)
      .catch((e: any) => { this.logger.warn('Ticket PDF falhou:', e?.message); return undefined; });

    const eventName = event?.name ?? '';
    const eventLocation = event?.location ?? '';
    const eventDate = formatEventDate(event?.eventDate);
    const eventAddress = formatEventAddress(event);
    const eventBannerUrl = event?.logoUrl ?? event?.bannerUrl ?? 'https://placehold.co/308x232';

    // Comprador = primeira inscrição com conta vinculada — recebe todos os ingressos + recibo
    const buyerUser = regs.find((r: any) => r.user?.email)?.user;
    const buyerEmail: string | undefined = buyerUser?.email;

    if (buyerEmail) {
      await this.emailService.sendRegistrationConfirmed({
        email: buyerEmail,
        firstName: buyerUser?.firstName || 'Participante',
        eventName, eventLocation, eventDate, eventAddress, eventBannerUrl,
        ticketPdf: ticketPdf as Buffer | undefined,
      }).catch((err: any) => this.logger.warn('Email comprador falhou:', err));
    }

    // Participantes não-compradores — ingresso individual sem recibo, geração sequencial
    for (const [idx, reg] of regs.entries()) {
      const participantEmail: string | undefined = reg.participantEmail ?? reg.user?.email;
      if (!participantEmail || participantEmail === buyerEmail) continue;

      const participantName: string = (reg.participantName
        ?? `${reg.user?.firstName ?? ''} ${reg.user?.lastName ?? ''}`.trim())
        || 'Participante';
      const regEntry = ticketPdfData.registrations[idx];
      if (!regEntry) continue;

      const individualPdfData = {
        ...ticketPdfData,
        event: { ...ticketPdfData.event, participantCount: 1 },
        registrations: [{ ...regEntry, index: 1 }],
      };
      const individualTicketPdf = await this.ticketPdfService.generateTicketPdf(individualPdfData)
        .catch((e: any) => { this.logger.warn(`PDF individual falhou para ${participantEmail}:`, e?.message); return undefined; });

      await this.emailService.sendRegistrationConfirmed({
        email: participantEmail,
        firstName: participantName.split(' ')[0] || 'Participante',
        eventName, eventLocation, eventDate, eventAddress, eventBannerUrl,
        ticketPdf: individualTicketPdf as Buffer | undefined,
      }).catch((err: any) => this.logger.warn(`Email participante ${participantEmail} falhou:`, err));
    }
  }
}
