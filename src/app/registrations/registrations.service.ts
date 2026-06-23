import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRegistrationDto, CreateRegistrationWithInvitedUserDto } from './dto/create-registration.dto';
import { FilterRegistrationsDto, RegistrationFilterStatus } from './dto/filter-registrations.dto';
import { DocumentType, Prisma, RegistrationStatus, PaymentStatus } from '@prisma/client';
// QR Code é gerado dinamicamente no frontend/backend usando o payload salvo em qrCode
import { KitsService } from '../kits/kits.service';
import { EmailService } from '../../common/services/email.service';
import { isDocumentInList, resolveDocument } from '../../common/utils/document.util';
import { tryConsumeVoucherUnreserved } from '../../common/utils/voucher-reservation.util';
import { stripOrganizationContact } from '../../common/utils/organization-sanitizer.util';
import { formatPdfAnswer } from '../../common/utils/pdf-answer.util';
import {
  TicketPdfService,
  TicketPdfData,
  TicketPdfProduct,
  TicketPdfRegistration,
} from '../../common/services/ticket-pdf.service';
import { PaymentsService } from '../payments/payments.service';

/**
 * Formata a data do evento (pt-BR, dia/mês/ano) para o envelope do e-mail.
 * Espelha o helper homônimo de `payments.service` (mesma saída no template).
 */
