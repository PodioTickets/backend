import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrganizerMemberAccessService } from '../organizations/organizer-member-access.service';
import { PaymentMethod, PaymentStatus, WithdrawalStatus } from '@prisma/client';

// Dias de retenção antes de liberar o saldo para saque
const RETENTION_DAYS: Record<string, number> = {
  [PaymentMethod.PIX]: 1,
  [PaymentMethod.CREDIT_CARD]: 30,
  [PaymentMethod.BOLETO]: 3,
  [PaymentMethod.CRYPTO]: 30,
};

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getReleaseDate(paymentDate: Date, method: string): Date {
  const days = RETENTION_DAYS[method] ?? 30;
  return addDays(paymentDate, days);
}

function isInstallment(metadata: any): boolean {
  return !!(metadata?.creditCard?.installments && metadata.creditCard.installments > 1);
}

@Injectable()
export class RepasseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizerMemberAccess: OrganizerMemberAccessService,
  ) {}

  // ─── Acesso ──────────────────────────────────────────────────────────────

  private async assertAccess(userId: string, eventId: string) {
    await this.organizerMemberAccess.assertCanAccessEvent(userId, eventId, 'financial');
  }

  private async assertAdminOrOwner(userId: string, eventId: string) {
    // Reutiliza a verificação de financial — em produção pode adicionar role ADMIN
    await this.organizerMemberAccess.assertCanAccessEvent(userId, eventId, 'financial');
  }

  // ─── Dados base ──────────────────────────────────────────────────────────

  private async loadEventConfig(eventId: string, prisma: any) {
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, organizerFeeRate: true, retentionRate: true },
    });
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  private async loadPaidOrders(eventId: string, prisma: any) {
    return prisma.order.findMany({
      where: {
        eventId,
        payment: { status: PaymentStatus.PAID },
      },
      include: {
        payment: true,
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            documentNumber: true,
          },
        },
        registrations: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async loadAudit(eventId: string, prisma: any) {
    return prisma.eventAudit.findUnique({ where: { eventId } });
  }

  private async loadWithdrawals(eventId: string, prisma: any) {
    return prisma.eventWithdrawal.findMany({
      where: { eventId, status: { not: WithdrawalStatus.CANCELLED } },
    });
  }

  /**
   * Calcula o breakdown financeiro completo de um evento.
   * Retorna os valores em centavos separados por categoria.
   */
  private calcBreakdown(
    orders: any[],
    retentionRate: number,
    isAudited: boolean,
    completedWithdrawals: any[],
  ) {
    let grossRevenue = 0;
    let pendingRelease = 0;   // dentro do prazo de retenção (24h/30d) — ainda não liberado
    let awaitingAudit = 0;    // 10% retido aguardando auditoria
    let installmentsToReceive = 0; // parcelas futuras não vencidas
    let lastInstallmentRetained = 0; // última parcela retida até auditoria
    let releasedAndAvailable = 0; // pronto para saque

    const now = new Date();

    for (const order of orders) {
      const payment = order.payment;
      if (!payment?.paymentDate) continue;

      const finalAmount: number = order.finalAmount ?? 0;
      grossRevenue += finalAmount;

      const metadata = payment.metadata as any;
      const method: string = payment.method;
      const paymentDate = new Date(payment.paymentDate);
      const releaseDate = getReleaseDate(paymentDate, method);
      const released = releaseDate <= now;

      if (isInstallment(metadata)) {
        // ── Parcelado ──────────────────────────────────────────────────────
        const installmentsCount: number = metadata.creditCard.installments;
        const installmentValue = Math.round(finalAmount / installmentsCount);
        const lastInstallmentValue = finalAmount - installmentValue * (installmentsCount - 1);

        for (let i = 0; i < installmentsCount; i++) {
          const dueDate = addDays(paymentDate, 30 * (i + 1));
          const isLast = i === installmentsCount - 1;
          const amount = isLast ? lastInstallmentValue : installmentValue;

          if (dueDate > now) {
            installmentsToReceive += amount;
          } else if (isLast && !isAudited) {
            lastInstallmentRetained += amount;
            awaitingAudit += amount;
          } else {
            releasedAndAvailable += amount;
          }
        }
      } else {
        // ── À vista (PIX / cartão) ─────────────────────────────────────────
        if (!released) {
          pendingRelease += finalAmount;
        } else if (!isAudited) {
          const retained = Math.round(finalAmount * retentionRate);
          awaitingAudit += retained;
          releasedAndAvailable += finalAmount - retained;
        } else {
          releasedAndAvailable += finalAmount;
        }
      }
    }

    const totalWithdrawn = completedWithdrawals.reduce(
      (s, w) => s + (w.amount ?? 0),
      0,
    );

    // O que sobra para sacar agora
    const availableBalance = Math.max(0, releasedAndAvailable - totalWithdrawn);

    return {
      grossRevenue,
      pendingRelease,
      awaitingAudit,
      installmentsToReceive,
      releasedAndAvailable,
      totalWithdrawn,
      availableBalance,
    };
  }

  // ─── Endpoints ───────────────────────────────────────────────────────────

  async getSummary(userId: string, eventId: string) {
    await this.assertAccess(userId, eventId);

    const prismaRead = this.prisma.getReadClient();
    const [event, orders, audit, withdrawals] = await Promise.all([
      this.loadEventConfig(eventId, prismaRead),
      this.loadPaidOrders(eventId, prismaRead),
      this.loadAudit(eventId, prismaRead),
      this.loadWithdrawals(eventId, prismaRead),
    ]);

    const completedWithdrawals = withdrawals.filter(
      (w: any) => w.status === WithdrawalStatus.COMPLETED,
    );

    const breakdown = this.calcBreakdown(
      orders,
      event.retentionRate,
      !!audit,
      completedWithdrawals,
    );

    // Estornos
    const refundedOrders = await prismaRead.order.count({
      where: { eventId, payment: { status: PaymentStatus.REFUNDED } },
    });

    return {
      message: 'Repasse summary fetched successfully',
      data: {
        summary: {
          ...breakdown,
          refundedOrders,
          isAudited: !!audit,
          auditedAt: audit?.createdAt ?? null,
          retentionReleased: audit?.retentionReleased ?? 0,
          organizerFeeRate: event.organizerFeeRate,
          retentionRate: event.retentionRate,
        },
      },
    };
  }

  async getPendingReleases(userId: string, eventId: string, page: number, limit: number) {
    await this.assertAccess(userId, eventId);

    const prismaRead = this.prisma.getReadClient();
    const [event, orders, audit] = await Promise.all([
      this.loadEventConfig(eventId, prismaRead),
      this.loadPaidOrders(eventId, prismaRead),
      this.loadAudit(eventId, prismaRead),
    ]);

    const now = new Date();
    const isAudited = !!audit;
    const items: any[] = [];

    for (const order of orders) {
      const payment = order.payment;
      if (!payment?.paymentDate) continue;

      const paymentDate = new Date(payment.paymentDate);
      const releaseDate = getReleaseDate(paymentDate, payment.method);
      const released = releaseDate <= now;
      const metadata = payment.metadata as any;

      if (!released) {
        // Aguardando prazo (24h pix / 30d cartão)
        items.push({
          orderId: order.id,
          paymentId: payment.id,
          transactionId: payment.transactionId,
          type: 'AWAITING_RELEASE',
          amount: order.finalAmount,
          retainedAmount: null,
          paymentMethod: payment.method,
          purchaseDate: order.createdAt,
          paymentDate: payment.paymentDate,
          releaseDate,
          daysUntilRelease: Math.ceil((releaseDate.getTime() - now.getTime()) / 86400000),
          buyer: order.user,
        });
      } else if (!isAudited) {
        // Já liberado mas 10% retido aguardando auditoria (ou última parcela)
        let retainedAmount: number;
        if (isInstallment(metadata)) {
          const count = metadata.creditCard.installments;
          const installmentValue = Math.round(order.finalAmount / count);
          retainedAmount = order.finalAmount - installmentValue * (count - 1); // última parcela
        } else {
          retainedAmount = Math.round(order.finalAmount * event.retentionRate);
        }

        items.push({
          orderId: order.id,
          paymentId: payment.id,
          transactionId: payment.transactionId,
          type: 'AWAITING_AUDIT',
          amount: order.finalAmount,
          retainedAmount,
          paymentMethod: payment.method,
          purchaseDate: order.createdAt,
          paymentDate: payment.paymentDate,
          releaseDate,
          daysUntilRelease: 0,
          buyer: order.user,
        });
      }
    }

    const total = items.length;
    const totalRetained = items
      .filter((i) => i.type === 'AWAITING_AUDIT')
      .reduce((s, i) => s + (i.retainedAmount ?? 0), 0);
    const totalPendingRelease = items
      .filter((i) => i.type === 'AWAITING_RELEASE')
      .reduce((s, i) => s + i.amount, 0);

    const skip = (page - 1) * limit;
    return {
      message: 'Pending releases fetched successfully',
      data: {
        items: items.slice(skip, skip + limit),
        totalRetained,
        totalPendingRelease,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  async getInstallments(userId: string, eventId: string, page: number, limit: number) {
    await this.assertAccess(userId, eventId);

    const prismaRead = this.prisma.getReadClient();
    const [audit, orders] = await Promise.all([
      this.loadAudit(eventId, prismaRead),
      this.loadPaidOrders(eventId, prismaRead),
    ]);

    const now = new Date();
    const isAudited = !!audit;
    const items: any[] = [];
    let totalPending = 0;

    for (const order of orders) {
      const payment = order.payment;
      if (!payment?.paymentDate) continue;
      const metadata = payment.metadata as any;
      if (!isInstallment(metadata)) continue;

      const count: number = metadata.creditCard.installments;
      const paymentDate = new Date(payment.paymentDate);
      const installmentValue = Math.round(order.finalAmount / count);
      const lastInstallmentValue = order.finalAmount - installmentValue * (count - 1);

      for (let i = 0; i < count; i++) {
        const dueDate = addDays(paymentDate, 30 * (i + 1));
        const isLast = i === count - 1;
        const amount = isLast ? lastInstallmentValue : installmentValue;

        if (dueDate > now) {
          const item: any = {
            id: `${payment.id}-installment-${i + 1}`,
            orderId: order.id,
            paymentId: payment.id,
            installmentNumber: i + 1,
            totalInstallments: count,
            amount,
            dueDate,
            isLastInstallment: isLast,
            retainedUntilAudit: isLast && !isAudited,
            buyer: order.user,
          };
          items.push(item);
          totalPending += amount;
        }
      }
    }

    items.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

    const total = items.length;
    const skip = (page - 1) * limit;

    return {
      message: 'Installments fetched successfully',
      data: {
        items: items.slice(skip, skip + limit),
        totalPending,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  async getWithdrawals(userId: string, eventId: string, page: number, limit: number) {
    await this.assertAccess(userId, eventId);

    const prismaRead = this.prisma.getReadClient();
    const skip = (page - 1) * limit;

    const [withdrawals, total] = await Promise.all([
      prismaRead.eventWithdrawal.findMany({
        where: { eventId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          requestedBy: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      }),
      prismaRead.eventWithdrawal.count({ where: { eventId } }),
    ]);

    const totalCompleted = await prismaRead.eventWithdrawal.aggregate({
      where: { eventId, status: WithdrawalStatus.COMPLETED },
      _sum: { netAmount: true },
    });

    return {
      message: 'Withdrawals fetched successfully',
      data: {
        withdrawals,
        totalNetWithdrawn: totalCompleted._sum.netAmount ?? 0,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  async requestWithdrawal(userId: string, eventId: string, amount: number) {
    await this.assertAccess(userId, eventId);

    if (!amount || amount <= 0) {
      throw new BadRequestException('Amount must be greater than zero');
    }

    const prismaRead = this.prisma.getReadClient();
    const prismaWrite = this.prisma.getWriteClient();

    const [event, orders, audit, withdrawals] = await Promise.all([
      this.loadEventConfig(eventId, prismaRead),
      this.loadPaidOrders(eventId, prismaRead),
      this.loadAudit(eventId, prismaRead),
      this.loadWithdrawals(eventId, prismaRead),
    ]);

    const completedWithdrawals = withdrawals.filter(
      (w: any) => w.status === WithdrawalStatus.COMPLETED,
    );

    const { availableBalance } = this.calcBreakdown(
      orders,
      event.retentionRate,
      !!audit,
      completedWithdrawals,
    );

    if (amount > availableBalance) {
      throw new BadRequestException(
        `Insufficient available balance. Available: ${availableBalance} cents, requested: ${amount} cents`,
      );
    }

    const feeAmount = Math.round(amount * event.organizerFeeRate);
    const netAmount = amount - feeAmount;

    const withdrawal = await prismaWrite.eventWithdrawal.create({
      data: {
        eventId,
        requestedById: userId,
        amount,
        feeRate: event.organizerFeeRate,
        feeAmount,
        netAmount,
        status: WithdrawalStatus.PENDING,
      },
    });

    return {
      message: 'Withdrawal requested successfully',
      data: { withdrawal },
    };
  }

  async completeWithdrawal(adminUserId: string, eventId: string, withdrawalId: string) {
    await this.assertAdminOrOwner(adminUserId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const withdrawal = await prismaWrite.eventWithdrawal.findUnique({
      where: { id: withdrawalId },
    });

    if (!withdrawal || withdrawal.eventId !== eventId) {
      throw new NotFoundException('Withdrawal not found');
    }
    if (withdrawal.status !== WithdrawalStatus.PENDING) {
      throw new BadRequestException('Withdrawal is not in PENDING status');
    }

    const updated = await prismaWrite.eventWithdrawal.update({
      where: { id: withdrawalId },
      data: { status: WithdrawalStatus.COMPLETED, completedAt: new Date() },
    });

    return { message: 'Withdrawal completed successfully', data: { withdrawal: updated } };
  }

  async cancelWithdrawal(adminUserId: string, eventId: string, withdrawalId: string) {
    await this.assertAdminOrOwner(adminUserId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const withdrawal = await prismaWrite.eventWithdrawal.findUnique({
      where: { id: withdrawalId },
    });

    if (!withdrawal || withdrawal.eventId !== eventId) {
      throw new NotFoundException('Withdrawal not found');
    }
    if (withdrawal.status !== WithdrawalStatus.PENDING) {
      throw new BadRequestException('Only PENDING withdrawals can be cancelled');
    }

    const updated = await prismaWrite.eventWithdrawal.update({
      where: { id: withdrawalId },
      data: { status: WithdrawalStatus.CANCELLED },
    });

    return { message: 'Withdrawal cancelled', data: { withdrawal: updated } };
  }

  async getRefunded(userId: string, eventId: string, page: number, limit: number) {
    await this.assertAccess(userId, eventId);

    const prismaRead = this.prisma.getReadClient();
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      prismaRead.order.findMany({
        where: { eventId, payment: { status: PaymentStatus.REFUNDED } },
        include: {
          payment: true,
          user: {
            select: {
              id: true, firstName: true, lastName: true,
              email: true, avatarUrl: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prismaRead.order.count({
        where: { eventId, payment: { status: PaymentStatus.REFUNDED } },
      }),
    ]);

    const totalAmount = orders.reduce((s: number, o: any) => s + (o.finalAmount ?? 0), 0);

    return {
      message: 'Refunded orders fetched successfully',
      data: {
        items: orders.map((o: any) => ({
          orderId: o.id,
          paymentId: o.payment?.id,
          amount: o.finalAmount,
          paymentMethod: o.payment?.method,
          purchaseDate: o.createdAt,
          refundDate: o.payment?.updatedAt ?? o.payment?.paymentDate,
          buyer: o.user,
        })),
        totalAmount,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  async getAuditStatus(userId: string, eventId: string) {
    await this.assertAccess(userId, eventId);

    const prismaRead = this.prisma.getReadClient();
    const audit = await this.loadAudit(eventId, prismaRead);

    return {
      message: 'Audit status fetched successfully',
      data: {
        isAudited: !!audit,
        audit: audit ?? null,
      },
    };
  }

  async auditEvent(adminUserId: string, eventId: string, notes?: string) {
    await this.assertAdminOrOwner(adminUserId, eventId);

    const prismaRead = this.prisma.getReadClient();
    const prismaWrite = this.prisma.getWriteClient();

    const existing = await this.loadAudit(eventId, prismaRead);
    if (existing) throw new BadRequestException('Event has already been audited');

    const [event, orders, withdrawals] = await Promise.all([
      this.loadEventConfig(eventId, prismaRead),
      this.loadPaidOrders(eventId, prismaRead),
      this.loadWithdrawals(eventId, prismaRead),
    ]);

    const completedWithdrawals = withdrawals.filter(
      (w: any) => w.status === WithdrawalStatus.COMPLETED,
    );

    const { awaitingAudit } = this.calcBreakdown(
      orders,
      event.retentionRate,
      false,
      completedWithdrawals,
    );

    const audit = await prismaWrite.eventAudit.create({
      data: {
        eventId,
        auditedById: adminUserId,
        retentionReleased: awaitingAudit,
        notes: notes ?? null,
      },
    });

    return {
      message: 'Event audited successfully',
      data: { audit },
    };
  }
}
