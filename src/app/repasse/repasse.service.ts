import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrganizerMemberAccessService } from '../organizations/organizer-member-access.service';
import { EmailService } from '../../common/services/email.service';
import { PaymentsRefundService } from '../payments/payments-refund.service';
import { PaymentMethod, PaymentStatus, WithdrawalStatus } from '@prisma/client';
import { computeRefundImpact, resolveOrderOrganizerFeePercent } from '../../common/utils/refund.util';

// Prazo (dias) até que os 90% sejam liberados para saldo disponível.
//
// PIX e DÉBITO = 0: liquidam na hora na Cielo (não há janela de compensação a aguardar),
// então os 90% são liberados IMEDIATAMENTE após a confirmação/processamento do pagamento
// (releaseDate = paymentDate ≤ now → cai direto no branch "90% disponível + 10% retido").
// Os 10% continuam retidos aguardando auditoria — só a janela de espera deixa de existir.
// CRÉDITO (31d), BOLETO (3d) e CRYPTO (30d) mantêm a janela de compensação do método.
// Exportado como FONTE ÚNICA: EventsService.getFinancialPending reusa esta tabela
// (antes mantinha uma cópia divergente — PIX=1 e sem DEBIT_CARD → caía em 31 dias).
export const RETENTION_DAYS: Record<string, number> = {
  [PaymentMethod.PIX]: 0,
  [PaymentMethod.DEBIT_CARD]: 0,
  [PaymentMethod.CREDIT_CARD]: 31,
  [PaymentMethod.BOLETO]: 3,
  [PaymentMethod.CRYPTO]: 30,
};

// REFUND_FEE_RATE e computeRefundImpact agora vivem em common/utils/refund.util.ts
// (fonte única compartilhada com EventsService e PaymentsRefundService).

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

function buildRetentionWhere(search?: string, status?: 'pending' | 'released'): any {
  const where: any = {
    orders: { some: { payment: { status: 'PAID' } } },
  };
  if (status === 'pending') where.audit = { is: null };
  if (status === 'released') where.audit = { isNot: null };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { organization: { name: { contains: search, mode: 'insensitive' } } },
      { organization: { email: { contains: search, mode: 'insensitive' } } },
    ];
  }
  return where;
}

