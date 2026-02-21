import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProcessCheckoutDto } from './dto/process-checkout.dto';
import { PaymentMethod, PaymentStatus, RegistrationStatus } from '@prisma/client';
import { CieloService } from '../payments/cielo.service';
import { RegistrationsService } from '../registrations/registrations.service';
import * as QRCode from 'qrcode';

interface PriceCalculation {
  ticketsSubtotal: number;
  productsSubtotal: number;
  serviceFee: number;
  couponDiscount: number;
  voucherDiscount: number;
  subtotal: number;
  total: number;
  pixDiscount?: number;
  finalTotal: number;
}

interface CouponValidationResult {
  isValid: boolean;
  discount: number;
  couponId?: string;
  error?: string;
}

interface VoucherValidationResult {
  isValid: boolean;
  discount: number;
  voucherId?: string;
  error?: string;
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cieloService: CieloService,
    private readonly registrationsService: RegistrationsService,
  ) {}

  async processCheckout(userId: string, dto: ProcessCheckoutDto) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    try {
      // 1. Validação inicial
      await this.validateInitialData(dto, prismaRead);

      // 2. Validar estoque
      await this.validateStock(dto, prismaRead);

      // 3. Calcular preços iniciais (sem descontos)
      const initialPrices = await this.calculatePrices(
        dto.eventId,
        dto.tickets,
        dto.participants,
        0, // sem cupom
        0, // sem voucher
        dto.paymentMethod,
        prismaRead,
      );

      // 4. Validar e aplicar cupom
      let couponResult: CouponValidationResult = {
        isValid: false,
        discount: 0,
      };
      if (dto.couponCode) {
        couponResult = await this.validateAndApplyCoupon(
          dto.couponCode,
          dto.eventId,
          dto.tickets,
          dto.participants,
          initialPrices.subtotal,
          userId,
          prismaRead,
        );

        if (!couponResult.isValid) {
          throw new BadRequestException(
            couponResult.error || 'Cupom inválido',
          );
        }
      }

      // 5. Validar e aplicar voucher
      let voucherResult: VoucherValidationResult = {
        isValid: false,
        discount: 0,
      };
      if (dto.voucherCode) {
        if (couponResult.isValid) {
          throw new BadRequestException(
            'Não é possível usar cupom e voucher ao mesmo tempo',
          );
        }

        voucherResult = await this.validateAndApplyVoucher(
          dto.voucherCode,
          dto.eventId,
          dto.tickets,
          dto.participants,
          initialPrices.ticketsSubtotal,
          userId,
          prismaRead,
        );

        if (!voucherResult.isValid) {
          throw new BadRequestException(
            voucherResult.error || 'Voucher inválido',
          );
        }
      }

      // 6. Recalcular preços com descontos
      const finalPrices = await this.calculatePrices(
        dto.eventId,
        dto.tickets,
        dto.participants,
        couponResult.discount,
        voucherResult.discount,
        dto.paymentMethod,
        prismaRead,
      );

      // 7. Processar pagamento
      const paymentResult = await this.processPayment(
        dto.paymentMethod,
        dto.payment,
        finalPrices.finalTotal,
        userId,
        dto.eventId,
      );

      // 8. Criar registrations e participantes
      const registrations = await this.createRegistrations(
        userId,
        dto,
        finalPrices,
        couponResult,
        voucherResult,
        paymentResult,
        prismaWrite,
      );

      // 9. Retornar resposta
      return {
        success: true,
        registrations: registrations.map((r) => ({
          id: r.id,
          status: r.status,
        })),
        payment: {
          method: dto.paymentMethod,
          status: paymentResult.status,
          transactionId: paymentResult.transactionId,
          pix: paymentResult.pix,
          boleto: paymentResult.boleto,
          creditCard: paymentResult.creditCard,
        },
        total: finalPrices.finalTotal,
      };
    } catch (error) {
      this.logger.error('Checkout processing error:', error);
      throw error;
    }
  }

  private async validateInitialData(
    dto: ProcessCheckoutDto,
    prisma: any,
  ): Promise<void> {
    // 1.1 Validar evento existe e está ativo
    const event = await prisma.event.findUnique({
      where: { id: dto.eventId },
    });

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    if (event.status !== 'PUBLISHED') {
      throw new BadRequestException('Evento não está disponível para compra');
    }

    if (new Date() > new Date(event.registrationEndDate)) {
      throw new BadRequestException('Período de inscrição encerrado');
    }

    // 1.2 Validar que há tickets selecionados
    if (!dto.tickets || dto.tickets.length === 0) {
      throw new BadRequestException('Nenhum ingresso selecionado');
    }

    // 1.3 Validar quantidade de participantes corresponde aos tickets
    const totalTickets = dto.tickets.reduce(
      (sum, t) => sum + t.quantity,
      0,
    );
    if (dto.participants.length !== totalTickets) {
      throw new BadRequestException(
        'Quantidade de participantes não corresponde aos ingressos',
      );
    }

    // 1.4 Validar método de pagamento
    if (
      !['PIX', 'CREDIT_CARD', 'BOLETO', 'CRYPTO'].includes(dto.paymentMethod)
    ) {
      throw new BadRequestException('Método de pagamento inválido');
    }
  }

  private async validateStock(
    dto: ProcessCheckoutDto,
    prisma: any,
  ): Promise<void> {
    // Validar estoque de tickets (batches)
    for (const ticketItem of dto.tickets) {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketItem.ticketId },
        include: { batches: true },
      });

      if (!ticket || !ticket.isActive) {
        throw new NotFoundException(
          `Ingresso ${ticketItem.ticketId} não encontrado ou inativo`,
        );
      }

      // Buscar lote ativo ou especificado
      const now = new Date();
      let batch = ticketItem.batchId
        ? ticket.batches.find((b) => b.id === ticketItem.batchId)
        : ticket.batches.find(
            (b) =>
              (!b.startDate || new Date(b.startDate) <= now) &&
              (!b.endDate || new Date(b.endDate) >= now),
          );

      if (!batch) {
        throw new BadRequestException(
          `Lote não encontrado ou inativo para ingresso ${ticket.name}`,
        );
      }

      // Verificar quantidade disponível
      // Nota: TicketBatch não tem campo de estoque vendido, então assumimos que quantity é o limite
      // Você pode adicionar um campo sold ou available no futuro
      if (batch.quantity < ticketItem.quantity) {
        throw new BadRequestException(
          `Estoque insuficiente para ${ticket.name}. Disponível: ${batch.quantity}`,
        );
      }
    }

    // Validar estoque de produtos
    for (const participant of dto.participants) {
      if (participant.products) {
        for (const productItem of participant.products) {
          const product = await prisma.product.findUnique({
            where: { id: productItem.productId },
            include: { variations: true },
          });

          if (!product) {
            throw new NotFoundException(
              `Produto ${productItem.productId} não encontrado`,
            );
          }

          if (productItem.variationId) {
            const variation = product.variations.find(
              (v) => v.id === productItem.variationId,
            );
            if (!variation) {
              throw new NotFoundException(
                `Variação ${productItem.variationId} não encontrada`,
              );
            }

            if (variation.stock > 0 && variation.stock < productItem.quantity) {
              throw new BadRequestException(
                `Estoque insuficiente para ${product.name} - ${variation.name}. Disponível: ${variation.stock}`,
              );
            }
          }
        }
      }
    }
  }

  private async calculatePrices(
    eventId: string,
    tickets: ProcessCheckoutDto['tickets'],
    participants: ProcessCheckoutDto['participants'],
    couponDiscount: number,
    voucherDiscount: number,
    paymentMethod: PaymentMethod,
    prisma: any,
  ): Promise<PriceCalculation> {
    // 1. Calcular subtotal dos tickets
    let ticketsSubtotal = 0;
    const now = new Date();

    for (const ticketItem of tickets) {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketItem.ticketId },
        include: { batches: true },
      });

      if (!ticket) {
        throw new NotFoundException(
          `Ingresso ${ticketItem.ticketId} não encontrado`,
        );
      }

      // Buscar preço do lote atual
      const batch = ticketItem.batchId
        ? ticket.batches.find((b) => b.id === ticketItem.batchId)
        : ticket.batches.find(
            (b) =>
              (!b.startDate || new Date(b.startDate) <= now) &&
              (!b.endDate || new Date(b.endDate) >= now),
          );

      if (!batch) {
        throw new BadRequestException(
          `Lote não encontrado para ingresso ${ticket.name}`,
        );
      }

      ticketsSubtotal += batch.price * ticketItem.quantity;
    }

    // 2. Calcular subtotal dos produtos
    let productsSubtotal = 0;
    for (const participant of participants) {
      if (participant.products) {
        for (const productItem of participant.products) {
          const product = await prisma.product.findUnique({
            where: { id: productItem.productId },
            include: { variations: true },
          });

          if (!product) {
            throw new NotFoundException(
              `Produto ${productItem.productId} não encontrado`,
            );
          }

          let productPrice = product.basePrice;
          if (productItem.variationId) {
            const variation = product.variations.find(
              (v) => v.id === productItem.variationId,
            );
            if (variation) {
              productPrice = variation.price;
            }
          }

          productsSubtotal += productPrice * productItem.quantity;
        }
      }
    }

    // 3. Calcular taxa de serviço (5% padrão)
    // Nota: Você pode adicionar campo serviceFee no Event no futuro
    const serviceFeePercent = 0.05; // 5% padrão
    const serviceFee = (ticketsSubtotal + productsSubtotal) * serviceFeePercent;

    // 4. Calcular subtotal
    const subtotal = ticketsSubtotal + productsSubtotal + serviceFee;

    // 5. Aplicar descontos
    const total = Math.max(0, subtotal - couponDiscount - voucherDiscount);

    // 6. Aplicar desconto PIX (5%)
    let pixDiscount = 0;
    let finalTotal = total;
    if (paymentMethod === PaymentMethod.PIX) {
      pixDiscount = total * 0.05;
      finalTotal = total - pixDiscount;
    }

    return {
      ticketsSubtotal: Math.round(ticketsSubtotal * 100) / 100,
      productsSubtotal: Math.round(productsSubtotal * 100) / 100,
      serviceFee: Math.round(serviceFee * 100) / 100,
      couponDiscount: Math.round(couponDiscount * 100) / 100,
      voucherDiscount: Math.round(voucherDiscount * 100) / 100,
      subtotal: Math.round(subtotal * 100) / 100,
      total: Math.round(total * 100) / 100,
      pixDiscount: Math.round(pixDiscount * 100) / 100,
      finalTotal: Math.round(finalTotal * 100) / 100,
    };
  }

  private async validateAndApplyCoupon(
    couponCode: string,
    eventId: string,
    tickets: ProcessCheckoutDto['tickets'],
    participants: ProcessCheckoutDto['participants'],
    subtotal: number,
    userId: string,
    prisma: any,
  ): Promise<CouponValidationResult> {
    if (!couponCode) {
      return { isValid: false, discount: 0 };
    }

    // Buscar cupom
    const coupon = await prisma.coupon.findUnique({
      where: {
        eventId_code: {
          eventId,
          code: couponCode.toUpperCase().trim(),
        },
      },
    });

    if (!coupon) {
      return {
        isValid: false,
        discount: 0,
        error: 'Cupom não encontrado',
      };
    }

    if (coupon.status !== 'ACTIVE') {
      return {
        isValid: false,
        discount: 0,
        error: 'Cupom não está ativo',
      };
    }

    // Validar expiração
    if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
      return {
        isValid: false,
        discount: 0,
        error: 'Cupom expirado',
      };
    }

    // Validar valor mínimo do carrinho
    if (coupon.minCartValue && subtotal < coupon.minCartValue) {
      return {
        isValid: false,
        discount: 0,
        error: `Valor mínimo do carrinho: R$ ${coupon.minCartValue.toFixed(2)}`,
      };
    }

    // Validar aplicabilidade aos tickets
    if (coupon.appliesTo && coupon.appliesTo !== 'all') {
      let appliesToValue: string | string[] | null = null;
      try {
        const parsed = JSON.parse(coupon.appliesTo);
        appliesToValue = Array.isArray(parsed) ? parsed : coupon.appliesTo;
      } catch {
        appliesToValue = coupon.appliesTo;
      }

      const ticketIds = tickets.map((t) => t.ticketId);
      const appliesToArray = Array.isArray(appliesToValue)
        ? appliesToValue
        : [appliesToValue];
      const validTickets = appliesToArray.filter((id) =>
        ticketIds.includes(id),
      );
      if (validTickets.length === 0) {
        return {
          isValid: false,
          discount: 0,
          error: 'Cupom não aplicável aos ingressos selecionados',
        };
      }
    }

    // Validar regras específicas por tipo
    if (coupon.couponType === 'QUANTITY') {
      const totalQuantity = tickets.reduce(
        (sum, t) => sum + t.quantity,
        0,
      );
      if (coupon.minQuantity && totalQuantity < coupon.minQuantity) {
        return {
          isValid: false,
          discount: 0,
          error: `Quantidade mínima de ingressos: ${coupon.minQuantity}`,
        };
      }
    }

    if (coupon.couponType === 'AGE') {
      // Validar idade dos participantes
      const validAges = participants.every((p) => {
        const age = this.calculateAge(p.birthDate);
        if (coupon.ageRule === 'MIN' && age < parseInt(coupon.ageValue || '0')) {
          return false;
        }
        if (coupon.ageRule === 'MAX' && age > parseInt(coupon.ageValue || '999')) {
          return false;
        }
        return true;
      });
      if (!validAges) {
        return {
          isValid: false,
          discount: 0,
          error: 'Cupom não aplicável à idade dos participantes',
        };
      }
    }

    // Validar CPF list
    if (coupon.cpfListStatus === 'ENABLED' && coupon.cpfList) {
      const participantCpfs = participants.map((p) =>
        p.cpf.replace(/\D/g, ''),
      );
      const cpfList = coupon.cpfList as string[];
      const hasValidCpf = participantCpfs.some((cpf) => cpfList.includes(cpf));
      if (!hasValidCpf) {
        return {
          isValid: false,
          discount: 0,
          error: 'Cupom não aplicável ao CPF informado',
        };
      }
    }

    // Calcular desconto
    let discount = 0;
    if (coupon.type === 'PERCENTAGE') {
      discount = subtotal * (coupon.value / 100);
    } else if (coupon.type === 'FIXED') {
      discount = Math.min(coupon.value, subtotal);
    }

    return {
      isValid: true,
      discount: Math.round(discount * 100) / 100,
      couponId: coupon.id,
    };
  }

  private async validateAndApplyVoucher(
    voucherCode: string,
    eventId: string,
    tickets: ProcessCheckoutDto['tickets'],
    participants: ProcessCheckoutDto['participants'],
    ticketsSubtotal: number,
    userId: string,
    prisma: any,
  ): Promise<VoucherValidationResult> {
    if (!voucherCode) {
      return { isValid: false, discount: 0 };
    }

    // Buscar voucher
    const voucher = await prisma.voucher.findUnique({
      where: { code: voucherCode.toUpperCase().trim() },
    });

    if (!voucher) {
      return {
        isValid: false,
        discount: 0,
        error: 'Voucher não encontrado',
      };
    }

    if (voucher.eventId !== eventId) {
      return {
        isValid: false,
        discount: 0,
        error: 'Voucher não é válido para este evento',
      };
    }

    if (voucher.status !== 'ACTIVE') {
      return {
        isValid: false,
        discount: 0,
        error: 'Voucher não está ativo ou já foi utilizado',
      };
    }

    // Validar expiração
    if (voucher.expiryDate && new Date(voucher.expiryDate) < new Date()) {
      return {
        isValid: false,
        discount: 0,
        error: 'Voucher expirado',
      };
    }

    // Validar aplicabilidade aos tickets
    if (voucher.appliesTo && voucher.appliesTo !== 'all') {
      let appliesToValue: string | string[] | null = null;
      try {
        const parsed = JSON.parse(voucher.appliesTo);
        appliesToValue = Array.isArray(parsed) ? parsed : voucher.appliesTo;
      } catch {
        appliesToValue = voucher.appliesTo;
      }

      const ticketIds = tickets.map((t) => t.ticketId);
      const appliesToArray = Array.isArray(appliesToValue)
        ? appliesToValue
        : [appliesToValue];
      const validTickets = appliesToArray.filter((id) =>
        ticketIds.includes(id),
      );
      if (validTickets.length === 0) {
        return {
          isValid: false,
          discount: 0,
          error: 'Voucher não aplicável aos ingressos selecionados',
        };
      }
    }

    // Validar CPF list
    if (voucher.cpfListStatus === 'ENABLED' && voucher.cpfList) {
      const participantCpfs = participants.map((p) =>
        p.cpf.replace(/\D/g, ''),
      );
      const cpfList = voucher.cpfList as string[];
      const hasValidCpf = participantCpfs.some((cpf) => cpfList.includes(cpf));
      if (!hasValidCpf) {
        return {
          isValid: false,
          discount: 0,
          error: 'Voucher não aplicável ao CPF informado',
        };
      }
    }

    // Voucher aplica desconto de 100% em um ingresso (mais barato)
    // Por enquanto, aplicamos 100% no subtotal de tickets
    const discount = ticketsSubtotal;

    return {
      isValid: true,
      discount: Math.round(discount * 100) / 100,
      voucherId: voucher.id,
    };
  }

  private async processPayment(
    paymentMethod: PaymentMethod,
    paymentData: ProcessCheckoutDto['payment'],
    finalTotal: number,
    userId: string,
    eventId: string,
  ) {
    // Converter PaymentMethod para o formato esperado pelo CieloService
    let cieloMethod: any;
    switch (paymentMethod) {
      case PaymentMethod.CREDIT_CARD:
        cieloMethod = 'CREDIT_CARD';
        break;
      case PaymentMethod.PIX:
        cieloMethod = 'PIX';
        break;
      case PaymentMethod.BOLETO:
        cieloMethod = 'BOLETO';
        break;
      default:
        throw new BadRequestException('Método de pagamento não suportado');
    }

    // Criar merchantOrderId único
    const merchantOrderId = `checkout-${Date.now()}-${userId}`;

    // Buscar dados do usuário
    const user = await this.prisma.getReadClient().user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true },
    });

    // Processar pagamento na Cielo
    const cieloResult = await this.cieloService.createPayment(
      finalTotal,
      'BRL',
      cieloMethod,
      merchantOrderId,
      {
        name: `${user?.firstName} ${user?.lastName}`,
        email: user?.email,
      },
    );

    if (!cieloResult.success) {
      throw new BadRequestException(
        cieloResult.error || 'Falha ao processar pagamento',
      );
    }

    return {
      success: true,
      transactionId: cieloResult.paymentId,
      status: cieloResult.cieloStatus === 'Approved' ? 'approved' : 'pending',
      pix: cieloResult.qrCode
        ? {
            qrCode: cieloResult.qrCode,
            qrCodeBase64: cieloResult.qrCode,
            expirationDate: cieloResult.expiresAt || new Date(),
          }
        : undefined,
      boleto: cieloResult.barcode
        ? {
            barcode: cieloResult.barcode,
            digitableLine: cieloResult.barcode,
            expirationDate: cieloResult.expiresAt || new Date(),
          }
        : undefined,
      creditCard: paymentData.card
        ? {
            installments: paymentData.card.installments,
            installmentValue: finalTotal / paymentData.card.installments,
          }
        : undefined,
    };
  }

  private async createRegistrations(
    userId: string,
    dto: ProcessCheckoutDto,
    prices: PriceCalculation,
    couponResult: CouponValidationResult,
    voucherResult: VoucherValidationResult,
    paymentResult: any,
    prisma: any,
  ) {
    const registrations = [];

    // Criar uma registration por participante ou uma geral?
    // Vou criar uma registration geral com múltiplos tickets
    // Você pode ajustar isso conforme sua lógica de negócio

    // Criar registration principal
    const registration = await prisma.registration.create({
      data: {
        eventId: dto.eventId,
        userId,
        status:
          paymentResult.status === 'approved'
            ? RegistrationStatus.CONFIRMED
            : RegistrationStatus.PENDING,
        termsAccepted: true, // Assumindo que foi aceito no checkout
        rulesAccepted: true,
        totalAmount: prices.ticketsSubtotal + prices.productsSubtotal,
        serviceFee: prices.serviceFee,
        discount: prices.couponDiscount + prices.voucherDiscount,
        finalAmount: prices.finalTotal,
        couponId: couponResult.couponId || null,
        voucherId: voucherResult.voucherId || null,
      },
    });

    // Criar QR Code
    const qrCodeData = JSON.stringify({
      registrationId: registration.id,
      eventId: dto.eventId,
      userId,
    });
    const qrCode = await QRCode.toDataURL(qrCodeData);
    await prisma.registration.update({
      where: { id: registration.id },
      data: { qrCode },
    });

    // Criar payment
    await prisma.payment.create({
      data: {
        registrationId: registration.id,
        userId,
        method: dto.paymentMethod,
        status:
          paymentResult.status === 'approved'
            ? PaymentStatus.PAID
            : PaymentStatus.PENDING,
        amount: prices.finalTotal,
        transactionId: paymentResult.transactionId,
        metadata: {
          pix: paymentResult.pix,
          boleto: paymentResult.boleto,
          creditCard: paymentResult.creditCard,
        } as any,
      },
    });

    // Criar tickets e participantes
    let participantIndex = 0;
    for (const ticketItem of dto.tickets) {
      // Criar RegistrationTicket
      await prisma.registrationTicket.create({
        data: {
          registrationId: registration.id,
          ticketId: ticketItem.ticketId,
        },
      });

      // Criar participantes para este ticket
      for (let i = 0; i < ticketItem.quantity; i++) {
        const participantData = dto.participants[participantIndex];

        // Criar ou buscar usuário para o participante
        const currentUser = await prisma.user.findUnique({
          where: { id: userId },
          select: { email: true },
        });

        let participantUserId = userId;
        if (participantData.email !== currentUser?.email) {
          // Verificar se usuário já existe
          let invitedUser = await prisma.user.findUnique({
            where: { email: participantData.email },
          });

          if (!invitedUser) {
            // Criar usuário convidado
            invitedUser = await prisma.user.create({
              data: {
                email: participantData.email,
                firstName: participantData.name.split(' ')[0],
                lastName:
                  participantData.name.split(' ').slice(1).join(' ') || '',
                documentNumber: participantData.cpf.replace(/\D/g, ''),
                password: '', // Senha será definida depois
                isActive: false,
              },
            });
          }
          participantUserId = invitedUser.id;
        }

        // Criar question answers se houver
        if (participantData.questionAnswers) {
          for (const answer of participantData.questionAnswers) {
            await prisma.questionAnswer.create({
              data: {
                registrationId: registration.id,
                questionId: answer.questionId,
                answer: String(answer.answer),
              },
            });
          }
        }

        participantIndex++;
      }
    }

    // Atualizar uso de cupom
    if (couponResult.couponId) {
      await prisma.coupon.update({
        where: { id: couponResult.couponId },
        data: {
          usageCount: { increment: 1 },
        },
      });
    }

    // Marcar voucher como usado
    if (voucherResult.voucherId) {
      await prisma.voucher.update({
        where: { id: voucherResult.voucherId },
        data: {
          status: 'USED',
          usedAt: new Date(),
          usedBy: userId,
        },
      });
    }

    registrations.push(registration);
    return registrations;
  }

  private calculateAge(birthDate: string): number {
    const birth = new Date(birthDate);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (
      monthDiff < 0 ||
      (monthDiff === 0 && today.getDate() < birth.getDate())
    ) {
      age--;
    }
    return age;
  }
}