function formatEventDate(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = new Date(date as string);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Compõe o endereço do evento a partir das colunas estruturadas (cidade/estado/
 * bairro/local/CEP). Espelha o helper homônimo de `payments.service`.
 */
function formatEventAddress(event: any): string {
  const parts: string[] = [];
  const cityState: string[] = [];
  if (event?.city) cityState.push(event.city);
  if (event?.state) cityState.push(event.state);
  if (cityState.length) parts.push(cityState.join(' - '));
  if (event?.neighborhood) parts.push(event.neighborhood);
  if (event?.location) parts.push(event.location);
  if (event?.zipCode) {
    const cep = String(event.zipCode).replace(/\D/g, '');
    parts.push(cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep);
  }
  return parts.join(', ');
}

/**
 * Compõe a localização do evento para o PDF a partir do snapshot. `location`
 * pode vir como objeto estruturado (snapshot novo) ou string crua (legado).
 */
function formatSnapshotLocation(location: unknown): string {
  if (!location) return '';
  if (typeof location === 'string') return location;
  const loc = location as Record<string, unknown>;
  const cityState = [loc.city, loc.state].filter(Boolean).join(' - ');
  return [loc.name, loc.neighborhood, cityState].filter(Boolean).join(', ');
}

@Injectable()
export class RegistrationsService {
  private readonly logger = new Logger(RegistrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kitsService: KitsService,
    private readonly emailService: EmailService,
    private readonly ticketPdfService: TicketPdfService,
    // Reúso do gerador de comprovante (recibo) do pedido — mesmo PDF do download
    // e do e-mail de confirmação. Sem ciclo: RegistrationsModule importa
    // PaymentsModule, não o contrário.
    private readonly paymentsService: PaymentsService,
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

    // Verificar modalidades e calcular preço — busca em lote para evitar N+1
    const modalityIds = modalities.map((m) => m.modalityId);
    const foundModalities = await prismaRead.modality.findMany({
      where: { id: { in: modalityIds } },
    });
    const modalityMap = new Map(foundModalities.map((m) => [m.id, m]));

    let totalAmount = 0;
    for (const modalitySelection of modalities) {
      const modality = modalityMap.get(modalitySelection.modalityId);

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
    let guestSnapshot: {
      name: string;
      email: string;
      documentType: DocumentType | null;
      documentNumber: string;
      documentNumberClean: string;
    } | null = null;

    if (invitedUser) {
      const existingUser = await prismaRead.user.findFirst({
        where: { email: invitedUser.email },
        select: { id: true },
      });
      if (existingUser) {
        registrationUserId = existingUser.id;
      } else {
        registrationUserId = null;
        // invitedUser pode trazer documentType opcional (DTO atualizado);
        // ausência cai no inferDocumentType (CPF se for 11 dígitos).
        const doc = resolveDocument({
          documentType: (invitedUser as any).documentType,
          documentNumber: invitedUser.documentNumber,
        });
        guestSnapshot = {
          name: `${invitedUser.firstName} ${invitedUser.lastName}`,
          email: invitedUser.email,
          documentType: doc.type,
          documentNumber: doc.number,
          documentNumberClean: doc.clean,
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
        // Atomic ACTIVE → USED respeitando a RESERVA do checkout (reservedByOrderId):
        // este fluxo legado não tem pedido/claim próprio, então só pode consumir um
        // voucher LIVRE (sem reserva ativa de outro checkout, ou com reserva vencida).
        // Antes (updateMany por status apenas) era um bypass do uso único — consumia
        // voucher reservado por um pedido PENDING e quebrava aquele checkout no finalize.
        const consumed = await tryConsumeVoucherUnreserved(prisma, appliedVoucherId, registrationUserId);
        if (!consumed) {
          throw new BadRequestException(
            'Este voucher já foi utilizado ou está sendo usado em outro pedido.',
          );
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
            // Legacy (mantém durante a transição)
            participantCpf: guestSnapshot.documentNumber,
            participantCpfClean:
              guestSnapshot.documentType === DocumentType.CPF
                ? guestSnapshot.documentNumberClean
                : '',
            // Fonte de verdade nova
            participantDocumentType: guestSnapshot.documentType,
            participantDocumentNumber: guestSnapshot.documentNumber,
            participantDocumentNumberClean: guestSnapshot.documentNumberClean,
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
          // Mantido como fallback para pedidos PENDING sem receiptSnapshot.
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
              receiptSnapshot: true,
              invitedBy: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                },
              },
              tickets: {
                select: {
                  ticketSnapshot: true,
                  // Mantido como fallback para pedidos PENDING sem ticketSnapshot.
                  ticket: {
                    select: {
                      modality: true,
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
      let snapshotEvent: any = null;

      for (const reg of order.registrations ?? []) {
        // Event vem do primeiro receiptSnapshot encontrado — todas as registrations
        // do mesmo pedido carregam o mesmo evento.
        if (!snapshotEvent && reg.receiptSnapshot?.event) {
          snapshotEvent = reg.receiptSnapshot.event;
        }
        for (const rt of reg.tickets ?? []) {
          // Snapshot tem prioridade: se o organizer renomear modality depois,
          // o recibo mantém o nome original.
          const modality = rt.ticketSnapshot?.modality ?? rt.ticket?.modality ?? null;
          if (modality) modalitySet.add(modality);
        }
        // invitedBy: só exibimos quando ESTE user é o participante e outro comprou.
        // Continua live (não está no snapshot) — é apenas um label visual.
        if (!invitedBy && reg.userId === userId && reg.invitedBy) {
          invitedBy = {
            id: reg.invitedBy.id,
            fullName: `${reg.invitedBy.firstName} ${reg.invitedBy.lastName}`.trim(),
          };
        }
      }

      const event = snapshotEvent
        ? {
            id: snapshotEvent.id,
            name: snapshotEvent.name,
            slug: snapshotEvent.slug,
            eventDate: snapshotEvent.eventDate,
            logoUrl: snapshotEvent.logoUrl ?? null,
            location: snapshotEvent.location?.name ?? null,
            city: snapshotEvent.location?.city ?? null,
            state: snapshotEvent.location?.state ?? null,
          }
        : order.event;

      return {
        id: order.id,
        status: this.deriveOrderStatus(order.status, order.payment?.status ?? null),
        createdAt: order.createdAt,
        event,
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

    // Fetch leve só com o necessário p/ access check + snapshot. O snapshot (receiptSnapshot)
    // é o recibo IMUTÁVEL congelado no pagamento — esta rota expõe SOMENTE ele, sem joins ao
    // vivo, garantindo que a inscrição apareça exatamente como comprada mesmo que o organizador
    // edite evento/ingresso/produtos depois.
    const registration: any = await prismaRead.registration.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        qrCode: true,
        userId: true,
        invitedById: true,
        participantCpfClean: true,
        receiptSnapshot: true,
        order: { select: { userId: true } },
        event: { select: { organizationId: true } },
        // RegistrationProduct é a fonte de verdade PÓS-compra da variação: `updateProductVariation`
        // grava aqui (variationId + variationEdited) sem reescrever o snapshot. Lemos só este
        // recorte mutável p/ expor `variationEdited` e refletir a variação ATUAL no produto.
        products: {
          select: {
            productId: true,
            variationEdited: true,
            // unitPrice (centavos) = valor efetivamente cobrado por unidade; usado
            // p/ expor o `price` REAL da variação no read (vê map abaixo).
            unitPrice: true,
            // productSnapshot (Json congelado no pay) carrega isIncludedInTicket, que o
            // receiptSnapshot.products legado não guardava — usado p/ expor o flag.
            productSnapshot: true,
            variation: { select: { id: true, name: true, price: true } },
          },
        },
      },
    });

    if (!registration) {
      throw new NotFoundException('Inscrição não encontrada');
    }

    // Controle de acesso (mesmo critério do findMyRegistration). O findOne anterior NÃO
    // validava o dono — qualquer usuário autenticado lia qualquer inscrição (IDOR).
    const currentUser = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { documentNumberClean: true, role: true },
    });
    const isAdmin = currentUser?.role === 'PODIOGO_STAFF' || currentUser?.role === 'ADMIN';
    const isBuyer = registration.order?.userId === userId;
    const isParticipant = registration.userId === userId;
    const isInviter = registration.invitedById === userId;
    const isCpfMatch = !!(
      currentUser?.documentNumberClean &&
      registration.participantCpfClean === currentUser.documentNumberClean
    );
    if (!isAdmin && !isParticipant && !isInviter && !isBuyer && !isCpfMatch) {
      // Organizador do evento: membro da organização dona do evento (mesmo critério de
      // getPaymentDetails). Permite ao organizador inspecionar inscrições do seu evento.
      const organizationId = registration.event?.organizationId;
      const isOrganizer = organizationId
        ? !!(await prismaRead.organizationMember.findFirst({
            where: { organizationId, userId },
            select: { id: true },
          }))
        : false;
      if (!isOrganizer) {
        throw new BadRequestException('Acesso negado — você só pode visualizar suas próprias inscrições');
      }
    }

    const snapshot = registration.receiptSnapshot as Record<string, any> | null;

    // Caminho principal: dados 100% do snapshot (event, ticket, products, participant,
    // billing, pricing, questionAnswers, paidAt) + identidade/estado da própria inscrição.
    if (snapshot) {
      // Enriquece os produtos do snapshot com o estado MUTÁVEL de variação (RegistrationProduct):
      //  - `variationEdited`: true se o comprador trocou a variação após a compra.
      //  - `selectedVariation`: refletido p/ a variação ATUAL quando editada (o snapshot,
      //    congelado no pagamento, mostraria a variação ORIGINAL — defasada).
      // Casado por productId (o `id` do produto no snapshot é o productId).
      const regProductByProductId = new Map<string, any>(
        (registration.products ?? []).map((rp: any) => [rp.productId, rp]),
      );
      const snapshotProducts = Array.isArray(snapshot.products) ? snapshot.products : [];
      const products = snapshotProducts.map((p: any) => {
        const rp = regProductByProductId.get(p.id);
        const pSnap = (rp?.productSnapshot ?? null) as any;
        const variationEdited = rp?.variationEdited ?? false;
        const baseSelected =
          variationEdited && rp?.variation
            ? { id: rp.variation.id, name: rp.variation.name, price: rp.variation.price }
            : p.selectedVariation;
        // `price` da variação exibida = valor EFETIVAMENTE cobrado por unidade
        // (RegistrationProduct.unitPrice, centavos), não o catálogo cru congelado no
        // snapshot (price 0 quando a variação não tinha preço e o basePrice foi cobrado).
        // Incluso → unitPrice 0 (grátis), coerente. Fallback p/ o price cru se rp ausente.
        // (Opção B — ver sessão 2026-06-15.)
        const selectedVariation = baseSelected
          ? { ...baseSelected, price: rp?.unitPrice ?? baseSelected.price }
          : baseSelected;
        return {
          ...p,
          variationEdited,
          selectedVariation,
          // Produto incluso no ingresso (custo embutido, não cobrado à parte). O
          // receiptSnapshot legado não guardava o flag → fallback p/ o productSnapshot
          // por-produto (congelado no pay). (2026-06-15.)
          isIncludedInTicket:
            p.isIncludedInTicket ?? pSnap?.isIncludedInTicket ?? false,
        };
      });

      // Snapshots antigos congelaram organization.{email,phone} — strip no read
      // (contato do organizador fora do contrato de rota de usuário).
      const snapshotEvent = snapshot.event
        ? { ...snapshot.event, organization: stripOrganizationContact(snapshot.event.organization) }
        : snapshot.event;

      return {
        message: 'Registration fetched successfully',
        data: {
          registration: {
            id: registration.id,
            status: registration.status,
            qrCode: registration.qrCode ?? `https://www.podioticket.com.br/user/tickets/${registration.id}`,
            ...snapshot,
            event: snapshotEvent,
            products,
          },
        },
      };
    }

    // Fallback: inscrição legada/PENDING sem snapshot — mantém o build ao vivo apenas
    // quando não há snapshot a retornar (do contrário a rota ficaria sem dados).
    return this.findOneLive(id, userId);
  }

  /**
   * Gera o PDF do ingresso de UMA inscrição (download sob demanda no painel do
   * organizador/admin e na área do participante). Reaproveita `findOne`, que já
   * concentra o controle de acesso (comprador / participante / convidante /
   * admin / organizador do evento) e a normalização do `receiptSnapshot`
   * imutável — evitando segunda query e garantindo que o PDF baixado reflita o
   * ingresso EXATAMENTE como foi comprado, idêntico ao enviado por e-mail.
   *
   * @returns buffer do PDF + nome de arquivo já saneado para o Content-Disposition.
   */
  /**
   * Reenvia o e-mail de confirmação do PEDIDO (TODOS os ingressos + comprovante)
   * para o endereço informado — como se fosse o e-mail do comprador. Acionado no
   * modal de pedido (comprador / organizador / admin).
   *
   * Reúso máximo + baixo risco: cada ingresso é gerado por `generateTicketPdf`
   * (que já aplica o controle de acesso por inscrição) e o comprovante por
   * `paymentsService.generateReceiptPdf` (idem). NÃO toca no caminho de
   * pagamento já testado.
   *
   * Performance: os PDFs de ingresso são gerados SEQUENCIALMENTE — o gerador
   * (yoga-layout) não suporta render paralelo, mesma restrição do envio
   * pós-pagamento. Geração tolerante: um ingresso que falhe é logado e pulado,
   * sem abortar o reenvio dos demais.
   *
   * Segurança: o destino é arbitrário (organizador reenvia p/ o cliente), mas o
   * ACESSO ao pedido é checado (comprador/admin/organizador) antes de qualquer
   * geração — princípio do menor privilégio.
   */
  async resendOrderConfirmation(
    registrationId: string,
    userId: string,
    targetEmail: string,
  ): Promise<{ message: string; ticketCount: number }> {
    const prismaRead = this.prisma.getReadClient();

    // 1. Resolve o pedido a partir da inscrição.
    const registration = await prismaRead.registration.findUnique({
      where: { id: registrationId },
      select: { orderId: true },
    });
    if (!registration?.orderId) {
      throw new NotFoundException('Pedido não encontrado para esta inscrição');
    }

    // 2. Carrega o pedido: envelope do e-mail + inscrições válidas + dados de auth.
    const order: any = await prismaRead.order.findUnique({
      where: { id: registration.orderId },
      select: {
        id: true,
        userId: true,
        user: { select: { firstName: true, lastName: true } },
        event: {
          select: {
            organizationId: true,
            name: true,
            eventDate: true,
            location: true,
            neighborhood: true,
            city: true,
            state: true,
            zipCode: true,
            logoUrl: true,
            bannerUrl: true,
          },
        },
        registrations: {
          where: {
            status: {
              notIn: [RegistrationStatus.PENDING, RegistrationStatus.CANCELLED],
            },
          },
          select: {
            id: true,
            participantName: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException('Pedido não encontrado');
    }

    // 3. Controle de acesso: comprador / admin / organizador (membro da org do
    //    evento). Mesmo critério do download do comprovante.
    const isBuyer = order.userId === userId;
    let authorized = isBuyer || (await this.isAdminUser(userId));
    if (!authorized && order.event?.organizationId) {
      const member = await prismaRead.organizationMember.findFirst({
        where: { organizationId: order.event.organizationId, userId },
        select: { id: true },
      });
      authorized = !!member;
    }
    if (!authorized) {
      throw new BadRequestException(
        'Acesso negado — você não tem permissão para reenviar este pedido',
      );
    }

    const regs: any[] = order.registrations ?? [];
    if (regs.length === 0) {
      throw new BadRequestException(
        'O pedido não possui ingressos válidos para reenvio',
      );
    }

    // 4. Gera os PDFs de ingresso (sequencial) reusando o gerador por inscrição.
    const ticketPdfs: Array<{ buffer: Buffer; participantName: string }> = [];
    for (const reg of regs) {
      const participantName: string =
        (reg.participantName ??
          `${reg.user?.firstName ?? ''} ${reg.user?.lastName ?? ''}`.trim()) ||
        'Participante';
      try {
        const { buffer } = await this.generateTicketPdf(reg.id, userId);
        ticketPdfs.push({ buffer, participantName });
      } catch (e: any) {
        this.logger.warn(
          `Ingresso PDF falhou no reenvio (reg ${reg.id}): ${e?.message}`,
        );
      }
    }

    // 5. Gera o comprovante (recibo) do pedido. Pedido gratuito pode não ter
    //    recibo — tolera falha e segue só com os ingressos.
    const receiptPdf = await this.paymentsService
      .generateReceiptPdf(registrationId, userId)
      .then((r) => r.buffer)
      .catch((e: any) => {
        this.logger.warn(
          `Comprovante PDF falhou no reenvio (pedido ${order.id}): ${e?.message}`,
        );
        return undefined;
      });

    if (ticketPdfs.length === 0 && !receiptPdf) {
      throw new BadRequestException(
        'Não foi possível gerar os anexos do pedido. Tente novamente.',
      );
    }

    // 6. Envia UM e-mail ao destino com TODOS os ingressos + comprovante, como
    //    se fosse o comprador (sem banner "inscrição feita por"). Diferente do
    //    envio pós-pagamento, aqui o erro NÃO é silencioso: propaga p/ o
    //    controller dar feedback ao usuário.
    const event = order.event ?? {};
    await this.emailService.sendRegistrationConfirmed({
      email: targetEmail,
      firstName: order.user?.firstName || 'Participante',
      eventName: event.name ?? '',
      eventLocation: event.location ?? '',
      eventDate: formatEventDate(event.eventDate),
      eventAddress: formatEventAddress(event),
      eventBannerUrl: event.logoUrl ?? event.bannerUrl ?? '',
      ticketPdfs,
      receiptPdf,
    });

    this.logger.log(
      `Pedido ${order.id} reenviado para ${targetEmail} ` +
        `(${ticketPdfs.length} ingresso(s)${receiptPdf ? ' + comprovante' : ''}) por ${userId}`,
    );

    return {
      message: 'E-mail reenviado com sucesso',
      ticketCount: ticketPdfs.length,
    };
  }

  async generateTicketPdf(
    id: string,
    userId: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    // findOne aplica o mesmo controle de acesso da visualização e devolve o
    // registro normalizado (snapshot OU build ao vivo de fallback).
    const result: any = await this.findOne(id, userId);
    const registration = result?.data?.registration;
    if (!registration) {
      throw new NotFoundException('Inscrição não encontrada');
    }

    const pdfData = this.buildSingleTicketPdfData(registration);
    const buffer = await this.ticketPdfService.generateTicketPdf(pdfData);

    // Slug ASCII seguro p/ o header HTTP (sem acentos/espaços → sem quebra de
    // Content-Disposition em navegadores/proxies).
    const slug =
      (pdfData.registrations[0]?.participantName || 'ingresso')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'ingresso';

    return { buffer, fileName: `ingresso-${slug}.pdf` };
  }

  /**
   * Mapeia a inscrição normalizada (`findOne`) para o contrato `TicketPdfData`
   * de UM participante. Tolera os dois shapes possíveis (snapshot imutável e
   * build ao vivo legado), espelhando a mesma normalização do modal de
   * visualização no front. Preços já estão em CENTAVOS no snapshot (mesma
   * unidade que o template do PDF espera).
   */
  private buildSingleTicketPdfData(reg: any): TicketPdfData {
    const snapshotParticipant = reg?.participant ?? null;
    const user = reg?.user ?? reg?.buyer ?? null;

    const participantName =
      snapshotParticipant?.name ||
      (user
        ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.fullName
        : '') ||
      'Participante';

    const categoryName =
      reg?.ticket?.category?.name ??
      reg?.modalities?.[0]?.modality?.category?.name ??
      '';
    const baseTicketName =
      reg?.ticket?.name ?? reg?.modalities?.[0]?.modality?.name ?? '';
    // Cabeçalho do PDF: categoria em destaque (ou "Ingresso avulso" quando o
    // ingresso não tem categoria) e o nome do ingresso abaixo.
    const ticketCategory = categoryName || 'Ingresso avulso';
    const ticketName = baseTicketName || '—';

    // Produtos: snapshot traz os campos no topo (name/images/selectedVariation/
    // unitPrice); o legado (findOneLive) aninha em product/variation. Detecta
    // pelo shape, igual ao modal de visualização.
    const products: TicketPdfProduct[] = (reg?.products ?? []).map(
      (item: any): TicketPdfProduct => {
        const isSnapshot =
          item?.name !== undefined ||
          item?.images !== undefined ||
          item?.selectedVariation !== undefined;

        if (isSnapshot) {
          const images = Array.isArray(item.images) ? item.images : [];
          const imageUrl = images[item.primaryImageIndex ?? 0] ?? images[0];
          // Incluso = flag REAL (item.isIncludedInTicket, exposto pelo findOne), não
          // "price === 0" (produto avulso grátis também daria 0). Preço efetivo pago =
          // preço da variação comprada (Opção B, já = unitPrice) com fallback p/
          // unitPrice/basePrice. Incluso → 0 (template mostra só "Incluso").
          const isIncluded = item.isIncludedInTicket === true;
          const unitPrice = isIncluded
            ? 0
            : (item.selectedVariation?.price ?? item.unitPrice ?? item.basePrice ?? 0);
          return {
            name: item.name || 'Produto',
            price: unitPrice,
            variationName: item.selectedVariation?.name ?? undefined,
            imageUrl: imageUrl ?? undefined,
            isIncluded,
          };
        }

        // Build ao vivo (findOneLive): incluso vem de product.isIncludedInTicket; preço
        // efetivo = variation.price (Opção B) com fallback p/ unitPrice/totalPrice.
        const isIncluded = item.product?.isIncludedInTicket === true;
        const price = isIncluded
          ? 0
          : (item.variation?.price ?? item.unitPrice ?? item.totalPrice ?? 0);
        return {
          name: item.product?.name || 'Produto',
          price,
          variationName: item.variation?.name ?? item.variationName ?? undefined,
          imageUrl: item.product?.image ?? undefined,
          isIncluded,
        };
      },
    )
    // "Sem interesse" = opt-out de produto opcional → não exibir no PDF do ingresso
    // (mesma regra do recibo/modal de pedido).
    .filter((p: TicketPdfProduct) => p.variationName !== 'Sem interesse');

    const questionAnswers = (reg?.questionAnswers ?? []).map((qa: any) => ({
      question: qa?.question?.question ?? qa?.question ?? '',
      answer: formatPdfAnswer(qa?.answer),
    }));

    const eventSnap = reg?.event ?? {};
    const organizationName =
      eventSnap?.organization?.tradeName ||
      eventSnap?.organization?.name ||
      '';

    const registration: TicketPdfRegistration = {
      index: 1,
      registrationId: reg?.id ?? '',
      qrCode: reg?.qrCode ?? reg?.id,
      participantName,
      ticketCategory,
      ticketName,
      email: snapshotParticipant?.email ?? user?.email ?? undefined,
      cpf:
        snapshotParticipant?.documentNumber ?? user?.documentNumber ?? undefined,
      country:
        snapshotParticipant?.country ??
        user?.country ??
        user?.nationality ??
        null,
      documentType:
        snapshotParticipant?.documentType ?? user?.documentType ?? null,
      dateOfBirth: snapshotParticipant?.birthDate ?? user?.dateOfBirth ?? null,
      phone: snapshotParticipant?.phone ?? user?.phone ?? undefined,
      gender: snapshotParticipant?.gender ?? user?.gender ?? undefined,
      questionAnswers,
      products,
    };

    return {
      orderId: reg?.id ?? '',
      orderNumber: String(reg?.id ?? '').slice(0, 8).toUpperCase(),
      issuedAt: new Date(),
      event: {
        name: eventSnap?.name ?? '',
        date: eventSnap?.eventDate ?? new Date(),
        organization: organizationName,
        location: formatSnapshotLocation(eventSnap?.location) || '—',
        participantCount: 1,
      },
      registrations: [registration],
    };
  }

  /**
   * Build "ao vivo" (joins atuais) — usado APENAS como fallback do findOne quando a
   * inscrição não possui receiptSnapshot (legada ou ainda não paga).
   */
  private async findOneLive(id: string, userId: string) {
    const prismaRead = this.prisma.getReadClient();

    const registration = await prismaRead.registration.findUnique({
      where: { id },
      include: {
        event: {
          include: {
            organization: {
              // Contato (email/phone) fora do contrato de rota de usuário.
              select: {
                id: true,
                name: true,
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
                        variations: { orderBy: { sortOrder: 'asc' } },
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
                variations: { orderBy: { sortOrder: 'asc' } },
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
                sortOrder: v.sortOrder,
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
        const variationBase = snap?.selectedVariation ?? (rp.variation ? {
          id: rp.variation.id, name: rp.variation.name, price: rp.variation.price,
        } : null);
        // `price` da variação exibida = valor EFETIVAMENTE cobrado por unidade
        // (rp.unitPrice, centavos), não o preço cru de catálogo da variação.
        // Cobre o fallback p/ basePrice quando a variação tem price 0; produto
        // incluso fica 0 (grátis), coerente. (Opção B — ver sessão 2026-06-15.)
        const variationData = variationBase
          ? { ...variationBase, price: rp.unitPrice }
          : null;
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
              // Contato (email/phone) fora do contrato de rota de usuário.
              select: {
                id: true,
                name: true,
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
              select: { id: true, code: true, type: true, value: true, applyToProducts: true },
            },
            voucher: {
              select: { id: true, code: true, name: true, status: true, applyToProducts: true },
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
        const variationBase = snap?.selectedVariation ?? (rp.variation ? {
          id: rp.variation.id,
          name: rp.variation.name,
          price: rp.variation.price,
        } : null);
        // `price` da variação exibida = valor EFETIVAMENTE cobrado por unidade
        // (rp.unitPrice, centavos), não o catálogo cru (price 0 c/ fallback basePrice).
        // Incluso → unitPrice 0 (grátis), coerente. (Opção B — ver sessão 2026-06-15.)
        const variationData = variationBase
          ? { ...variationBase, price: rp.unitPrice }
          : null;
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
          // Flag atual do cupom (este bloco já lê live). Para a verdade histórica
          // congelada na compra, ver GET /orders/:id/details (snapshot + metadata).
          applyToProducts: reg.order.coupon.applyToProducts ?? false,
        } : null,
        voucher: reg.order.voucher ? {
          id: reg.order.voucher.id,
          code: reg.order.voucher.code,
          name: reg.order.voucher.name,
          status: reg.order.voucher.status,
          // Flag atual (live). Verdade histórica em GET /orders/:id/details.
          applyToProducts: reg.order.voucher.applyToProducts ?? false,
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

    // Captura nome da variacao anterior antes do update pro email.
    const previousVariationId = regProduct?.variationId ?? null;

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

    // Email best-effort — log warn em caso de falha, nao aborta a operacao.
    void this.sendVariationChangedEmail({
      registrationId,
      productId,
      variationId,
      previousVariationId,
    }).catch((err) => {
      this.logger.warn(`Variation change email failed for reg ${registrationId}: ${err?.message ?? err}`);
    });

    return { message: 'Variação atualizada com sucesso' };
  }

  private async sendVariationChangedEmail(args: {
    registrationId: string;
    productId: string;
    variationId: string;
    previousVariationId: string | null;
  }) {
    const prismaRead = this.prisma.getReadClient();

    // Busca dados pro email — participante, evento, ingresso, produto, variacoes.
    const reg = await prismaRead.registration.findUnique({
      where: { id: args.registrationId },
      select: {
        participantEmail: true,
        user: { select: { email: true } },
        order: { select: { event: { select: { name: true } } } },
        tickets: {
          select: {
            ticket: {
              select: {
                name: true,
                category: { select: { name: true } },
              },
            },
          },
          take: 1,
        },
      },
    });
    const recipient = reg?.participantEmail || reg?.user?.email;
    if (!recipient) return;

    const product = await prismaRead.product.findUnique({
      where: { id: args.productId },
      select: { name: true, image: true, images: true, primaryImageIndex: true },
    });
    if (!product) return;

    const primaryImage = (() => {
      const images = (product.images ?? []) as string[];
      const idx = product.primaryImageIndex ?? 0;
      return images[idx] || product.image || images[0] || null;
    })();

    const [prevVar, newVar] = await Promise.all([
      args.previousVariationId
        ? prismaRead.productVariation.findUnique({
            where: { id: args.previousVariationId },
            select: { name: true },
          })
        : Promise.resolve(null),
      prismaRead.productVariation.findUnique({
        where: { id: args.variationId },
        select: { name: true },
      }),
    ]);

    const ticket = reg.tickets[0]?.ticket;
    const ticketName = ticket
      ? ticket.category?.name && ticket.category.name !== ticket.name
        ? `${ticket.name} · ${ticket.category.name}`
        : ticket.name
      : '';

    await this.emailService.sendProductVariationChanged({
      email: recipient,
      productName: product.name,
      productImageUrl: primaryImage,
      previousVariationName: prevVar?.name ?? '',
      newVariationName: newVar?.name ?? '',
      eventName: reg.order?.event?.name ?? '',
      ticketName,
      changedAt: new Date(),
    });
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

    // Verificar lista de documentos se habilitada (CPF + estrangeiros).
    if (coupon.cpfListStatus === 'ENABLED') {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { documentType: true, documentNumberClean: true },
      });

      if (!user || !user.documentNumberClean) {
        throw new BadRequestException('Documento do usuário é obrigatório para este cupom');
      }

      if (!isDocumentInList(user, coupon.documentList, coupon.cpfList)) {
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

    // Verificar lista de documentos se habilitada (CPF + estrangeiros).
    if (voucher.cpfListStatus === 'ENABLED') {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { documentType: true, documentNumberClean: true },
      });

      if (!user || !user.documentNumberClean) {
        throw new BadRequestException('Documento do usuário é obrigatório para este voucher');
      }

      if (!isDocumentInList(user, voucher.documentList, voucher.cpfList)) {
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