@Injectable()
export class RepasseService {
  private readonly logger = new Logger(RepasseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizerMemberAccess: OrganizerMemberAccessService,
    private readonly emailService: EmailService,
    private readonly refundService: PaymentsRefundService,
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
            // `pix` NÃO existe na Organization (só a relação `pixKeys`). Selecionar
            // campo inexistente fazia o Prisma lançar PrismaClientValidationError →
            // `loadEventWithOrg` rejeitava → `.then()` não rodava e NENHUM email de
            // repasse (solicitado/confirmado) era enviado. A chave PIX do e-mail vem
            // do `pixKeySnapshot` do saque via `resolvePixDestination`.
            bankName: true,
            account: true,
          },
        },
      },
    });
  }

  /**
   * Extrai os campos exibíveis (chave PIX + banco) priorizando o snapshot do
   * withdrawal. Se o snapshot não existir (registros legados pré-2026-05-11),
   * cai pra `organization.pix`/`bankName`/`account`. Centralizado para que
   * emails e payloads compartilhem a mesma fonte de verdade.
   */
  private resolvePixDestination(
    pixKeySnapshot: any,
    fallbackOrg: { pix?: string | null; bankName?: string | null; account?: string | null } | null | undefined,
  ): { pixKey: string; bankAccount: string } {
    const snap = pixKeySnapshot && typeof pixKeySnapshot === 'object' ? pixKeySnapshot : null;
    const pixKey = snap?.key ?? fallbackOrg?.pix ?? '—';
    const snapBank = snap?.bankName ?? null;
    if (snapBank) {
      // Conta corrente não é capturada no snapshot (PIX é só a chave) — usamos
      // o nome do banco isolado quando o snapshot tem chave mas não conta.
      return { pixKey, bankAccount: snapBank };
    }
    if (fallbackOrg?.bankName && fallbackOrg?.account) {
      return { pixKey, bankAccount: `${fallbackOrg.bankName} ••• ${fallbackOrg.account.slice(-4)}` };
    }
    return { pixKey, bankAccount: '—' };
  }

  // ─── Acesso ──────────────────────────────────────────────────────────────

  private async assertAccess(userId: string, eventId: string) {
    await this.organizerMemberAccess.assertCanAccessEvent(userId, eventId, 'financial');
  }

  private async assertAdminOrOwner(userId: string, eventId: string) {
    await this.organizerMemberAccess.assertCanAccessEvent(userId, eventId, 'financial');
  }

  // ─── Estorno (organizador c/ permissão financeira) ────────────────────────

  /**
   * Estorno TOTAL e imediato de um pedido pago, disparado pelo ORGANIZADOR.
   *
   * Reusa INTEGRALMENTE o engine do admin (`PaymentsRefundService.refundOrder`) — mesma
   * lógica de void na Cielo, REFUNDED, cancelamento de pedido/inscrições, reversão de
   * cupom/voucher, taxa de refund 2% e audit log; saldo pode ficar negativo (esperado).
   * Diferença vs admin: a permissão é `financial` sobre o evento (não AdminGuard) e validamos
   * que o pedido pertence ao evento da rota (organizador não estorna pedido de outro evento).
   * Só total e na hora — sem parcial nem agendamento.
   */
  async refundOrder(
    userId: string,
    eventId: string,
    orderId: string,
    dto: { reason: string; force?: boolean },
    ip?: string,
  ) {
    await this.assertAccess(userId, eventId);

    // O pedido precisa pertencer a ESTE evento — fecha IDOR (estornar pedido de outro evento).
    const order = await this.prisma.getReadClient().order.findUnique({
      where: { id: orderId },
      select: { eventId: true },
    });
    if (!order || order.eventId !== eventId) {
      throw new NotFoundException('Pedido não encontrado neste evento');
    }

    return this.refundService.refundOrder({
      orderId,
      adminUserId: userId, // actor do audit log = organizador
      reason: dto.reason,
      force: dto.force,
      ip,
    });
  }

  // ─── Dados base ──────────────────────────────────────────────────────────

  private async loadEventConfig(eventId: string, prisma: any) {
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, organizerFeePercent: true, retentionRate: true, refundFeeRate: true },
    });
    if (!event) throw new NotFoundException('Evento não encontrado');
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

  /**
   * Carrega pedidos PAID e REFUNDED em uma única query e particiona em memória.
   *
   * Por que: duas findMany separadas leem em snapshots diferentes — um pedido em
   * transição PAID→REFUNDED entre as queries pode aparecer em ambos ou em nenhum,
   * causando dupla contagem ou desaparecimento no breakdown. Uma única query elimina
   * essa janela de inconsistência.
   *
   * Inclui os mesmos campos que loadPaidOrders (incluindo `user` e `registrations`)
   * para que o resultado paid possa ser usado em getPendingReleases sem refetch.
   */
  private async loadPaidAndRefundedOrders(
    eventId: string,
    prisma: any,
  ): Promise<{ paidOrders: any[]; refundedOrders: any[] }> {
    const orders = await prisma.order.findMany({
      where: {
        eventId,
        payment: { status: { in: [PaymentStatus.PAID, PaymentStatus.REFUNDED] } },
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

    const paidOrders: any[] = [];
    const refundedOrders: any[] = [];
    for (const order of orders) {
      if (order.payment?.status === PaymentStatus.PAID) {
        paidOrders.push(order);
      } else if (order.payment?.status === PaymentStatus.REFUNDED) {
        refundedOrders.push(order);
      }
    }
    return { paidOrders, refundedOrders };
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
   *   parceladosAReceber  — parcelas futuras (orgNet/N). Parcelado NÃO retém 10%:
   *                         o total líquido é distribuído entre N parcelas e cada uma
   *                         migra para saldoDisponivel quando vence.
   *   saldoDisponivel     — montante já liberado; pode ser negativo em caso de estorno
   *
   * Estorno (todos os métodos — à vista, PIX, débito, parcelado):
   *   - O orgNet do pedido NÃO é subtraído aqui. Pedidos com payment REFUNDED não
   *     entram em `paidOrders`, então a contribuição positiva deles já sai do bucket
   *     de origem (aguardando / retido / saldo / parcelas). Subtrair de novo causaria
   *     dedução dupla (o organizador apareceria devendo valor que nunca recebeu).
   *   - Valor ainda preso (aguardando/parcelas): impacto ZERO no saldoDisponivel — o
   *     dinheiro apenas some do bucket onde estava, exatamente como manda a regra
   *     ("se ainda não recebeu, tira de aguardando liberação").
   *   - Valor já SACADO: o saque permanece em `totalWithdrawn` enquanto a receita
   *     correspondente some → `saldoParaSaque` fica negativo naturalmente
   *     ("se já sacou e não tem nada em aguardando, o saldo disponível fica negativo").
   *   - Única dedução explícita: TAXA DE REFUND (`REFUND_FEE_RATE`) sobre o subtotal
   *     (finalAmount − serviceFee), sempre do saldoDisponivel (pode ficar negativo).
   *
   * @param committedWithdrawals — COMPLETED + PENDING withdrawals (both reduce saldoParaSaque)
   */
  private calcBreakdown(
    paidOrders: any[],
    refundedOrders: any[],
    retentionRate: number,
    isAudited: boolean,
    committedWithdrawals: any[],
    organizerFeePercent: number,
    refundFeeRate: number,
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
      // A serviceFee (taxa do participante) é 100% da plataforma — sai antes da divisão.
      // Em cima do que sobrou (parte do organizador), aplicamos organizerFeePercent.
      const participantFeeAmount: number = order.serviceFee ?? 0;
      const organizerBase = Math.max(0, gross - participantFeeAmount);
      // Alíquota EFETIVA: snapshot do pagamento (order.organizerFeePercent) com fallback ao vivo.
      const effPercent = resolveOrderOrganizerFeePercent(order, organizerFeePercent);
      const orgNet = Math.round(organizerBase * (1 - effPercent / 100));
      const paymentDate = new Date(payment.paymentDate);
      const metadata = payment.metadata as any;

      if (isInstallment(metadata)) {
        // Parcelado não retém 10%: 100% do orgNet distribuído em N parcelas de 31 dias.
        // Cada parcela vencida vai pro saldoDisponivel; as futuras ficam em parceladosAReceber.
        const count: number = metadata.creditCard.installments;
        const baseInstallment = Math.floor(orgNet / count);
        const lastExtra = orgNet - baseInstallment * count;

        for (let i = 0; i < count; i++) {
          const dueDate = addDays(paymentDate, 31 * (i + 1));
          const amount = baseInstallment + (i === count - 1 ? lastExtra : 0);
          if (dueDate > now) {
            parceladosAReceber += amount;
          } else {
            saldoDisponivel += amount;
          }
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
    // Ver o JSDoc do método: o orgNet já foi revertido por exclusão dos REFUNDED de
    // `paidOrders`, e o negativo "por já ter sacado" vem de `totalWithdrawn`. A única
    // dedução explícita é a taxa de refund fixa sobre o subtotal — sai do saldo
    // disponível em qualquer método/auditoria (pode ficar negativo).
    for (const order of refundedOrders) {
      if (!order.payment) continue;
      // computeRefundImpact retorna refundFee = 0 para CHARGEBACK (reversão involuntária),
      // e o valor congelado (ou 2% do subtotal) para estorno proativo. Fonte única.
      saldoDisponivel -= computeRefundImpact(order, organizerFeePercent, refundFeeRate).refundFee;
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

  /**
   * Versão pública do breakdown sem verificação de acesso — usada por outros services
   * (ex.: EventsService.getFinancial) que já fizeram sua própria autenticação.
   * Garante que toda a UI financeira use a MESMA lógica (incluindo dedução priorizada
   * em estornos e recuperação de saldo negativo).
   */
  async computeBreakdownForEvent(eventId: string) {
    const prismaPrimary = this.prisma.getWriteClient();
    const [event, ordersResult, audit, withdrawals] = await Promise.all([
      this.loadEventConfig(eventId, prismaPrimary),
      this.loadPaidAndRefundedOrders(eventId, prismaPrimary),
      this.loadAudit(eventId, prismaPrimary),
      this.loadWithdrawals(eventId, prismaPrimary),
    ]);
    const { paidOrders, refundedOrders } = ordersResult;

    const committedWithdrawals = withdrawals.filter(
      (w: any) => w.status === WithdrawalStatus.COMPLETED || w.status === WithdrawalStatus.PENDING,
    );
    const completedWithdrawalsTotal = withdrawals
      .filter((w: any) => w.status === WithdrawalStatus.COMPLETED)
      .reduce((s: number, w: any) => s + (w.netAmount ?? w.amount ?? 0), 0);

    const breakdown = this.calcBreakdown(
      paidOrders,
      refundedOrders,
      event.retentionRate,
      !!audit,
      committedWithdrawals,
      event.organizerFeePercent,
      event.refundFeeRate,
    );

    return {
      breakdown,
      audit,
      paidOrders,
      refundedOrders,
      completedWithdrawalsTotal,
      organizerFeePercent: event.organizerFeePercent,
    };
  }

  async getSummary(userId: string, eventId: string) {
    await this.assertAccess(userId, eventId);

    // Usa primary client para evitar lag de replicação após confirmação de pagamento.
    // Dados financeiros precisam refletir o estado mais recente.
    const prismaPrimary = this.prisma.getWriteClient();
    const [event, ordersResult, audit, withdrawals] = await Promise.all([
      this.loadEventConfig(eventId, prismaPrimary),
      this.loadPaidAndRefundedOrders(eventId, prismaPrimary),
      this.loadAudit(eventId, prismaPrimary),
      this.loadWithdrawals(eventId, prismaPrimary),
    ]);
    const { paidOrders, refundedOrders } = ordersResult;

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
      event.organizerFeePercent,
      event.refundFeeRate,
    );

    // Transparência do estorno para o organizador: total revertido (venda perdida)
    // e total de taxa de refund debitada do saldo. Soma per-order (bate com o saldo).
    let refundOrgNetReverted = 0;
    let refundFeesTotal = 0;
    for (const o of refundedOrders) {
      const impact = computeRefundImpact(o, event.organizerFeePercent, event.refundFeeRate);
      refundOrgNetReverted += impact.organizerNetReversed;
      refundFeesTotal += impact.refundFee;
    }

    return {
      message: 'Repasse summary fetched successfully',
      data: {
        summary: {
          ...breakdown,
          pendingWithdrawalsAmount,
          refundedOrders: refundedOrders.length,
          refundOrgNetReverted,
          refundFeesTotal,
          isAudited: !!audit,
          auditedAt: audit?.createdAt ?? null,
          retentionReleased: audit?.retentionReleased ?? 0,
          organizerFeePercent: event.organizerFeePercent,
          retentionRate: event.retentionRate,
        },
      },
    };
  }

  async getPendingReleases(userId: string, eventId: string, page: number, limit: number) {
    await this.assertAccess(userId, eventId);

    // Primary client — financeiro precisa estar sempre atualizado
    const prismaPrimary = this.prisma.getWriteClient();
    const [event, orders, audit] = await Promise.all([
      this.loadEventConfig(eventId, prismaPrimary),
      this.loadPaidOrders(eventId, prismaPrimary),
      this.loadAudit(eventId, prismaPrimary),
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

      const organizerBase = Math.max(
        0,
        (order.finalAmount ?? 0) - (order.serviceFee ?? 0),
      );
      // Alíquota EFETIVA: snapshot do pagamento (order.organizerFeePercent) com fallback ao vivo.
      const netAmount = Math.round(
        organizerBase * (1 - resolveOrderOrganizerFeePercent(order, event.organizerFeePercent) / 100),
      );

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

    // Primary client — financeiro precisa estar sempre atualizado
    const prismaPrimary = this.prisma.getWriteClient();
    const [event, orders] = await Promise.all([
      this.loadEventConfig(eventId, prismaPrimary),
      this.loadPaidOrders(eventId, prismaPrimary),
    ]);

    const now = getNow();
    const items: any[] = [];
    let totalPending = 0;

    for (const order of orders) {
      const payment = order.payment;
      if (!payment?.paymentDate) continue;
      const metadata = payment.metadata as any;
      if (!isInstallment(metadata)) continue;

      const count: number = metadata.creditCard.installments;
      const paymentDate = new Date(payment.paymentDate);

      // serviceFee é 100% da plataforma, sai antes do split. Em cima do que sobra,
      // aplicamos organizerFeePercent. Parcelado NÃO retém 10%: o líquido é distribuído
      // integralmente entre as N parcelas (decisão de produto — apenas pedidos à vista
      // têm retenção de 10% aguardando auditoria).
      const organizerBase = Math.max(
        0,
        (order.finalAmount ?? 0) - (order.serviceFee ?? 0),
      );
      // Alíquota EFETIVA: snapshot do pagamento (order.organizerFeePercent) com fallback ao vivo.
      const netAmount = Math.round(
        organizerBase * (1 - resolveOrderOrganizerFeePercent(order, event.organizerFeePercent) / 100),
      );
      const baseInstallment = Math.floor(netAmount / count);
      const lastExtra = netAmount - baseInstallment * count;

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
          // Inclui dados atuais da chave selecionada (auxilia o admin a inspecionar)
          // — mas o snapshot persiste mesmo se a chave for excluída/editada.
          pixKey: {
            select: {
              id: true,
              key: true,
              keyType: true,
              isDefault: true,
              bankName: true,
              accountHolderName: true,
              accountHolderDocument: true,
            },
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

  async requestWithdrawal(userId: string, eventId: string, amount: number, pixKeyId: string) {
    await this.assertAccess(userId, eventId);

    if (!amount || amount <= 0) {
      throw new BadRequestException('O valor deve ser maior que zero');
    }

    const prismaWrite = this.prisma.getWriteClient();

    // Pré-valida a chave PIX (antes do lock — leitura barata) e captura snapshot
    // a partir da org do evento, garantindo que a chave realmente pertence a ela.
    const pixContext = await prismaWrite.event.findUnique({
      where: { id: eventId },
      select: {
        organizationId: true,
        organization: {
          select: {
            pixKeys: {
              where: { id: pixKeyId },
              select: {
                id: true,
                key: true,
                keyType: true,
                bankName: true,
                accountHolderName: true,
                accountHolderDocument: true,
              },
            },
          },
        },
      },
    });
    if (!pixContext) {
      throw new NotFoundException('Evento não encontrado');
    }
    const selectedKey = pixContext.organization?.pixKeys?.[0];
    if (!selectedKey) {
      // 400 e não 404 — input do usuário inválido (defense in depth contra IDOR).
      throw new BadRequestException(
        'Chave PIX inválida ou não pertence à organização deste evento',
      );
    }

    const pixKeySnapshot = {
      key: selectedKey.key,
      keyType: selectedKey.keyType,
      bankName: selectedKey.bankName ?? null,
      accountHolderName: selectedKey.accountHolderName ?? null,
      accountHolderDocument: selectedKey.accountHolderDocument ?? null,
    } as const;

    // Wrap check + create in a single transaction with an advisory lock so
    // concurrent withdrawal requests for the same event are serialized.
    const withdrawal = await prismaWrite.$transaction(async (tx) => {
      // $executeRaw em vez de $queryRaw: pg_advisory_xact_lock retorna `void`,
      // e o Prisma 6.18+ falha ao deserializar o resultset vazio. executeRaw
      // ignora o retorno e só serializa a contagem de linhas afetadas.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`;

      const [event, ordersResult, audit, withdrawals] = await Promise.all([
        this.loadEventConfig(eventId, tx),
        this.loadPaidAndRefundedOrders(eventId, tx),
        this.loadAudit(eventId, tx),
        this.loadWithdrawals(eventId, tx),
      ]);
      const { paidOrders, refundedOrders } = ordersResult;

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
        event.organizerFeePercent,
        event.refundFeeRate,
      );

      if (amount > saldoParaSaque) {
        throw new BadRequestException(
          `Insufficient available balance. Available: ${saldoParaSaque} cents, requested: ${amount} cents`,
        );
      }

      // Fee was already deducted upfront when distributing into buckets (spec step 3).
      // saldoParaSaque is already the net amount — no additional deduction at withdrawal.
      // EventWithdrawal.feeRate é histórico em escala 0-1 (ex.: 0.04). Convertemos do percent.
      return tx.eventWithdrawal.create({
        data: {
          eventId,
          requestedById: userId,
          amount,
          feeRate: event.organizerFeePercent / 100,
          feeAmount: 0,
          netAmount: amount,
          status: WithdrawalStatus.PENDING,
          pixKeyId: selectedKey.id,
          pixKeySnapshot,
        },
      });
    });

    // Fire-and-forget: send transfer requested email to organizer
    this.loadEventWithOrg(eventId, this.prisma.getReadClient()).then((evtOrg) => {
      if (!evtOrg?.organization?.email) return;
      const org = evtOrg.organization;
      const now = new Date();
      const { pixKey, bankAccount } = this.resolvePixDestination(pixKeySnapshot, org);
      return this.emailService.sendTransferRequested({
        email: org.email,
        eventName: evtOrg.name,
        amount: this.formatBRL(withdrawal.netAmount),
        transferId: `REP-${withdrawal.id.split('-')[0].toUpperCase()}`,
        orgName: org.name ?? org.email,
        bankAccount,
        pixKey,
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

    // Transição ATÔMICA: só completa se ainda PENDING. Evita TOCTOU (duplo-clique / dois
    // admins) que disparava dois e-mails e dupla sinalização de pagamento.
    const res = await prismaWrite.eventWithdrawal.updateMany({
      where: { id: withdrawalId, eventId, status: WithdrawalStatus.PENDING },
      data: { status: WithdrawalStatus.COMPLETED, completedAt: new Date() },
    });
    if (res.count === 0) {
      const existing = await prismaWrite.eventWithdrawal.findUnique({ where: { id: withdrawalId } });
      if (!existing || existing.eventId !== eventId) {
        throw new NotFoundException('Saque não encontrado');
      }
      throw new BadRequestException('Saque não está com status PENDENTE');
    }

    const updated = await prismaWrite.eventWithdrawal.findUnique({ where: { id: withdrawalId } });

    // Fire-and-forget: send transfer confirmed email to organizer (só roda quem venceu a transição)
    this.loadEventWithOrg(eventId, prismaWrite).then((evtOrg) => {
      if (!evtOrg?.organization?.email || !updated) return;
      const org = evtOrg.organization;
      const { pixKey, bankAccount } = this.resolvePixDestination(
        (updated as any).pixKeySnapshot,
        org,
      );
      return this.emailService.sendTransferConfirmed({
        email: org.email,
        amount: this.formatBRL(updated.netAmount),
        transferId: `REP-${updated.id.split('-')[0].toUpperCase()}`,
        orgName: org.name ?? org.email,
        bankAccount,
        pixKey,
        requestDate: this.formatDateBR(updated.createdAt),
        sentDate: this.formatDateTimeBR(updated.completedAt ?? new Date()),
        approvedDate: this.formatDateTimeBR(updated.completedAt ?? new Date()),
      });
    }).catch((err) => this.logger.warn('Failed to send transfer confirmed email:', err));

    return { message: 'Withdrawal completed successfully', data: { withdrawal: updated } };
  }

  async cancelWithdrawal(adminUserId: string, eventId: string, withdrawalId: string) {
    await this.assertAdminOrOwner(adminUserId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    // Transição ATÔMICA: só cancela se ainda PENDING (mesma proteção do complete).
    const res = await prismaWrite.eventWithdrawal.updateMany({
      where: { id: withdrawalId, eventId, status: WithdrawalStatus.PENDING },
      data: { status: WithdrawalStatus.CANCELLED },
    });
    if (res.count === 0) {
      const existing = await prismaWrite.eventWithdrawal.findUnique({ where: { id: withdrawalId } });
      if (!existing || existing.eventId !== eventId) {
        throw new NotFoundException('Saque não encontrado');
      }
      throw new BadRequestException('Somente saques pendentes podem ser cancelados');
    }

    const updated = await prismaWrite.eventWithdrawal.findUnique({ where: { id: withdrawalId } });

    return { message: 'Withdrawal cancelled', data: { withdrawal: updated } };
  }

  async getRefunded(userId: string, eventId: string, page: number, limit: number) {
    await this.assertAccess(userId, eventId);

    const prismaRead = this.prisma.getReadClient();
    const skip = (page - 1) * limit;
    const where = { eventId, payment: { status: PaymentStatus.REFUNDED } };

    const [event, orders, total, allRefunded] = await Promise.all([
      this.loadEventConfig(eventId, prismaRead),
      prismaRead.order.findMany({
        where,
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
      prismaRead.order.count({ where }),
      // Todos os estornos do evento (select leve) p/ totais EXATOS via computeRefundImpact
      // — chargeback-aware (fee=0) e batendo com getSummary. Estornos são raros vs. vendas.
      prismaRead.order.findMany({
        where,
        select: { finalAmount: true, serviceFee: true, organizerFeePercent: true, payment: { select: { metadata: true } } },
      }),
    ]);

    const items = orders.map((o: any) => {
      const impact = computeRefundImpact(o, event.organizerFeePercent, event.refundFeeRate);
      const meta = (o.payment?.metadata ?? {}) as any;
      return {
        orderId: o.id,
        paymentId: o.payment?.id,
        amount: o.finalAmount, // back-compat (== refundedToBuyer)
        refundedToBuyer: o.finalAmount, // devolvido integralmente ao comprador
        serviceFee: o.serviceFee ?? 0,
        organizerNetReversed: impact.organizerNetReversed, // o organizador deixa de receber
        refundFee: impact.refundFee, // 2% debitado do saldo disponível
        reason: meta.refundReason ?? null,
        paymentMethod: o.payment?.method,
        purchaseDate: o.createdAt,
        refundDate: o.payment?.updatedAt ?? o.payment?.paymentDate,
        buyer: o.user,
      };
    });

    // Totais do evento somados POR PEDIDO via computeRefundImpact (chargeback-aware) —
    // batem exatamente com a soma dos items e com o refundFeesTotal do getSummary.
    let totalRefundedToBuyer = 0;
    let totalOrganizerNetReversed = 0;
    let totalRefundFees = 0;
    for (const o of allRefunded) {
      totalRefundedToBuyer += o.finalAmount ?? 0;
      const impact = computeRefundImpact(o, event.organizerFeePercent, event.refundFeeRate);
      totalOrganizerNetReversed += impact.organizerNetReversed;
      totalRefundFees += impact.refundFee;
    }

    return {
      message: 'Refunded orders fetched successfully',
      data: {
        items,
        totalAmount: totalRefundedToBuyer, // back-compat (agora é do evento, não só da página)
        totalRefundedToBuyer,
        totalOrganizerNetReversed,
        totalRefundFees,
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

    const prismaWrite = this.prisma.getWriteClient();

    const audit = await prismaWrite.$transaction(async (tx) => {
      // Check and create within the same transaction to prevent duplicate audits
      const existing = await this.loadAudit(eventId, tx);
      if (existing) throw new BadRequestException('Evento já foi auditado');

      const [event, ordersResult, withdrawals] = await Promise.all([
        this.loadEventConfig(eventId, tx),
        this.loadPaidAndRefundedOrders(eventId, tx),
        this.loadWithdrawals(eventId, tx),
      ]);
      const { paidOrders, refundedOrders } = ordersResult;

      const committedWithdrawals = withdrawals.filter(
        (w: any) => w.status === WithdrawalStatus.COMPLETED || w.status === WithdrawalStatus.PENDING,
      );

      const { valorRetido } = this.calcBreakdown(
        paidOrders,
        refundedOrders,
        event.retentionRate,
        false,
        committedWithdrawals,
        event.organizerFeePercent,
        event.refundFeeRate,
      );

      return tx.eventAudit.create({
        data: {
          eventId,
          auditedById: adminUserId,
          retentionReleased: valorRetido,
          notes: notes ?? null,
        },
      });
    });

    return {
      message: 'Event audited successfully',
      data: { audit },
    };
  }

  // ─── Admin: global retention management ─────────────────────────────────

  async adminGetEventsWithRetention(
    page: number,
    limit: number,
    search?: string,
    status?: 'pending' | 'released',
  ) {
    const prismaRead = this.prisma.getReadClient();

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Fetch events + monthly stats in parallel
    const [monthlyAuditAgg, eventsRaw] = await Promise.all([
      prismaRead.eventAudit.aggregate({
        where: { createdAt: { gte: startOfMonth } },
        _sum: { retentionReleased: true },
      }),
      prismaRead.event.findMany({
        where: buildRetentionWhere(search, status),
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          eventDate: true,
          organizerFeePercent: true,
          retentionRate: true,
          refundFeeRate: true,
          organization: {
            select: { id: true, name: true, email: true, logoUrl: true },
          },
          audit: {
            select: {
              id: true,
              retentionReleased: true,
              notes: true,
              createdAt: true,
              auditedBy: {
                select: { id: true, firstName: true, lastName: true, email: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const allResults: any[] = [];

    for (const event of eventsRaw) {
      if (event.audit) {
        // Released: use the stored value — no need to recalculate
        allResults.push({
          id: event.id,
          name: event.name,
          slug: event.slug,
          logoUrl: event.logoUrl,
          eventDate: event.eventDate,
          retentionRate: event.retentionRate,
          organization: event.organization,
          status: 'released' as const,
          retainedAmount: event.audit.retentionReleased,
          grossRevenue: null,
          releasedAt: event.audit.createdAt,
          releasedBy: event.audit.auditedBy,
          auditNotes: event.audit.notes,
        });
      } else {
        // Pending: calculate current retained amount dynamically
        const [ordersResult, withdrawals] = await Promise.all([
          this.loadPaidAndRefundedOrders(event.id, prismaRead),
          this.loadWithdrawals(event.id, prismaRead),
        ]);
        const { paidOrders, refundedOrders } = ordersResult;

        const committedWithdrawals = withdrawals.filter(
          (w: any) => w.status === WithdrawalStatus.COMPLETED || w.status === WithdrawalStatus.PENDING,
        );

        const { valorRetido: retainedAmount, grossRevenue } = this.calcBreakdown(
          paidOrders,
          refundedOrders,
          event.retentionRate,
          false,
          committedWithdrawals,
          event.organizerFeePercent,
          event.refundFeeRate,
        );

        if (retainedAmount > 0) {
          allResults.push({
            id: event.id,
            name: event.name,
            slug: event.slug,
            logoUrl: event.logoUrl,
            eventDate: event.eventDate,
            retentionRate: event.retentionRate,
            organization: event.organization,
            status: 'pending' as const,
            retainedAmount,
            grossRevenue,
            releasedAt: null,
            releasedBy: null,
            auditNotes: null,
          });
        }
      }
    }

    // Stats always reflect global state (pending events from allResults)
    const pendingResults = allResults.filter((e) => e.status === 'pending');
    const pendingCount = pendingResults.length;
    const totalPendingVolume = pendingResults.reduce((s, e) => s + e.retainedAmount, 0);

    const total = allResults.length;
    const skip = (page - 1) * limit;

    return {
      message: 'Events with retention fetched successfully',
      data: {
        stats: {
          pendingCount,
          totalPendingVolume,
          totalProcessedThisMonth: monthlyAuditAgg._sum.retentionReleased ?? 0,
        },
        events: allResults.slice(skip, skip + limit),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  async adminReleaseRetention(adminUserId: string, eventId: string, notes?: string) {
    const prismaWrite = this.prisma.getWriteClient();

    const { audit, retainedAmount } = await prismaWrite.$transaction(async (tx) => {
      // Check and create within the same transaction to prevent duplicate releases
      const existing = await this.loadAudit(eventId, tx);
      if (existing) throw new BadRequestException('Retenção do evento já foi liberada');

      const [event, ordersResult, withdrawals] = await Promise.all([
        this.loadEventConfig(eventId, tx),
        this.loadPaidAndRefundedOrders(eventId, tx),
        this.loadWithdrawals(eventId, tx),
      ]);
      const { paidOrders, refundedOrders } = ordersResult;

      const committedWithdrawals = withdrawals.filter(
        (w: any) => w.status === WithdrawalStatus.COMPLETED || w.status === WithdrawalStatus.PENDING,
      );

      const { valorRetido } = this.calcBreakdown(
        paidOrders,
        refundedOrders,
        event.retentionRate,
        false,
        committedWithdrawals,
        event.organizerFeePercent,
        event.refundFeeRate,
      );

      const created = await tx.eventAudit.create({
        data: {
          eventId,
          auditedById: adminUserId,
          retentionReleased: valorRetido,
          notes: notes ?? null,
        },
      });

      return { audit: created, retainedAmount: valorRetido };
    });

    this.logger.log(`Retention released for event ${eventId}: ${retainedAmount} cents by admin ${adminUserId}`);

    return {
      message: 'Retention released successfully',
      data: { audit, retentionReleased: retainedAmount },
    };
  }
}
