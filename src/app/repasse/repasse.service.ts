import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrganizerMemberAccessService } from '../organizations/organizer-member-access.service';
import { EmailService } from '../../common/services/email.service';
import { PaymentMethod, PaymentStatus, WithdrawalStatus } from '@prisma/client';

// Prazo (dias) até que os 90% sejam liberados para saldo disponível
const RETENTION_DAYS: Record<string, number> = {
  [PaymentMethod.PIX]: 1,
  [PaymentMethod.CREDIT_CARD]: 31,
  [PaymentMethod.BOLETO]: 3,
  [PaymentMethod.CRYPTO]: 30,
};

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getReleaseDate(paymentDate: Date, method: string): Date {
  return addDays(paymentDate, RETENTION_DAYS[method] ?? 31);
}

/**
 * Returns the reference "now" used for all retention/release date comparisons.
 * Set REPASSE_TIME_OFFSET_DAYS (integer) to simulate time passing without
 * waiting real days. Only honoured when NODE_ENV !== 'production'.
 * Example: REPASSE_TIME_OFFSET_DAYS=35 makes every payment appear 35 days older.
 */
function getNow(): Date {
  if (process.env.NODE_ENV === 'production') return new Date();
  const offset = parseInt(process.env.REPASSE_TIME_OFFSET_DAYS ?? '0', 10);
  if (!offset || isNaN(offset)) return new Date();
  return addDays(new Date(), offset);
}

function isInstallment(metadata: any): boolean {
  return !!(metadata?.creditCard?.installments && metadata.creditCard.installments > 1);
}

@Injectable()
export class RepasseService {
  private readonly logger = new Logger(RepasseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizerMemberAccess: OrganizerMemberAccessService,
    private readonly emailService: EmailService,
  ) {}

  // ─── Email helpers ───────────────────────────────────────────────────────

  private formatBRL(cents: number): string {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
  }

