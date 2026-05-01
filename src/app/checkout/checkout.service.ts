import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProcessCheckoutDto } from './dto/process-checkout.dto';
import { normalizeBillingPostalCodeForStorage } from './dto/checkout-billing-address.dto';
import { PaymentMethod, PaymentStatus, Prisma, RegistrationStatus } from '@prisma/client';
import { CieloService } from '../payments/cielo.service';
import { RegistrationsService } from '../registrations/registrations.service';
// QR Code é gerado dinamicamente no frontend/backend usando o payload salvo em qrCode

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
  effectiveUsage?: number;
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

  // Circuit breaker para a Cielo
  private cieloFailures = 0;
  private cieloCircuitOpenUntil = 0;
  private readonly CIELO_CIRCUIT_THRESHOLD = 5;
  private readonly CIELO_CIRCUIT_RESET_MS = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cieloService: CieloService,
    private readonly registrationsService: RegistrationsService,
  ) { }

  async processCheckout(userId: string, dto: ProcessCheckoutDto) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    try {
      // 1. Buscar informações do evento para o retorno
      const event = await prismaRead.event.findUnique({
        where: { id: dto.eventId },
        select: { name: true },
      });

      if (!event) {
        throw new NotFoundException('Evento não encontrado');
      }

      // 2. Idempotência — se a chave já existir, retorna o pedido existente
      if (dto.idempotencyKey) {
        const existing = await prismaRead.order.findFirst({
          where: { idempotencyKey: dto.idempotencyKey } as any,
          select: { id: true },
        });
        if (existing) {
          this.logger.warn(`Idempotent checkout: order already exists for key ${dto.idempotencyKey}`);
          throw new BadRequestException('Pedido já processado com esta chave de idempotência.');
        }
      }

      // 3. Validação inicial
      await this.validateInitialData(dto, prismaRead);

      // 3. Validar estoque
      await this.validateStock(dto, prismaRead);

      // 4. Calcular preços iniciais (sem descontos)
      // serviceFee sempre 0 — nunca confiamos no valor enviado pelo cliente
      const initialPrices = await this.calculatePrices(
        dto.eventId,
        dto.tickets,
        dto.participants,
        0, // sem cupom
        0, // sem voucher
        dto.paymentMethod,
        prismaRead,
        0, // serviceFee calculado server-side
      );

      // 5. Validar e aplicar cupom
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
          prismaWrite,
        );

        if (!couponResult.isValid) {
          throw new BadRequestException(
            couponResult.error || 'Cupom inválido',
          );
        }
      }

      // 5b. Auto-aplicar cupons QUANTITY/AGE (sem código) se nenhum cupom/voucher manual foi usado
      if (!couponResult.isValid && !dto.voucherCode) {
        couponResult = await this.applyAutomaticCoupon(
          dto.eventId,
          dto.tickets,
          dto.participants,
          initialPrices.subtotal,
          prismaWrite,
        );
      }

      // 6. Validar e aplicar voucher
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

      // 7. Calcular preços finais aritmeticamente (sem nova ida ao banco)
      const preDiscountTotal =
        initialPrices.ticketsSubtotal +
        initialPrices.productsSubtotal +
        initialPrices.serviceFee;
      const discountedTotal = Math.max(
        0,
        preDiscountTotal - couponResult.discount - voucherResult.discount,
      );
      const finalPrices: PriceCalculation = {
        ...initialPrices,
        couponDiscount: couponResult.discount,
        voucherDiscount: voucherResult.discount,
        subtotal: preDiscountTotal,
        total: discountedTotal,
        pixDiscount: 0,
        finalTotal: discountedTotal,
      };

      // 8. Processar pagamento
      // Obter CPF do primeiro participante para enviar à Cielo (limpar caracteres não numéricos)
      const firstParticipantCpf = dto.participants && dto.participants.length > 0
        ? dto.participants[0].cpf?.replace(/\D/g, '')
        : undefined;

      let paymentResult: any;
      let paymentError: any = null;

      try {
        paymentResult = await this.processPayment(
          dto.paymentMethod,
          dto.payment,
          finalPrices.finalTotal,
          userId,
          dto.eventId,
          firstParticipantCpf,
        );
      } catch (error) {
        // Se o pagamento falhar, ainda criar o pedido e as inscrições para aparecer no dashboard
        paymentError = error;
        this.logger.warn('Payment failed, but will create order and registrations:', {
          error: error.message,
          paymentMethod: dto.paymentMethod,
        });

        // Criar um paymentResult com status de falha
        // SEGURANÇA: nunca incluir número completo, CVV ou dados brutos do cartão
        paymentResult = {
          success: false,
          status: 'failed',
          transactionId: null,
          error: error.message,
          cieloResult: null,
          // Apenas dados mascarados — sem PAN, sem CVV
          cardData: dto.paymentMethod === PaymentMethod.CREDIT_CARD ? {
            number: dto.payment?.card?.number
              ? '*'.repeat(dto.payment.card.number.replace(/\D/g, '').length - 4) +
                dto.payment.card.number.replace(/\D/g, '').slice(-4)
              : null,
            holder: dto.payment?.card?.name?.toUpperCase() ?? null,
            expiry: null,   // nunca expor data de validade
            cvv: null,      // nunca expor CVV
            installments: dto.payment?.card?.installments ?? null,
          } : undefined,
        };
      }

      // 9. Criar registrations e participantes (mesmo se o pagamento falhou)
      // withSerializableRetry lida com P2034 (serialization failure) com backoff exponencial
      const { registrations, order } = await this.withSerializableRetry(() =>
        this.createRegistrations(
          userId,
          dto,
          finalPrices,
          couponResult,
          voucherResult,
          paymentResult,
          prismaWrite,
        ),
      );

      // Se o pagamento falhou, lançar a exceção DEPOIS de criar os registros
      if (paymentError) {
        throw paymentError;
      }

      // 10. Buscar informações detalhadas dos tickets, participantes e produtos
      const registrationDetails = await this.getRegistrationDetails(
        registrations[0]?.id,
        dto,
        prismaRead,
      );

      // 11. Gerar número do pedido (formato PT-YYYY-XXXX)
      const orderNumber = this.generateOrderNumber(registrations[0]?.id || userId);

      // 12. Contar participantes e produtos
      const participantsCount = dto.participants.length;
      const productsSubtotal = finalPrices.productsSubtotal || 0;

      // 13. Formatar forma de pagamento
      const paymentMethodLabel = this.getPaymentMethodLabel(dto.paymentMethod);

      // 14. Retornar resposta completa com extrato
      return {
        success: true,
        orderNumber, // Número do pedido (PT-2025-0348)
        eventName: event.name, // Nome do evento
        date: new Date().toLocaleDateString('pt-BR'), // Data do pagamento
        paymentMethod: paymentMethodLabel, // Forma de pagamento
        participants: participantsCount, // Número de participantes
        // Detalhes dos ingressos comprados
        tickets: registrationDetails.tickets,
        // Informações de todos os participantes (com respostas das perguntas e produtos)
        participantsDetails: registrationDetails.participants,
        // Informações dos produtos adicionais inclusos
        products: {
          items: registrationDetails.products,
          subtotal: finalPrices.productsSubtotal, // Produtos adicionais em centavos
        },
        // Itens dos kits selecionados
        kitItems: registrationDetails.kitItems || [],
        // Modalidades do evento selecionadas
        modalities: registrationDetails.modalities || [],
        // Respostas das perguntas do evento
        questionAnswers: registrationDetails.questionAnswers || [],
        pricing: {
          subtotal: finalPrices.ticketsSubtotal + finalPrices.productsSubtotal, // Subtotal em centavos (ambos já estão em centavos)
          serviceFee: finalPrices.serviceFee, // Taxa de serviço em centavos
          couponDiscount: couponResult.discount || 0, // Desconto cupom em centavos
          voucherDiscount: voucherResult.discount || 0, // Desconto voucher em centavos
          total: finalPrices.finalTotal, // Total pago em centavos
        },
        orderId: order.id, // ID do pedido
        registrations: registrations.map((r, index) => ({
          id: r.id,
          status: r.status,
          qrCode: r.qrCode, // QR Code do registration
          participant: {
            // Informações do participante correspondente
            id: registrationDetails.participants[index]?.id,
            name: registrationDetails.participants[index]?.name,
            email: registrationDetails.participants[index]?.email,
            includedProducts: registrationDetails.participants[index]?.includedProducts || [], // Produtos inclusos no ingresso
          },
        })),
        payment: {
          method: dto.paymentMethod,
          status: paymentResult.status,
          transactionId: paymentResult.transactionId,
          pix: paymentResult.pix,
          boleto: paymentResult.boleto,
          creditCard: paymentResult.creditCard,
        },
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

    await this.validateParticipantQuestions(dto, prisma);

    // 1.4 Validar método de pagamento
    if (
      !['PIX', 'CREDIT_CARD', 'BOLETO', 'CRYPTO'].includes(dto.paymentMethod)
    ) {
      throw new BadRequestException('Método de pagamento inválido');
    }
  }

  private async validateParticipantQuestions(
    dto: ProcessCheckoutDto,
    prisma: any,
  ): Promise<void> {
    const participantTicketIds = this.expandParticipantTicketIds(dto.tickets);
    const questions = await prisma.question.findMany({
      where: { eventId: dto.eventId, isRequired: true, isActive: true },
      select: { id: true, question: true, isRequired: true, appliesTo: true },
    });

    if (questions.length === 0) return;

    for (let participantIndex = 0; participantIndex < dto.participants.length; participantIndex++) {
      const participant = dto.participants[participantIndex];
      const ticketId = participantTicketIds[participantIndex];
      const answeredQuestionIds = new Set(
        (participant.questionAnswers || []).map((qa) => qa.questionId),
      );

      const missingQuestions = questions.filter((question) => {
        if (!question.isRequired) return false;
        if (!this.questionAppliesToTicket(question.appliesTo, ticketId)) return false;
        return !answeredQuestionIds.has(question.id);
      });

      if (missingQuestions.length > 0) {
        throw new BadRequestException(
          `Participante ${participantIndex + 1} sem resposta para perguntas obrigatorias: ${missingQuestions.map((q) => q.question).join(', ')}`,
        );
      }
    }
  }

  private expandParticipantTicketIds(
    tickets: ProcessCheckoutDto['tickets'],
  ): string[] {
    return tickets.flatMap((ticketItem) =>
      Array.from({ length: ticketItem.quantity }, () => ticketItem.ticketId),
    );
  }

  private questionAppliesToTicket(
    appliesTo: string | null,
    ticketId: string,
  ): boolean {
    if (!appliesTo || appliesTo === 'all') return true;

    try {
      const parsed = JSON.parse(appliesTo);
      if (Array.isArray(parsed)) {
        return parsed.includes(ticketId);
      }
      return appliesTo === ticketId;
    } catch {
      return appliesTo === ticketId;
    }
  }

  /**
   * Encontra o primeiro lote com vagas disponíveis para um ticket.
   * Percorre os lotes na ordem (startDate asc, createdAt asc) e retorna o
   * primeiro que ainda tenha capacidade restante (quantity - vendas não canceladas).
   * Se batchId for fornecido explicitamente, valida apenas aquele lote.
   */
  private async findAvailableBatch(
    prisma: any,
    ticketId: string,
    batchId: string | undefined,
    quantityNeeded: number,
  ) {
    const batches = await prisma.ticketBatch.findMany({
      where: { ticketId },
      orderBy: [
        { startDate: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    const batchIds = batches.map((b) => b.id);

    // Contar vendas por lote (inscrições não canceladas)
    const soldCounts: { batchId: string; _count: { id: number } }[] =
      batchIds.length > 0
        ? await prisma.registrationTicket.groupBy({
            by: ['batchId'],
            where: {
              batchId: { in: batchIds },
              registration: { status: { not: RegistrationStatus.CANCELLED } },
            },
            _count: { id: true },
          })
        : [];

    const soldMap = new Map(soldCounts.map((s) => [s.batchId, s._count.id]));

    if (batchId) {
      // Lote explicitamente informado — só valida capacidade dele
      const batch = batches.find((b) => b.id === batchId);
      if (!batch) return null;
      const sold = soldMap.get(batch.id) ?? 0;
      const remaining = batch.quantity - sold;
      return remaining >= quantityNeeded ? { batch, remaining } : null;
    }

    // Percorre em ordem e retorna o primeiro lote com vaga suficiente
    for (const batch of batches) {
      const sold = soldMap.get(batch.id) ?? 0;
      const remaining = batch.quantity - sold;
      if (remaining >= quantityNeeded) {
        return { batch, remaining };
      }
    }

    return null;
  }

  /**
   * Resolve o preço unitário de um produto para um participante:
   * - Produto incluso no ingresso → 0
   * - Variação "Sem interesse" → 0
   * - Variação selecionada → variation.price
   * - Sem variação → product.basePrice
   */
  private resolveProductPrice(
    product: { id: string; basePrice: number; variations: { id: string; name: string; price: number }[] },
    variationId: string | undefined | null,
    includedProductIds: Set<string>,
  ): number {
    if (includedProductIds.has(product.id)) return 0;

    if (variationId) {
      const variation = product.variations.find((v) => v.id === variationId);
      if (variation?.name === 'Sem interesse') return 0;
      if (variation) return variation.price;
    }

    return product.basePrice;
  }

  private async validateStock(
    dto: ProcessCheckoutDto,
    prisma: any,
  ): Promise<void> {
    // Validar estoque de tickets (batches)
    for (const ticketItem of dto.tickets) {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketItem.ticketId },
      });

      if (!ticket || !ticket.isActive) {
        throw new NotFoundException(
          `Ingresso ${ticketItem.ticketId} não encontrado ou inativo`,
        );
      }

      // Camada 5 — verifica availableQuantity diretamente (fonte de verdade do estoque)
      if (ticketItem.batchId) {
        const batch = await prisma.ticketBatch.findUnique({
          where: { id: ticketItem.batchId },
          select: { id: true, availableQuantity: true },
        });
        if (!batch || batch.availableQuantity < ticketItem.quantity) {
          throw new BadRequestException(
            `Sem vagas disponíveis para o ingresso "${ticket.name}". Lote esgotado.`,
          );
        }
      }

      const result = await this.findAvailableBatch(
        prisma,
        ticketItem.ticketId,
        ticketItem.batchId,
        ticketItem.quantity,
      );

      if (!result) {
        throw new BadRequestException(
          `Sem vagas disponíveis para o ingresso "${ticket.name}". Todos os lotes estão esgotados.`,
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
              throw new UnprocessableEntityException(
                `Variação selecionada não encontrada para "${product.name}". Selecione uma opção válida.`,
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
    serviceFee?: number,
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

      // batch.price já está em centavos
      ticketsSubtotal += batch.price * ticketItem.quantity;
    }

    // 2. Calcular subtotal dos produtos
    // Pré-carregar produtos inclusos nos ingressos desta compra
    const ticketIdsForPricing = tickets.map((t) => t.ticketId);
    const includedTicketProductRows = ticketIdsForPricing.length > 0
      ? await prisma.ticketProduct.findMany({
          where: { ticketId: { in: ticketIdsForPricing } },
          select: { productId: true },
        })
      : [];
    const includedProductIds = new Set<string>(
      includedTicketProductRows.map((tp: { productId: string }) => tp.productId),
    );

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

          const productPrice = this.resolveProductPrice(product, productItem.variationId, includedProductIds);
          productsSubtotal += productPrice * productItem.quantity;
        }
      }
    }

    // 3. Calcular taxa de serviço
    // serviceFee já está em centavos
    const calculatedServiceFee = serviceFee !== undefined && serviceFee !== null ? serviceFee : 0;

    // 4. Calcular subtotal (todos em centavos)
    const subtotal = ticketsSubtotal + productsSubtotal + calculatedServiceFee;

    // 5. Aplicar descontos (já estão em centavos)
    const total = Math.max(0, subtotal - couponDiscount - voucherDiscount);

    // 6. Aplicar desconto PIX (5%)
    const pixDiscount = 0;
    const finalTotal = total;

    // Todos os valores já estão em centavos
    return {
      ticketsSubtotal: ticketsSubtotal,
      productsSubtotal: productsSubtotal,
      serviceFee: calculatedServiceFee,
      couponDiscount: couponDiscount, // Já está em centavos
      voucherDiscount: voucherDiscount, // Já está em centavos
      subtotal: subtotal,
      total: total,
      pixDiscount: pixDiscount,
      finalTotal: finalTotal,
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

    if (!coupon || (coupon as any).deletedAt) {
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
      const validAges = participants.every((p) => {
        const age = this.calculateAge(p.birthDate);
        return this.checkAgeCondition(coupon, age);
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

    // Calcular desconto com aplicação parcial nos ingressos mais caros (uso restante)
    const ticketsWithPrices = await this.fetchTicketPricesForCoupon(tickets, prisma);
    const totalUnits = ticketsWithPrices.reduce((s, t) => s + t.quantity, 0);
    const remaining = coupon.maxUsage != null ? coupon.maxUsage - coupon.usageCount : totalUnits;
    const effectiveUsage = Math.min(Math.max(0, remaining), totalUnits);

    const discount = this.computePartialCouponDiscount(ticketsWithPrices, coupon.type, coupon.value, effectiveUsage);

    return {
      isValid: true,
      discount,
      couponId: coupon.id,
      effectiveUsage,
    };
  }

  private async applyAutomaticCoupon(
    eventId: string,
    tickets: ProcessCheckoutDto['tickets'],
    participants: ProcessCheckoutDto['participants'],
    subtotal: number,
    prisma: any,
  ): Promise<CouponValidationResult> {
    const totalQuantity = tickets.reduce((sum, t) => sum + t.quantity, 0);
    const ticketIds = tickets.map((t) => t.ticketId);
    const ticketsWithPrices = await this.fetchTicketPricesForCoupon(tickets, prisma);

    const autoCoupons = await prisma.coupon.findMany({
      where: {
        eventId,
        status: 'ACTIVE',
        deletedAt: null,
        couponType: { in: ['QUANTITY', 'AGE'] },
        OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
      },
    });

    for (const coupon of autoCoupons) {
      // Verificar appliesTo
      if (coupon.appliesTo && coupon.appliesTo !== 'all') {
        let allowed: string[] = [];
        try { allowed = JSON.parse(coupon.appliesTo); } catch { allowed = [coupon.appliesTo]; }
        if (!ticketIds.some((id) => allowed.includes(id))) continue;
      }

      // Verificar minCartValue
      if (coupon.minCartValue && subtotal < coupon.minCartValue) continue;

      if (coupon.couponType === 'QUANTITY') {
        if (coupon.minQuantity && totalQuantity < coupon.minQuantity) continue;
        // QUANTITY: all-or-nothing — se esgotado, não aplica
        if (coupon.maxUsage != null && coupon.usageCount >= coupon.maxUsage) continue;

        const discount =
          coupon.type === 'PERCENTAGE'
            ? subtotal * (coupon.value / 100)
            : Math.min(coupon.value, subtotal);
        return { isValid: true, discount, couponId: coupon.id, effectiveUsage: 1 };

      } else if (coupon.couponType === 'AGE') {
        const allMatch = participants.every((p) => {
          const age = this.calculateAge(p.birthDate);
          return this.checkAgeCondition(coupon, age);
        });
        if (!allMatch) continue;

        // AGE: aplica nos ingressos mais caros dentro do uso restante
        const remaining = coupon.maxUsage != null ? coupon.maxUsage - coupon.usageCount : totalQuantity;
        const effectiveUsage = Math.min(Math.max(0, remaining), totalQuantity);
        if (effectiveUsage <= 0) continue;
        const discount = this.computePartialCouponDiscount(ticketsWithPrices, coupon.type, coupon.value, effectiveUsage);
        return { isValid: true, discount, couponId: coupon.id, effectiveUsage };
      }
    }

    return { isValid: false, discount: 0 };
  }

  private async fetchTicketPricesForCoupon(
    tickets: ProcessCheckoutDto['tickets'],
    prisma: any,
  ): Promise<Array<{ ticketId: string; quantity: number; unitPrice: number }>> {
    const now = new Date();
    return Promise.all(
      tickets.map(async (t) => {
        const ticket = await prisma.ticket.findUnique({
          where: { id: t.ticketId },
          include: { batches: true },
        });
        const batch = (t as any).batchId
          ? ticket?.batches.find((b: any) => b.id === (t as any).batchId)
          : ticket?.batches.find(
              (b: any) =>
                (!b.startDate || new Date(b.startDate) <= now) &&
                (!b.endDate || new Date(b.endDate) >= now),
            );
        return { ticketId: t.ticketId, quantity: t.quantity, unitPrice: batch?.price ?? 0 };
      }),
    );
  }

  private computePartialCouponDiscount(
    ticketsWithPrices: Array<{ unitPrice: number; quantity: number }>,
    couponValueType: string,
    couponValue: number,
    effectiveUsage: number,
  ): number {
    if (effectiveUsage <= 0) return 0;
    const units = ticketsWithPrices
      .flatMap((t) => Array(t.quantity).fill(t.unitPrice))
      .sort((a, b) => b - a)
      .slice(0, effectiveUsage);
    if (couponValueType === 'PERCENTAGE') {
      const base = units.reduce((s, p) => s + p, 0);
      return Math.floor(base * (couponValue / 100));
    }
    return effectiveUsage * couponValue;
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
    // ticketsSubtotal já está em centavos (vem do calculatePrices)
    const discount = ticketsSubtotal;

    return {
      isValid: true,
      discount: discount, // Já está em centavos
      voucherId: voucher.id,
    };
  }

  private async processPayment(
    paymentMethod: PaymentMethod,
    paymentData: ProcessCheckoutDto['payment'],
    finalTotal: number,
    userId: string,
    eventId: string,
    customerCpf?: string,
  ) {
    // Validar método de pagamento suportado
    if (
      paymentMethod !== PaymentMethod.CREDIT_CARD &&
      paymentMethod !== PaymentMethod.PIX &&
      paymentMethod !== PaymentMethod.BOLETO
    ) {
      throw new BadRequestException('Método de pagamento não suportado');
    }

    // Cielo limit: 50 chars. "chk-" (4) + 8-char id slice (8) + "-" (1) + timestamp (13) = 26
    const merchantOrderId = `chk-${userId.replace(/-/g, '').slice(0, 8)}-${Date.now()}`;

    // Buscar dados do usuário
    const user = await this.prisma.getReadClient().user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true },
    });

    // Prepare card data for credit card payment (raw card or pre-tokenized)
    let cardData = undefined;
    let cardTokenData = undefined;
    if (paymentMethod === PaymentMethod.CREDIT_CARD) {
      if (paymentData.cardToken) {
        cardTokenData = {
          token: paymentData.cardToken.token,
          brand: paymentData.cardToken.brand,
          holder: paymentData.cardToken.holder,
          securityCode: paymentData.cardToken.securityCode,
          installments: paymentData.cardToken.installments,
        };
        this.logger.debug('Card token prepared:', {
          brand: cardTokenData.brand,
          installments: cardTokenData.installments,
          hasSecurityCode: !!cardTokenData.securityCode,
        });
      } else if (paymentData.card) {
        cardData = {
          number: paymentData.card.number,
          holder: paymentData.card.name,
          expiry: paymentData.card.expiry,
          cvv: paymentData.card.cvv,
          installments: paymentData.card.installments,
        };
        this.logger.debug('Card data prepared:', {
          hasNumber: !!cardData.number,
          hasHolder: !!cardData.holder,
          hasExpiry: !!cardData.expiry,
          hasCvv: !!cardData.cvv,
          installments: cardData.installments,
        });
      } else {
        throw new BadRequestException('Card data or card token is required for credit card payments');
      }
    }

    // Circuit breaker: rejeitar imediatamente se o circuito estiver aberto
    if (Date.now() < this.cieloCircuitOpenUntil) {
      const retryAfterSec = Math.ceil((this.cieloCircuitOpenUntil - Date.now()) / 1000);
      throw new BadRequestException(
        `Gateway de pagamento temporariamente indisponível. Tente novamente em ${retryAfterSec}s.`,
      );
    }

    // Processar pagamento na Cielo (passar o enum diretamente)
    const cieloResult = await this.cieloService.createPayment(
      finalTotal,
      'BRL',
      paymentMethod,
      merchantOrderId,
      {
        name: `${user?.firstName} ${user?.lastName}`,
        email: user?.email,
        identity: customerCpf,
        identityType: customerCpf ? 'CPF' : undefined,
      },
      cardData,
      cardTokenData,
    );

    if (!cieloResult.success) {
      // Circuit breaker: contar falhas e abrir o circuito se necessário
      this.cieloFailures++;
      if (this.cieloFailures >= this.CIELO_CIRCUIT_THRESHOLD) {
        this.cieloCircuitOpenUntil = Date.now() + this.CIELO_CIRCUIT_RESET_MS;
        this.cieloFailures = 0;
        this.logger.warn(
          `Circuit breaker aberto para Cielo após ${this.CIELO_CIRCUIT_THRESHOLD} falhas consecutivas. ` +
          `Reabrirá em ${this.CIELO_CIRCUIT_RESET_MS / 1000}s.`,
        );
      }

      const errorDetails = (cieloResult as any).errorDetails;
      this.logger.error('Payment processing failed:', {
        error: cieloResult.error,
        errorDetails,
        paymentMethod,
        finalTotal,
        merchantOrderId,
      });

      // Construir mensagem de erro mais informativa
      // Se já temos uma mensagem amigável do CieloService, usar ela diretamente
      let errorMessage = cieloResult.error || 'Falha ao processar pagamento';
      
      // Adicionar detalhes técnicos apenas se necessário para debug (não expor ao usuário final)
      // A mensagem do cieloResult.error já deve ser amigável
      if (errorDetails && process.env.NODE_ENV === 'development') {
        try {
          const detailsStr = typeof errorDetails === 'string'
            ? errorDetails
            : JSON.stringify(errorDetails);
          if (detailsStr && detailsStr !== '{}') {
            this.logger.debug('Error details:', detailsStr);
          }
        } catch (e) {
          // Ignorar erro de serialização
        }
      }

      throw new BadRequestException(errorMessage);
    }

    // Cielo respondeu com sucesso — resetar contador de falhas
    this.cieloFailures = 0;

    // Determinar status do pagamento:
    // - PIX e Boleto: sempre 'pending' inicialmente (aguardam webhook para confirmação)
    // - Cartão de crédito: 'approved' se autorizado, caso contrário 'pending'
    let paymentStatus: 'approved' | 'pending';
    if (paymentMethod === PaymentMethod.PIX || paymentMethod === PaymentMethod.BOLETO) {
      // PIX e Boleto sempre começam como pending - o webhook confirma depois
      paymentStatus = 'pending';
    } else if (paymentMethod === PaymentMethod.CREDIT_CARD) {
      // Cartão de crédito pode ser aprovado imediatamente se autorizado
      paymentStatus = cieloResult.cieloStatus === 'Authorized' || cieloResult.cieloStatus === 'PaymentConfirmed'
        ? 'approved'
        : 'pending';
    } else {
      // Fallback para outros métodos
      paymentStatus = 'pending';
    }

    return {
      success: true,
      transactionId: cieloResult.paymentId,
      status: paymentStatus,
      pix: cieloResult.qrCode || cieloResult.pixCode
        ? {
          qrCode: cieloResult.qrCode,
          qrCodeBase64: cieloResult.qrCode,
          pixCode: cieloResult.pixCode,
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
      merchantOrderId,
      cieloResult,
      // SEGURANÇA: mascarar PAN antes de retornar — nunca expor número completo, CVV ou validade
      cardData: cardData
        ? {
          number: cardData.number
            ? '*'.repeat(
                Math.max(0, cardData.number.replace(/\D/g, '').length - 4),
              ) + cardData.number.replace(/\D/g, '').slice(-4)
            : null,
          holder: cardData.holder ?? null,
          expiry: null,  // nunca expor data de validade
          cvv: null,     // nunca expor CVV
          installments: cardData.installments,
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
    prismaWrite: any,
  ) {
    // Toda a criação de dados financeiros e inscrições ocorre numa única transação
    // serializable, garantindo atomicidade e evitando race conditions de estoque.
    return await prismaWrite.$transaction(async (prisma) => {
    const registrations = [];

    const b = dto.billingAddress;
    const billingPostalStored = normalizeBillingPostalCodeForStorage(
      b.country,
      b.postalCode,
    );

    // 1. Criar o Order primeiro com todos os dados financeiros
    // Converter valores para centavos (multiplicar por 100)
    const order = await prisma.order.create({
      data: {
        userId,
        eventId: dto.eventId,
        totalAmount: prices.ticketsSubtotal + prices.productsSubtotal,
        serviceFee: prices.serviceFee,
        discount: prices.couponDiscount + prices.voucherDiscount,
        finalAmount: prices.finalTotal,
        ...((dto as any).idempotencyKey && { idempotencyKey: (dto as any).idempotencyKey }),
        ...(couponResult.couponId && { couponId: couponResult.couponId }),
        ...(voucherResult.voucherId && { voucherId: voucherResult.voucherId }),
        billingCountry: b.country,
        billingPostalCode: billingPostalStored,
        billingStateUf: b.stateUf ?? null,
        billingStreet: b.street,
        billingNumber: b.number,
        billingComplement: b.complement ?? null,
        billingNeighborhood: b.neighborhood,
        billingCity: b.city,
      },
    });

    // Preparar metadata completo do pagamento para extrato
    const cieloResultData = paymentResult.cieloResult;
    const cardData = paymentResult.cardData;

    // Preparar informações do cartão (mascaradas)
    const creditCardInfo = cardData ? {
      last4Digits: cardData.number?.replace(/\D/g, '').slice(-4) || null,
      brand: this.detectCardBrandFromNumber(cardData.number) || null,
      holder: cardData.holder ? cardData.holder.toUpperCase() : null,
      installments: cardData.installments || 1,
      installmentValue: prices.finalTotal / (cardData.installments || 1),
    } : null;

    // Preparar informações completas do pagamento
    const paymentMetadata: any = {
      // Informações básicas
      cieloPaymentId: cieloResultData?.paymentId,
      cieloStatus: cieloResultData?.cieloStatus,
      merchantOrderId: cieloResultData?.paymentId ? (paymentResult.merchantOrderId ?? null) : null,

      // Informações de autorização (cartão de crédito)
      authorizationCode: cieloResultData?.authorizationCode || null,
      proofOfSale: cieloResultData?.proofOfSale || null,
      returnCode: cieloResultData?.returnCode || null,
      returnMessage: cieloResultData?.returnMessage || null,

      // Informações do cartão de crédito (mascaradas)
      creditCard: creditCardInfo || paymentResult.creditCard,

      // Informações de PIX
      pix: paymentResult.pix ? {
        ...paymentResult.pix,
        qrCode: cieloResultData?.qrCode || paymentResult.pix.qrCode,
        pixCode: cieloResultData?.pixCode || null,
        expiresAt: cieloResultData?.expiresAt?.toISOString() || paymentResult.pix.expirationDate?.toISOString(),
      } : null,

      // Informações de Boleto
      boleto: paymentResult.boleto ? {
        ...paymentResult.boleto,
        barcode: cieloResultData?.barcode || paymentResult.boleto.barcode,
        digitableLine: cieloResultData?.barcode || paymentResult.boleto.digitableLine,
        expiresAt: cieloResultData?.expiresAt?.toISOString() || paymentResult.boleto.expirationDate?.toISOString(),
        instructions: cieloResultData?.instructions || null,
        assignor: cieloResultData?.assignor || null,
        address: cieloResultData?.address || null,
      } : null,

      // Informações de cupons e vouchers
      discounts: {
        coupon: couponResult.couponId ? {
          couponId: couponResult.couponId,
          discount: couponResult.discount,
        } : null,
        voucher: voucherResult.voucherId ? {
          voucherId: voucherResult.voucherId,
          discount: voucherResult.discount,
        } : null,
        totalDiscount: prices.couponDiscount + prices.voucherDiscount,
      },

      // Informações de preços
      pricing: {
        ticketsSubtotal: prices.ticketsSubtotal,
        productsSubtotal: prices.productsSubtotal,
        serviceFee: prices.serviceFee,
        discount: prices.couponDiscount + prices.voucherDiscount,
        finalTotal: prices.finalTotal,
      },

      billingAddress: {
        country: b.country,
        postalCode: billingPostalStored,
        stateUf: b.stateUf ?? null,
        street: b.street,
        number: b.number,
        complement: b.complement ?? null,
        neighborhood: b.neighborhood,
        city: b.city,
      },

      // Timestamps
      createdAt: new Date().toISOString(),
    };

    // 2. Criar Payment vinculado ao Order
    // amount já está em centavos no order.finalAmount
    // Determinar status do pagamento: PAID se aprovado, FAILED se falhou, PENDING caso contrário
    let paymentStatus: PaymentStatus = PaymentStatus.PENDING;
    if (paymentResult.status === 'approved') {
      paymentStatus = PaymentStatus.PAID;
    } else if (paymentResult.status === 'failed' || !paymentResult.success) {
      paymentStatus = PaymentStatus.FAILED;
    }

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        userId,
        method: dto.paymentMethod,
        status: paymentStatus,
        amount: order.finalAmount, // Já está em centavos
        transactionId: paymentResult.transactionId,
        paymentDate: paymentResult.status === 'approved' ? new Date() : null,
        metadata: {
          ...paymentMetadata,
          // Adicionar informação de erro se o pagamento falhou
          ...(paymentResult.error && { error: paymentResult.error }),
        },
      },
    });

    // 3. Mapa ticketId -> batchId: resolve o primeiro lote com vaga disponível
    const ticketIdToBatchId = new Map<string, string>();
    const ticketIdToBatch = new Map<string, { id: string; price: number; name: string | null }>();
    for (const ticketItem of dto.tickets) {
      const result = await this.findAvailableBatch(
        prisma,
        ticketItem.ticketId,
        ticketItem.batchId,
        ticketItem.quantity,
      );
      if (result) {
        ticketIdToBatchId.set(ticketItem.ticketId, result.batch.id);
        ticketIdToBatch.set(ticketItem.ticketId, {
          id: result.batch.id,
          price: result.batch.price,
          name: result.batch.name ?? null,
        });
      }
    }

    // Pré-carregar dados completos dos ingressos para snapshot no momento da compra
    const snapshotTicketIds = dto.tickets.map((t) => t.ticketId);
    const snapshotTickets = await prisma.ticket.findMany({
      where: { id: { in: snapshotTicketIds } },
      include: {
        category: { select: { id: true, name: true } },
        products: {
          include: {
            product: {
              include: { variations: { select: { id: true, name: true, price: true } } },
            },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    const ticketSnapshotDataById = new Map(snapshotTickets.map((t: any) => [t.id, t]));

    // Pré-carregar produtos inclusos por ingresso para cálculo de preço
    const ticketIdsForRegistration = dto.tickets.map((t) => t.ticketId);
    const registrationTicketProducts = ticketIdsForRegistration.length > 0
      ? await prisma.ticketProduct.findMany({
          where: { ticketId: { in: ticketIdsForRegistration } },
          select: { ticketId: true, productId: true },
        })
      : [];
    const ticketIdToIncludedProductIds = new Map<string, Set<string>>();
    for (const row of registrationTicketProducts) {
      const set = ticketIdToIncludedProductIds.get(row.ticketId) ?? new Set<string>();
      set.add(row.productId);
      ticketIdToIncludedProductIds.set(row.ticketId, set);
    }

    // 4. Criar uma Registration por participante vinculada ao Order

    // Pré-carregar buyer user e todos os usuários participantes em lote (evitar N+1)
    const buyerUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const participantEmailSet = new Set(dto.participants.map((p) => p.email.toLowerCase()));
    participantEmailSet.delete(buyerUser?.email?.toLowerCase() ?? '');
    const existingParticipants = participantEmailSet.size > 0
      ? await prisma.user.findMany({
          where: { email: { in: [...participantEmailSet] } },
        })
      : [];
    const emailToUser = new Map<string, typeof existingParticipants[0]>(
      existingParticipants.map((u) => [u.email.toLowerCase(), u]),
    );

    // Pré-carregar todos os produtos referenciados pelos participantes em lote
    const allProductIds = [
      ...new Set(
        dto.participants.flatMap((p) => (p.products ?? []).map((prod) => prod.productId)),
      ),
    ];
    const allProductsById = new Map<string, any>();
    if (allProductIds.length > 0) {
      const products = await prisma.product.findMany({
        where: { id: { in: allProductIds }, deletedAt: null },
        include: { variations: true },
      });
      for (const prod of products) {
        allProductsById.set(prod.id, prod);
      }
    }

    let participantIndex = 0;
    for (const ticketItem of dto.tickets) {
      // Criar participantes para este ticket
      for (let i = 0; i < ticketItem.quantity; i++) {
        const participantData = dto.participants[participantIndex];

        // Resolver usuário participante — nunca cria User fantasma
        let participantUserId: string | null = userId;
        let participantSnapshot: {
          name: string; email: string; cpf: string; cpfClean: string;
          phone: string; dateOfBirth: Date | null; gender: string | null;
        } | null = null;

        if (participantData.email.toLowerCase() !== buyerUser?.email?.toLowerCase()) {
          const existingUser = emailToUser.get(participantData.email.toLowerCase()) ?? null;
          if (existingUser) {
            participantUserId = existingUser.id;
          } else {
            participantUserId = null;
            participantSnapshot = {
              name: participantData.name,
              email: participantData.email,
              cpf: participantData.cpf,
              cpfClean: participantData.cpf.replace(/\D/g, ''),
              phone: participantData.phone ?? '',
              dateOfBirth: participantData.birthDate ? new Date(participantData.birthDate) : null,
              gender: participantData.gender ?? null,
            };
          }
        }

        // Criar Registration para este participante
        // CONFIRMED se aprovado, CANCELLED se falhou, PENDING se aguardando confirmação (PIX/Boleto)
        const registrationStatus = paymentResult.status === 'approved'
          ? RegistrationStatus.CONFIRMED
          : paymentResult.status === 'failed' || !paymentResult.success
            ? RegistrationStatus.CANCELLED
            : RegistrationStatus.PENDING;

        const isGuest = participantUserId === null;
        const isDifferentUser = participantUserId !== null && participantUserId !== userId;

        const registration = await prisma.registration.create({
          data: {
            eventId: dto.eventId,
            orderId: order.id,
            userId: participantUserId,
            invitedById: (isDifferentUser || isGuest) ? userId : null,
            status: registrationStatus,
            termsAccepted: true,
            rulesAccepted: true,
            emergencyContactName: participantData.emergencyContactName?.trim() || null,
            emergencyContactPhone: participantData.emergencyPhone?.trim() || null,
            ...(participantSnapshot && {
              participantName: participantSnapshot.name,
              participantEmail: participantSnapshot.email,
              participantCpf: participantSnapshot.cpf,
              participantCpfClean: participantSnapshot.cpfClean,
              participantPhone: participantSnapshot.phone,
              participantDateOfBirth: participantSnapshot.dateOfBirth,
              participantGender: participantSnapshot.gender,
            }),
          },
        });

        const qrCodePayload = JSON.stringify({
          registrationId: registration.id,
          eventId: dto.eventId,
          userId: participantUserId ?? userId,
        });
        const updatedRegistration = await prisma.registration.update({
          where: { id: registration.id },
          data: { qrCode: qrCodePayload },
          select: {
            id: true,
            qrCode: true,
            status: true,
            userId: true,
          },
        });

        // Criar RegistrationTicket com snapshot completo do ingresso no momento da compra
        const batchId = ticketIdToBatchId.get(ticketItem.ticketId) ?? null;
        const batchSnapshot = batchId ? ticketIdToBatch.get(ticketItem.ticketId) : null;
        const ticketData = ticketSnapshotDataById.get(ticketItem.ticketId) as any;
        const ticketSnapshot = ticketData ? {
          id: ticketData.id,
          name: ticketData.name,
          description: ticketData.description ?? null,
          modality: ticketData.modality ?? null,
          distance: ticketData.distance ?? null,
          distanceUnit: ticketData.distanceUnit ?? null,
          gender: ticketData.gender ?? null,
          ageLimitMin: ticketData.ageLimitMin ?? null,
          ageLimitMax: ticketData.ageLimitMax ?? null,
          category: ticketData.category ?? null,
          batch: batchSnapshot ? {
            id: batchSnapshot.id,
            name: batchSnapshot.name,
            price: batchSnapshot.price,
          } : null,
          products: (ticketData.products ?? []).map((tp: any) => ({
            id: tp.product.id,
            name: tp.product.name,
            variations: tp.product.variations ?? [],
          })),
        } : null;
        await prisma.registrationTicket.create({
          data: {
            registrationId: registration.id,
            ticketId: ticketItem.ticketId,
            batchId,
            ticketSnapshot,
          },
        });

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

        // Criar produtos escolhidos pelo participante (usando cache pré-carregado)
        if (participantData.products) {
          for (const productItem of participantData.products) {
            const product = allProductsById.get(productItem.productId);

            if (product) {
              const ticketIncluded = ticketIdToIncludedProductIds.get(ticketItem.ticketId) ?? new Set<string>();
              const unitPrice = this.resolveProductPrice(product, productItem.variationId, ticketIncluded);
              const selectedVariation = productItem.variationId
                ? (product.variations ?? []).find((v: any) => v.id === productItem.variationId)
                : null;
              const productSnapshot = {
                id: product.id,
                name: product.name,
                images: product.images ?? [],
                primaryImageIndex: product.primaryImageIndex ?? 0,
                basePrice: product.basePrice,
                isIncludedInTicket: product.isIncludedInTicket,
                isRequired: product.isRequired,
                variationType: product.variationType ?? null,
                selectedVariation: selectedVariation
                  ? { id: selectedVariation.id, name: selectedVariation.name, price: selectedVariation.price }
                  : null,
              };

              await prisma.registrationProduct.create({
                data: {
                  registrationId: registration.id,
                  productId: productItem.productId,
                  variationId: productItem.variationId || null,
                  quantity: productItem.quantity,
                  unitPrice: unitPrice,
                  totalPrice: unitPrice * productItem.quantity,
                  productSnapshot,
                },
              });
            }
          }
        }

        registrations.push(updatedRegistration);
        participantIndex++;
      }
    }

    const buyerCheckoutParticipant = dto.participants.find(
      (p) => p.email?.toLowerCase() === buyerUser?.email?.toLowerCase(),
    );
    const emergency = buyerCheckoutParticipant?.emergencyPhone?.trim();
    if (emergency) {
      await prisma.user.update({
        where: { id: userId },
        data: { reservePhone: emergency },
      });
    }

    // 4. Atualizar uso de cupom (com re-verificação dentro da transação para evitar race condition)
    if (couponResult.couponId) {
      const freshCoupon = await prisma.coupon.findUnique({
        where: { id: couponResult.couponId },
        select: { usageCount: true, maxUsage: true, couponType: true },
      });
      let usageIncrement: number;
      if (freshCoupon?.couponType === 'QUANTITY') {
        // QUANTITY: all-or-nothing — race condition protection
        if (freshCoupon.maxUsage != null && freshCoupon.usageCount >= freshCoupon.maxUsage) {
          throw new BadRequestException('Cupom esgotado. Prossiga sem desconto ou escolha outro cupom.');
        }
        usageIncrement = 1;
      } else {
        // DISCOUNT/AGE: uso parcial — aplica no máximo o restante disponível
        const remaining = freshCoupon?.maxUsage != null
          ? Math.max(0, freshCoupon.maxUsage - freshCoupon.usageCount)
          : registrations.length;
        usageIncrement = Math.min(remaining, registrations.length);
      }
      if (usageIncrement > 0) {
        await prisma.coupon.update({
          where: { id: couponResult.couponId },
          data: {
            usageCount: { increment: usageIncrement },
          },
        });
      }
    }

    // 5. Marcar voucher como usado
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

    return { registrations, order };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 30000,
    });
  }

  /**
   * Executa `fn` e, em caso de falha de serialização (P2034), tenta novamente
   * até `maxRetries` vezes com backoff exponencial.
   */
  private async withSerializableRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 3,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err: any) {
        if (err?.code === 'P2034' && attempt < maxRetries) {
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
          this.logger.warn(`Serialization failure, retrying (attempt ${attempt}/${maxRetries})…`);
          continue;
        }
        if (err?.code === 'P2034') {
          throw new BadRequestException(
            'O pedido não pôde ser processado devido à alta concorrência. Tente novamente em instantes.',
          );
        }
        throw err;
      }
    }
  }

  /**
   * Expira inscrições PENDING mais antigas que `olderThanMinutes` cujo pagamento
   * não foi confirmado. Deve ser chamado por um job periódico.
   */
  async expirePendingRegistrations(olderThanMinutes = 30): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    const result = await this.prisma.getWriteClient().registration.updateMany({
      where: {
        status: RegistrationStatus.PENDING,
        createdAt: { lt: cutoff },
        order: {
          payment: {
            status: { notIn: [PaymentStatus.PAID] },
          },
        },
      },
      data: { status: RegistrationStatus.CANCELLED },
    });
    this.logger.log(`Expired ${result.count} pending registrations older than ${olderThanMinutes} min`);
    return result.count;
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

  private checkAgeCondition(coupon: any, age: number): boolean {
    // New fields take precedence over legacy ageRule/ageValue
    if (coupon.minAge != null && age < coupon.minAge) return false;
    if (coupon.maxAge != null && age > coupon.maxAge) return false;
    // Legacy
    if (!coupon.minAge && !coupon.maxAge) {
      if (coupon.ageRule === 'MIN' && age < parseInt(coupon.ageValue || '0')) return false;
      if (coupon.ageRule === 'MAX' && age > parseInt(coupon.ageValue || '999')) return false;
    }
    return true;
  }

  /**
   * Detecta a bandeira do cartão baseado no número
   * Helper para salvar informações do cartão no extrato
   */
  private detectCardBrandFromNumber(cardNumber: string): string | null {
    if (!cardNumber) return null;

    const number = cardNumber.replace(/\D/g, ''); // Remove caracteres não numéricos

    // Visa: começa com 4
    if (/^4/.test(number)) return 'Visa';

    // Mastercard: começa com 5
    if (/^5[1-5]/.test(number)) return 'Mastercard';

    // Amex: começa com 34 ou 37
    if (/^3[47]/.test(number)) return 'Amex';

    // Elo: começa com vários prefixos
    if (/^(401178|401179|431274|438935|451416|457393|457631|457632|504175|627780|636297|636368|636369)/.test(number)) return 'Elo';

    // Hipercard: começa com 38 ou 60
    if (/^(38|60)/.test(number)) return 'Hipercard';

    // Diners: começa com 30, 36 ou 38
    if (/^3[068]/.test(number)) return 'Diners';

    // Discover: começa com 6011 ou 65
    if (/^(6011|65)/.test(number)) return 'Discover';

    return 'Unknown';
  }

  /**
   * Gera número do pedido no formato PT-YYYY-XXXX
   * Exemplo: PT-2025-0348
   */
  private generateOrderNumber(registrationId: string): string {
    const year = new Date().getFullYear();
    // Usar últimos 4 caracteres do UUID como número sequencial
    const sequence = registrationId.replace(/-/g, '').slice(-4).toUpperCase();
    return `PT-${year}-${sequence}`;
  }

  /**
   * Retorna label formatado do método de pagamento
   */
  private getPaymentMethodLabel(method: PaymentMethod): string {
    const labels: Partial<Record<PaymentMethod, string>> = {
      CREDIT_CARD: 'Cartão de crédito',
      PIX: 'PIX',
      BOLETO: 'Boleto',
    };
    return labels[method] || method;
  }

  /**
   * Busca informações detalhadas dos tickets, participantes e produtos da registration
   */
  private async getRegistrationDetails(
    registrationId: string,
    dto: ProcessCheckoutDto,
    prisma: any,
  ) {
    // Buscar tickets da registration
    const registrationTickets = await prisma.registrationTicket.findMany({
      where: { registrationId },
      include: {
        ticket: {
          include: {
            batches: {
              orderBy: { startDate: 'desc' },
            },
          },
        },
      },
    });

    // Buscar participantes - como não há tabela RegistrationParticipant,
    // vamos usar os dados do DTO e buscar informações dos usuários relacionados
    // Buscar usuários convidados (participantes) pelo email do DTO
    const participantEmails = dto.participants.map((p) => p.email);
    const participantUsers = await prisma.user.findMany({
      where: {
        email: { in: participantEmails },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        documentNumber: true,  // CPF está em documentNumber
        dateOfBirth: true,     // Data de nascimento está em dateOfBirth
        gender: true,
      },
    });

    // Buscar produtos (kit items) da registration ou usar dados do DTO
    let registrationKitItems: any[] = [];
    try {
      registrationKitItems = await prisma.registrationKitItem.findMany({
        where: { registrationId },
        include: {
          kitItem: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  basePrice: true,
                },
              },
            },
          },
        },
      });
    } catch (e) {
      // Se não houver RegistrationKitItem, vamos buscar dos produtos do DTO
      this.logger.debug('No RegistrationKitItem found, using DTO data');
    }

    // Buscar modalidades da registration
    const registrationModalities = await prisma.registrationModality.findMany({
      where: { registrationId },
      include: {
        modality: {
          select: {
            id: true,
            name: true,
            description: true,
            price: true,
          },
        },
      },
    });

    // Buscar respostas das perguntas da registration
    const questionAnswers = await prisma.questionAnswer.findMany({
      where: { registrationId },
      include: {
        question: {
          select: {
            id: true,
            question: true,
            type: true,
          },
        },
      },
    });

    // Formatar informações dos tickets
    const tickets = registrationTickets.map((rt: any) => {
      const ticket = rt.ticket;
      // Encontrar o lote usado (pode ser o batchId do dto ou o lote ativo)
      const batch = dto.tickets.find((t) => t.ticketId === ticket.id)?.batchId
        ? ticket.batches.find((b: any) => b.id === dto.tickets.find((t) => t.ticketId === ticket.id)?.batchId)
        : ticket.batches[0]; // Usar o primeiro lote se não especificado

      return {
        id: ticket.id,
        name: ticket.name,
        description: ticket.description,
        price: batch?.price || ticket.basePrice || 0,
        batch: batch ? {
          id: batch.id,
          name: batch.name,
          price: batch.price,
        } : null,
        quantity: dto.tickets.find((t) => t.ticketId === ticket.id)?.quantity || 1,
      };
    });

    // Produtos inclusos por ticket: uma consulta para todos os ticketIds do checkout
    const ticketIdsUnique = [...new Set(dto.tickets.map((t) => t.ticketId))];
    const allTicketProducts =
      ticketIdsUnique.length > 0
        ? await prisma.ticketProduct.findMany({
            where: { ticketId: { in: ticketIdsUnique } },
            orderBy: [{ ticketId: 'asc' }, { sortOrder: 'asc' }],
            include: {
              product: {
                include: {
                  variations: true,
                },
              },
            },
          })
        : [];
    const ticketProductsMap = new Map<string, typeof allTicketProducts>();
    for (const row of allTicketProducts) {
      const list = ticketProductsMap.get(row.ticketId);
      if (list) {
        list.push(row);
      } else {
        ticketProductsMap.set(row.ticketId, [row]);
      }
    }

    const additionalProductIds = new Set<string>();
    for (const p of dto.participants) {
      if (p.products) {
        for (const item of p.products) {
          additionalProductIds.add(item.productId);
        }
      }
    }
    const additionalProductsById = new Map<
      string,
      { id: string; name: string; basePrice: number; variations: { id: string; name: string; price: number }[] }
    >();
    if (additionalProductIds.size > 0) {
      const loaded = await prisma.product.findMany({
        where: { id: { in: [...additionalProductIds] }, deletedAt: null },
        include: { variations: true },
      });
      for (const prod of loaded) {
        additionalProductsById.set(prod.id, prod);
      }
    }

    // Formatar informações dos participantes usando dados do DTO e usuários encontrados
    const participants = dto.participants.map((dtoParticipant, index) => {
        const user = participantUsers.find((u) => u.email === dtoParticipant.email);

        // Buscar respostas das perguntas deste participante
        const participantQuestionAnswers = dtoParticipant.questionAnswers?.map((qa) => {
          // Buscar a pergunta completa do banco se possível
          const questionAnswer = questionAnswers.find((qaDb) => qaDb.questionId === qa.questionId);
          return {
            questionId: qa.questionId,
            question: questionAnswer?.question?.question || null,
            answer: qa.answer,
            type: questionAnswer?.question?.type || null,
          };
        }) || [];

        const participantProducts = [];
        if (dtoParticipant.products) {
          // Resolver quais produtos estão inclusos no ingresso deste participante
          const participantTicketForPrice = (() => {
            let tIdx = 0;
            let pCount = 0;
            for (let i = 0; i < dto.tickets.length; i++) {
              if (index < pCount + dto.tickets[i].quantity) { tIdx = i; break; }
              pCount += dto.tickets[i].quantity;
            }
            return dto.tickets[tIdx];
          })();
          const includedInParticipantTicket = new Set<string>(
            (ticketProductsMap.get(participantTicketForPrice?.ticketId) ?? []).map((tp: any) => tp.product.id),
          );

          for (const productItem of dtoParticipant.products) {
            const product = additionalProductsById.get(productItem.productId);

            if (product) {
              const productPrice = this.resolveProductPrice(product, productItem.variationId, includedInParticipantTicket);
              const variationName = productItem.variationId
                ? product.variations.find((v) => v.id === productItem.variationId)?.name ?? null
                : null;

              participantProducts.push({
                productId: product.id,
                productName: product.name,
                variationId: productItem.variationId || null,
                variationName: variationName,
                quantity: productItem.quantity,
                unitPrice: productPrice,
                totalPrice: productPrice * productItem.quantity,
              });
            }
          }
        }

        // Buscar produtos inclusos nos ingressos deste participante
        // Encontrar qual ticket foi comprado para este participante baseado na ordem
        let ticketIndex = 0;
        let participantCount = 0;
        for (let i = 0; i < dto.tickets.length; i++) {
          if (index < participantCount + dto.tickets[i].quantity) {
            ticketIndex = i;
            break;
          }
          participantCount += dto.tickets[i].quantity;
        }
        const participantTicket = dto.tickets[ticketIndex] || dto.tickets[0];

        const includedProducts = ticketProductsMap.get(participantTicket?.ticketId) || [];
        const formattedIncludedProducts = includedProducts.map((tp: any) => ({
          productId: tp.product.id,
          productName: tp.product.name,
          basePrice: tp.product.basePrice,
          isIncludedInTicket: true,
        }));

        return {
          id: user?.id || `participant-${index}`,
          name: user ? `${user.firstName} ${user.lastName}` : dtoParticipant.name,
          email: dtoParticipant.email,
          cpf: user?.documentNumber || dtoParticipant.cpf || null,  // documentNumber contém o CPF
          phone: user?.phone || dtoParticipant.phone || null,
          birthDate: user?.dateOfBirth ? user.dateOfBirth.toISOString().split('T')[0] : dtoParticipant.birthDate || null,  // dateOfBirth é DateTime
          gender: user?.gender || dtoParticipant.gender || null,
          questionAnswers: participantQuestionAnswers,
          products: participantProducts, // Produtos adicionais
          includedProducts: formattedIncludedProducts, // Produtos inclusos no ingresso
        };
    });

    // Formatar informações dos produtos
    let products: any[] = [];

    if (registrationKitItems.length > 0) {
      // Se houver RegistrationKitItem no banco, usar eles
      products = registrationKitItems.map((rki: any) => {
        const kitItem = rki.kitItem;
        const product = kitItem.product;
        return {
          id: product.id,
          name: product.name,
          kitItemName: kitItem.name,
          selectedSize: rki.selectedSize,
          quantity: rki.quantity,
          unitPrice: product.basePrice,
          totalPrice: product.basePrice * rki.quantity,
        };
      });
    } else {
      // Se não houver no banco, buscar dos produtos do DTO
      // Todos os produtos inclusos nos ingressos desta compra (união)
      const allIncludedProductIds = new Set<string>(
        allTicketProducts.map((tp: any) => tp.product.id),
      );
      const allProducts: any[] = [];
      for (const participant of dto.participants) {
        if (participant.products) {
          for (const productItem of participant.products) {
            const product = await prisma.product.findUnique({
              where: { id: productItem.productId },
              include: { variations: true },
            });

            if (product) {
              const productPrice = this.resolveProductPrice(product, productItem.variationId, allIncludedProductIds);

              allProducts.push({
                id: product.id,
                name: product.name,
                variationId: productItem.variationId || null,
                variationName: productItem.variationId
                  ? product.variations.find((v) => v.id === productItem.variationId)?.name || null
                  : null,
                quantity: productItem.quantity,
                unitPrice: productPrice,
                totalPrice: productPrice * productItem.quantity,
              });
            }
          }
        }
      }
      products = allProducts;
    }

    // Formatar itens dos kits (separado dos produtos adicionais)
    const kitItems = registrationKitItems.map((rki: any) => {
      const kitItem = rki.kitItem;
      return {
        id: kitItem.id,
        name: kitItem.name,
        description: kitItem.description,
        selectedSize: rki.selectedSize,
        quantity: rki.quantity,
        product: kitItem.product ? {
          id: kitItem.product.id,
          name: kitItem.product.name,
          basePrice: kitItem.product.basePrice,
        } : null,
      };
    });

    // Formatar modalidades
    const modalities = registrationModalities.map((rm: any) => ({
      id: rm.modality.id,
      name: rm.modality.name,
      description: rm.modality.description,
      price: rm.modality.price,
    }));

    // Formatar respostas das perguntas (agrupadas por pergunta)
    const formattedQuestionAnswers = questionAnswers.map((qa: any) => ({
      questionId: qa.questionId,
      question: qa.question.question,
      type: qa.question.type,
      answer: qa.answer,
    }));

    return {
      tickets,
      participants,
      products,
      kitItems, // Itens dos kits
      modalities, // Modalidades do evento
      questionAnswers: formattedQuestionAnswers, // Respostas das perguntas
    };
  }
}
