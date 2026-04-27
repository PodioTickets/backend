import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WithdrawalStatus } from '@prisma/client';

@Injectable()
export class AdminRepasseService {
  constructor(private readonly prisma: PrismaService) {}

  async getWithdrawals(params: {
    page: number;
    limit: number;
    status?: WithdrawalStatus;
    eventId?: string;
    search?: string;
  }) {
    const { page, limit, status, eventId, search } = params;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (eventId) where.eventId = eventId;
    if (search) {
      where.OR = [
        { event: { name: { contains: search, mode: 'insensitive' } } },
        { requestedBy: { firstName: { contains: search, mode: 'insensitive' } } },
        { requestedBy: { lastName: { contains: search, mode: 'insensitive' } } },
        { requestedBy: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const prismaRead = this.prisma.getReadClient();

    const [withdrawals, total] = await Promise.all([
      prismaRead.eventWithdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          event: {
            select: {
              id: true,
              name: true,
              slug: true,
              organizationId: true,
              organization: { select: { id: true, name: true } },
            },
          },
          requestedBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
      }),
      prismaRead.eventWithdrawal.count({ where }),
    ]);

    return {
      message: 'Withdrawals fetched successfully',
      data: {
        withdrawals,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  async getStats() {
    const prismaRead = this.prisma.getReadClient();

    const [byStatus, feeAgg, totalEvents] = await Promise.all([
      // Agrega count + somas por status em uma única query
      prismaRead.eventWithdrawal.groupBy({
        by: ['status'],
        _count: { id: true },
        _sum: { amount: true, netAmount: true, feeAmount: true },
      }),
      // Taxa total arrecadada em withdrawals COMPLETED
      prismaRead.eventWithdrawal.aggregate({
        where: { status: WithdrawalStatus.COMPLETED },
        _sum: { feeAmount: true, amount: true },
        _avg: { feeRate: true },
        _count: { id: true },
      }),
      // Quantidade distinta de eventos com ao menos um repasse
      prismaRead.eventWithdrawal.findMany({
        select: { eventId: true },
        distinct: ['eventId'],
      }),
    ]);

    const statsMap: Record<string, any> = {};
    for (const row of byStatus) {
      statsMap[row.status] = {
        count: row._count.id,
        totalAmount: row._sum.amount ?? 0,
        totalNetAmount: row._sum.netAmount ?? 0,
        totalFeeAmount: row._sum.feeAmount ?? 0,
      };
    }

    const pending = statsMap[WithdrawalStatus.PENDING] ?? { count: 0, totalAmount: 0, totalNetAmount: 0, totalFeeAmount: 0 };
    const completed = statsMap[WithdrawalStatus.COMPLETED] ?? { count: 0, totalAmount: 0, totalNetAmount: 0, totalFeeAmount: 0 };
    const cancelled = statsMap[WithdrawalStatus.CANCELLED] ?? { count: 0, totalAmount: 0, totalNetAmount: 0, totalFeeAmount: 0 };

    const totalGrossCompleted = feeAgg._sum.amount ?? 0;
    const totalFeeCollected = feeAgg._sum.feeAmount ?? 0;
    const avgFeeRate = feeAgg._avg.feeRate ?? 0;
    // Percentual efetivo: taxa total sobre bruto total dos repasses concluídos
    const effectiveFeePercent = totalGrossCompleted > 0
      ? (totalFeeCollected / totalGrossCompleted) * 100
      : 0;

    return {
      message: 'Withdrawal stats fetched successfully',
      data: {
        pending: {
          count: pending.count,
          totalAmount: pending.totalAmount,
          totalNetAmount: pending.totalNetAmount,
        },
        completed: {
          count: completed.count,
          totalAmount: completed.totalAmount,
          totalNetAmount: completed.totalNetAmount,
        },
        cancelled: {
          count: cancelled.count,
          totalAmount: cancelled.totalAmount,
          totalNetAmount: cancelled.totalNetAmount,
        },
        fees: {
          totalCollected: totalFeeCollected,
          avgFeeRate: Math.round(avgFeeRate * 10000) / 10000,
          effectiveFeePercent: Math.round(effectiveFeePercent * 100) / 100,
        },
        overview: {
          totalEventsWithWithdrawals: totalEvents.length,
          totalWithdrawals: pending.count + completed.count + cancelled.count,
          totalGrossRequested: pending.totalAmount + completed.totalAmount + cancelled.totalAmount,
        },
      },
    };
  }
}