  private formatDateBR(date: Date): string {
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  private formatDateTimeBR(date: Date): string {
    const d = date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
    const t = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `${d} às ${t}`;
  }

  private async loadEventWithOrg(eventId: string, prisma: any) {
    return prisma.event.findUnique({
      where: { id: eventId },
      select: {
        name: true,
        organization: {
          select: {
            name: true,
            email: true,
            pix: true,
            bankName: true,
            account: true,
          },
        },
      },
    });
  }

  // ─── Acesso ──────────────────────────────────────────────────────────────

  private async assertAccess(userId: string, eventId: string) {
    await this.organizerMemberAccess.assertCanAccessEvent(userId, eventId, 'financial');
  }

  private async assertAdminOrOwner(userId: string, eventId: string) {
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

  private async loadRefundedOrders(eventId: string, prisma: any) {
    return prisma.order.findMany({
      where: {
        eventId,
        payment: { status: PaymentStatus.REFUNDED },
      },
      include: { payment: true },
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

  // ─── Breakdown ───────────────────────────────────────────────────────────

  /**
   * Calcula o breakdown financeiro do evento conforme repasse-v2.
   *
   * Buckets:
   *   aguardandoLiberacao — pedidos à vista ainda dentro do prazo de retenção (100%)
   *   valorRetido         — 10% de pedidos à vista fora do prazo, aguardando auditoria
   *   parceladosAReceber  — parcelas futuras (90%/N) + 10% retido de parcelados (aguarda auditoria)
   *   saldoDisponivel     — montante já liberado; pode ser negativo em caso de estorno
   *
   * Prioridade de dedução por estorno (non-installment):
   *   1. 10% sai de aguardandoLiberacao + valorRetido
   *   2. 90% (+ deficit do 10%) sai de saldoDisponivel
   *   3. Se saldo insuficiente, recupera o deficit do aguardando restante
   *   4. Se ainda insuficiente, saldoDisponivel fica negativo
   *
   * Prioridade de dedução por estorno (installment):
   *   1. Deduz de parceladosAReceber primeiro
   *   2. Remainder vai de saldoDisponivel (pode ficar negativo)
   *
   * @param committedWithdrawals — COMPLETED + PENDING withdrawals (both reduce saldoParaSaque)
   */
  private calcBreakdown(
    paidOrders: any[],
    refundedOrders: any[],
    retentionRate: number,
    isAudited: boolean,
    committedWithdrawals: any[],
    organizerFeeRate: number,
  ) {
    const now = getNow();

    let aguardandoLiberacao = 0;
    let valorRetido = 0;
    let parceladosAReceber = 0;
    let saldoDisponivel = 0;
    let grossRevenue = 0;

    // ── Contribuições positivas ─────────────────────────────────────────────
    for (const order of paidOrders) {
      const payment = order.payment;
      if (!payment?.paymentDate) continue;

      const gross: number = order.finalAmount ?? 0;
      grossRevenue += gross;
      // Deduct organizer fee upfront before distributing into buckets (spec step 3)
      const orgNet = Math.round(gross * (1 - organizerFeeRate));
      const paymentDate = new Date(payment.paymentDate);
      const metadata = payment.metadata as any;

      if (isInstallment(metadata)) {
        // 10% retido separado; 90% dividido em N parcelas de 31 dias cada
        const count: number = metadata.creditCard.installments;
        const retained = Math.round(orgNet * retentionRate);
        const distributable = orgNet - retained;
        const baseInstallment = Math.floor(distributable / count);
        const lastExtra = distributable - baseInstallment * count;

        for (let i = 0; i < count; i++) {
          const dueDate = addDays(paymentDate, 31 * (i + 1));
          const amount = baseInstallment + (i === count - 1 ? lastExtra : 0);
          if (dueDate > now) {
            parceladosAReceber += amount;
          } else {
            saldoDisponivel += amount;
          }
        }

        if (isAudited) {
          saldoDisponivel += retained;
        } else {
          parceladosAReceber += retained;
        }
      } else {
        const releaseDate = getReleaseDate(paymentDate, payment.method);
        if (releaseDate > now) {
          aguardandoLiberacao += orgNet;
        } else if (!isAudited) {
          const retained = Math.round(orgNet * retentionRate);
          valorRetido += retained;
          saldoDisponivel += orgNet - retained;
        } else {
          saldoDisponivel += orgNet;
        }
      }
    }

    // ── Deduções por estorno ────────────────────────────────────────────────
    for (const order of refundedOrders) {
      const payment = order.payment;
      if (!payment) continue;

      // Same fee deduction as positive side — spec: "pegamos o valor que o organizador iria receber"
      const orgNet = Math.round((order.finalAmount ?? 0) * (1 - organizerFeeRate));
      const metadata = payment.metadata as any;

      if (isInstallment(metadata)) {
        // Parcelado: deduz de parceladosAReceber primeiro, depois de saldo
        const fromParcelados = Math.min(orgNet, Math.max(0, parceladosAReceber));
        parceladosAReceber -= fromParcelados;
        saldoDisponivel -= orgNet - fromParcelados;
      } else {
        const retained = Math.round(orgNet * retentionRate); // 10%
        const toRelease = orgNet - retained;                  // 90%

        // 10% sai de aguardandoLiberacao (prioridade) ou valorRetido
        const aguardandoDisp = Math.max(0, aguardandoLiberacao) + Math.max(0, valorRetido);
        const fromAguardando = Math.min(retained, aguardandoDisp);
        const deficit10 = retained - fromAguardando;

        const fromAL = Math.min(fromAguardando, Math.max(0, aguardandoLiberacao));
        aguardandoLiberacao -= fromAL;
        valorRetido -= fromAguardando - fromAL;

        // 90% + deficit do 10% sai de saldo (pode ficar negativo)
        saldoDisponivel -= toRelease + deficit10;

        // Se saldo ficou negativo, recupera do aguardando restante
        if (saldoDisponivel < 0) {
          const remainingAg = Math.max(0, aguardandoLiberacao) + Math.max(0, valorRetido);
          const recovery = Math.min(Math.abs(saldoDisponivel), remainingAg);
          saldoDisponivel += recovery;
          const recFromAL = Math.min(recovery, Math.max(0, aguardandoLiberacao));
          aguardandoLiberacao -= recFromAL;
          valorRetido -= recovery - recFromAL;
          // saldo permanece negativo se recovery < deficit (conforme spec)
        }
      }
    }

    // Use netAmount so both old records (amount=gross, netAmount=net) and new records
    // (amount=netAmount, feeAmount=0) are subtracted correctly from the net saldoDisponivel
    const totalWithdrawn = committedWithdrawals.reduce((s, w) => s + (w.netAmount ?? w.amount ?? 0), 0);
    const saldoParaSaque = saldoDisponivel - totalWithdrawn;

    // Fix 2: expõe a composição interna do aguardandoLiberacao (10% retido + 90% em liberação)
    const aguardandoFinal = Math.max(0, aguardandoLiberacao);
    const aguardandoRetido = Math.round(aguardandoFinal * retentionRate);
    const aguardandoEmLiberacao = aguardandoFinal - aguardandoRetido;

    return {
      grossRevenue,
      aguardandoLiberacao: aguardandoFinal,
      aguardandoLiberacaoRetido: aguardandoRetido,
      aguardandoLiberacaoEmLiberacao: aguardandoEmLiberacao,
      valorRetido: Math.max(0, valorRetido),
      parceladosAReceber: Math.max(0, parceladosAReceber),
      saldoDisponivel,
      totalWithdrawn,
      saldoParaSaque,
    };
  }

  // ─── Endpoints ───────────────────────────────────────────────────────────

  async getSummary(userId: string, eventId: string) {
    await this.assertAccess(userId, eventId);

    const prismaRead = this.prisma.getReadClient();
    const [event, paidOrders, refundedOrders, audit, withdrawals] = await Promise.all([
      this.loadEventConfig(eventId, prismaRead),
      this.loadPaidOrders(eventId, prismaRead),
      this.loadRefundedOrders(eventId, prismaRead),
      this.loadAudit(eventId, prismaRead),
      this.loadWithdrawals(eventId, prismaRead),
    ]);

    // PENDING + COMPLETED both reduce saldoParaSaque to prevent double-spend
    const committedWithdrawals = withdrawals.filter(
      (w: any) => w.status === WithdrawalStatus.COMPLETED || w.status === WithdrawalStatus.PENDING,
    );
    const pendingWithdrawalsAmount = withdrawals
      .filter((w: any) => w.status === WithdrawalStatus.PENDING)
      .reduce((s: number, w: any) => s + (w.netAmount ?? w.amount ?? 0), 0);

    const breakdown = this.calcBreakdown(
      paidOrders,
      refundedOrders,
      event.retentionRate,
      !!audit,
      committedWithdrawals,
      event.organizerFeeRate,
    );

    return {
      message: 'Repasse summary fetched successfully',
      data: {
        summary: {
          ...breakdown,
          pendingWithdrawalsAmount,
          refundedOrders: refundedOrders.length,
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

    const now = getNow();
    const isAudited = !!audit;
    const items: any[] = [];

    for (const order of orders) {
      const payment = order.payment;
      if (!payment?.paymentDate) continue;

      const metadata = payment.metadata as any;
      // Pedidos parcelados ficam em getInstallments; aqui só à vista
      if (isInstallment(metadata)) continue;

      const paymentDate = new Date(payment.paymentDate);
      const releaseDate = getReleaseDate(paymentDate, payment.method);
      const released = releaseDate <= now;

      const netAmount = Math.round(order.finalAmount * (1 - event.organizerFeeRate));

      if (!released) {
        items.push({
          orderId: order.id,
          paymentId: payment.id,
          transactionId: payment.transactionId,
          type: 'AGUARDANDO_LIBERACAO',
          amount: netAmount,
          retainedAmount: null,
          paymentMethod: payment.method,
          purchaseDate: order.createdAt,
          paymentDate: payment.paymentDate,
          releaseDate,
          daysUntilRelease: Math.ceil((releaseDate.getTime() - now.getTime()) / 86400000),
          buyer: order.user,
        });
      } else if (!isAudited) {
        const retainedAmount = Math.round(netAmount * event.retentionRate);
        items.push({
          orderId: order.id,
          paymentId: payment.id,
          transactionId: payment.transactionId,
          type: 'VALOR_RETIDO',
          amount: netAmount,
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
    const totalValorRetido = items
      .filter((i) => i.type === 'VALOR_RETIDO')
      .reduce((s, i) => s + (i.retainedAmount ?? 0), 0);
    const totalAguardandoLiberacao = items
      .filter((i) => i.type === 'AGUARDANDO_LIBERACAO')
      .reduce((s, i) => s + i.amount, 0);

    const skip = (page - 1) * limit;
    return {
      message: 'Pending releases fetched successfully',
      data: {
        items: items.slice(skip, skip + limit),
        totalValorRetido,
        totalAguardandoLiberacao,
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
    const [event, audit, orders] = await Promise.all([
      this.loadEventConfig(eventId, prismaRead),
      this.loadAudit(eventId, prismaRead),
      this.loadPaidOrders(eventId, prismaRead),
    ]);

    const now = getNow();
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

      // Deduct organizer fee first, then split 10%/90%
      const netAmount = Math.round(order.finalAmount * (1 - event.organizerFeeRate));
      const retained = Math.round(netAmount * event.retentionRate);
      const distributable = netAmount - retained;
      const baseInstallment = Math.floor(distributable / count);
      const lastExtra = distributable - baseInstallment * count;

      for (let i = 0; i < count; i++) {
        const dueDate = addDays(paymentDate, 31 * (i + 1));
        const isLast = i === count - 1;
        const amount = baseInstallment + (isLast ? lastExtra : 0);

        if (dueDate > now) {
          items.push({
            id: `${payment.id}-installment-${i + 1}`,
            orderId: order.id,
            paymentId: payment.id,
            installmentNumber: i + 1,
            totalInstallments: count,
            amount,
            dueDate,
            isRetention: false,
            buyer: order.user,
          });
          totalPending += amount;
        }
      }

      // 10% retido: fica em parceladosAReceber até a auditoria
      if (!isAudited) {
        items.push({
          id: `${payment.id}-retention`,
          orderId: order.id,
          paymentId: payment.id,
          installmentNumber: null,
          totalInstallments: count,
          amount: retained,
          dueDate: null, // liberado na auditoria
          isRetention: true,
          buyer: order.user,
        });
        totalPending += retained;
      }
    }

    items.sort((a, b) => {
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    });

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

    // Aggregate both gross and net so callers can reconcile against saldoParaSaque (deducted at gross)
    const totalCompleted = await prismaRead.eventWithdrawal.aggregate({
      where: { eventId, status: WithdrawalStatus.COMPLETED },
      _sum: { amount: true, netAmount: true },
    });

    return {
      message: 'Withdrawals fetched successfully',
      data: {
        withdrawals,
        totalGrossWithdrawn: totalCompleted._sum.amount ?? 0,
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

    const [event, paidOrders, refundedOrders, audit, withdrawals] = await Promise.all([
      this.loadEventConfig(eventId, prismaRead),
      this.loadPaidOrders(eventId, prismaRead),
      this.loadRefundedOrders(eventId, prismaRead),
      this.loadAudit(eventId, prismaRead),
      this.loadWithdrawals(eventId, prismaRead),
    ]);

    // PENDING + COMPLETED both reduce saldoParaSaque to prevent double-spend
    const committedWithdrawals = withdrawals.filter(
      (w: any) => w.status === WithdrawalStatus.COMPLETED || w.status === WithdrawalStatus.PENDING,
    );

    const { saldoParaSaque } = this.calcBreakdown(
      paidOrders,
      refundedOrders,
      event.retentionRate,
      !!audit,
      committedWithdrawals,
      event.organizerFeeRate,
    );

    if (amount > saldoParaSaque) {
      throw new BadRequestException(
        `Insufficient available balance. Available: ${saldoParaSaque} cents, requested: ${amount} cents`,
      );
    }

    // Fee was already deducted upfront when distributing into buckets (spec step 3).
    // saldoParaSaque is already the net amount — no additional deduction at withdrawal.
    const withdrawal = await prismaWrite.eventWithdrawal.create({
      data: {
        eventId,
        requestedById: userId,
        amount,
        feeRate: event.organizerFeeRate,
        feeAmount: 0,
        netAmount: amount,
        status: WithdrawalStatus.PENDING,
      },
    });

    // Fire-and-forget: send transfer requested email to organizer
    this.loadEventWithOrg(eventId, prismaRead).then((evtOrg) => {
      if (!evtOrg?.organization?.email) return;
      const org = evtOrg.organization;
      const now = new Date();
      return this.emailService.sendTransferRequested({
        email: org.email,
        eventName: evtOrg.name,
        amount: this.formatBRL(withdrawal.netAmount),
        transferId: `REP-${withdrawal.id.split('-')[0].toUpperCase()}`,
        orgName: org.name ?? org.email,
        bankAccount: org.bankName && org.account ? `${org.bankName} ••• ${org.account.slice(-4)}` : '—',
        pixKey: org.pix ?? '—',
        requestDate: this.formatDateBR(now),
        sentDate: this.formatDateTimeBR(now),
      });
    }).catch((err) => this.logger.warn('Failed to send transfer requested email:', err));

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

    // Fire-and-forget: send transfer confirmed email to organizer
    this.loadEventWithOrg(eventId, prismaWrite).then((evtOrg) => {
      if (!evtOrg?.organization?.email) return;
      const org = evtOrg.organization;
      return this.emailService.sendTransferConfirmed({
        email: org.email,
        amount: this.formatBRL(updated.netAmount),
        transferId: `REP-${updated.id.split('-')[0].toUpperCase()}`,
        orgName: org.name ?? org.email,
        bankAccount: org.bankName && org.account ? `${org.bankName} ••• ${org.account.slice(-4)}` : '—',
        pixKey: org.pix ?? '—',
        requestDate: this.formatDateBR(withdrawal.createdAt),
        sentDate: this.formatDateTimeBR(updated.completedAt ?? new Date()),
        approvedDate: this.formatDateTimeBR(updated.completedAt ?? new Date()),
      });
    }).catch((err) => this.logger.warn('Failed to send transfer confirmed email:', err));

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

    const [event, paidOrders, refundedOrders, withdrawals] = await Promise.all([
      this.loadEventConfig(eventId, prismaRead),
      this.loadPaidOrders(eventId, prismaRead),
      this.loadRefundedOrders(eventId, prismaRead),
      this.loadWithdrawals(eventId, prismaRead),
    ]);

    const committedWithdrawals = withdrawals.filter(
      (w: any) => w.status === WithdrawalStatus.COMPLETED || w.status === WithdrawalStatus.PENDING,
    );

    const { valorRetido } = this.calcBreakdown(
      paidOrders,
      refundedOrders,
      event.retentionRate,
      false,
      committedWithdrawals,
      event.organizerFeeRate,
    );

    const audit = await prismaWrite.eventAudit.create({
      data: {
        eventId,
        auditedById: adminUserId,
        retentionReleased: valorRetido,
        notes: notes ?? null,
      },
    });

    return {
      message: 'Event audited successfully',
      data: { audit },
    };
  }
}
