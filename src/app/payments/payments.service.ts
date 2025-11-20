import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePaymentDto, ProcessPaymentDto, ConfirmPaymentDto } from './dto/create-payment.dto';
import { PaymentStatus, PaymentMethod } from '@prisma/client';
import { CieloService } from './cielo.service';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cieloService: CieloService,
  ) {}

  async create(userId: string, createPaymentDto: CreatePaymentDto) {
    const { registrationId, method, metadata } = createPaymentDto;

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se a inscrição existe e pertence ao usuário
    const registration = await prismaRead.registration.findUnique({
      where: { id: registrationId },
      include: {
        payment: true,
        event: true,
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

    if (registration.userId !== userId && registration.invitedById !== userId) {
      throw new BadRequestException('Access denied');
    }

    if (registration.status === 'CANCELLED') {
      throw new BadRequestException('Registration is cancelled');
    }

    if (registration.payment) {
      throw new BadRequestException('Payment already exists for this registration');
    }

    // Criar pagamento na Cielo
    const cieloResult = await this.cieloService.createPayment(
      registration.finalAmount,
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
        registrationId,
        userId,
        method,
        status: PaymentStatus.PENDING,
        amount: registration.finalAmount,
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
        registration: {
          include: {
            event: true,
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
        registration: true,
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.userId !== userId) {
      throw new BadRequestException('Access denied');
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

      // Atualizar status da inscrição
      await prisma.registration.update({
        where: { id: payment.registrationId },
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
        registration: true,
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.userId !== userId) {
      throw new BadRequestException('Access denied');
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

      // Atualizar status da inscrição se pago
      if (paymentStatus === PaymentStatus.PAID) {
        await prisma.registration.update({
          where: { id: payment.registrationId },
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
        registration: {
          include: {
            event: true,
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

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.userId !== userId) {
      throw new BadRequestException('Access denied');
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
        registration: {
          include: {
            event: {
              select: {
                id: true,
                name: true,
                eventDate: true,
              },
            },
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
        payment: true,
      },
    });

    if (!registration) {
      throw new NotFoundException('Registration not found');
    }

    return {
      message: 'Payment summary fetched successfully',
      data: {
        totalAmount: registration.totalAmount,
        serviceFee: registration.serviceFee,
        discount: registration.discount,
        finalAmount: registration.finalAmount,
        payment: registration.payment,
      },
    };
  }
}
